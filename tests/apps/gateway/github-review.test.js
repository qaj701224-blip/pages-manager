import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyReviewAgentComment,
  isAllowedPlatformCiRun,
  isAllowedReviewAgent,
  isAllowedSiteCheckRun,
  normalizeReviewAgentWebhook,
  normalizeSiteCheckRunWebhook,
  reviewAgentLogins,
} from '../../../apps/gateway/src/github/review.js';

test('review agent allowlist supports csv and json metadata', () => {
  assert.equal(reviewAgentLogins({}).has('greptile[bot]'), true);
  assert.equal(reviewAgentLogins({}).has('chatgpt-codex-connector'), true);
  assert.equal(reviewAgentLogins({}).has('chatgpt-codex-connector[bot]'), true);
  assert.equal(
    isAllowedReviewAgent(
      { reviewAgentLogin: 'custom-reviewer[bot]' },
      {
        GITHUB_REVIEW_AGENT_LOGINS: 'custom-reviewer[bot]',
      }
    ),
    true
  );
  assert.equal(
    isAllowedReviewAgent(
      { reviewAgentLogin: 'copilot-pull-request-reviewer[bot]' },
      {
        GITHUB_REVIEW_AGENT_LOGINS: 'greptile[bot] copilot-pull-request-reviewer[bot]',
      }
    ),
    true
  );
  assert.equal(
    isAllowedReviewAgent(
      { reviewAgentLogin: 'greptile-enterprise[bot]' },
      {
        GITHUB_REVIEW_AGENT_ALLOWLIST: JSON.stringify([
          {
            provider: 'greptile',
            botLogins: ['greptile-enterprise[bot]'],
            enabled: true,
          },
        ]),
      }
    ),
    true
  );
});

test('classifies review agent comments conservatively', () => {
  assert.equal(classifyReviewAgentComment({ reviewState: 'changes_requested', body: 'Looks close' }), 'blocking');
  assert.equal(classifyReviewAgentComment({ body: 'Must fix this failing check.' }), 'blocking');
  assert.equal(classifyReviewAgentComment({ body: 'Not approved: tests failed.' }), 'blocking');
  assert.equal(classifyReviewAgentComment({ body: '没有通过，失败。' }), 'blocking');
  assert.equal(
    classifyReviewAgentComment({
      body: '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-red?style=flat)</sub></sub> Security issue**',
    }),
    'blocking'
  );
  assert.equal(
    classifyReviewAgentComment({
      body: '**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Limit contact row styles**',
    }),
    'suggestion'
  );
  assert.equal(
    classifyReviewAgentComment({
      body: '**<sub><sub>![P3 Badge](https://img.shields.io/badge/P3-blue?style=flat)</sub></sub> Optional polish**',
    }),
    'suggestion'
  );
  assert.equal(classifyReviewAgentComment({ body: 'Here are some automated review suggestions.' }), 'suggestion');
  assert.equal(classifyReviewAgentComment({ body: '建议优化一下视觉层级。' }), 'suggestion');
  assert.equal(classifyReviewAgentComment({ reviewState: 'approved', body: 'LGTM' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: "Didn't find any major issues." }), 'note');
  assert.equal(classifyReviewAgentComment({ body: 'No blocking issues found. Site check passed.' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: 'No action required.' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: 'No errors found.' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: '0 failed tests.' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: '0 errors found.' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: 'All checks passed: 0 failed, 0 errors.' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: 'Required checks passed.' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: '无阻塞，检查通过。' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: '1 failed test.' }), 'blocking');
  assert.equal(classifyReviewAgentComment({ body: 'All checks completed: 1 failed test, 0 errors.' }), 'blocking');
  assert.equal(classifyReviewAgentComment({ body: '2 errors found.' }), 'blocking');
  assert.equal(classifyReviewAgentComment({ body: 'Please inspect this custom output.' }), 'unknown');
});

test('normalizes pull request review comments', () => {
  const normalized = normalizeReviewAgentWebhook(
    {
      action: 'created',
      repository: { full_name: 'org/pages-manager' },
      pull_request: { number: 12, head: { sha: 'a'.repeat(40) } },
      comment: {
        id: 99,
        node_id: 'PRRC_99',
        body: 'Must fix the broken markup.',
        path: 'sites/smoke/profile/src/index.html',
        line: 12,
        user: { login: 'greptile[bot]' },
      },
    },
    'pull_request_review_comment',
    'delivery_1',
    'org/pages-manager'
  );

  assert.equal(normalized.prNumber, 12);
  assert.equal(normalized.sourceType, 'inline_comment');
  assert.equal(normalized.githubCommentNodeId, 'PRRC_99');
  assert.equal(normalized.classification, 'blocking');
  assert.equal(normalized.headSha, 'a'.repeat(40));
});

test('ignores issue comments that are not on pull requests', () => {
  assert.equal(
    normalizeReviewAgentWebhook(
      {
        action: 'created',
        issue: { number: 1 },
        comment: { id: 1, body: 'hello', user: { login: 'greptile[bot]' } },
      },
      'issue_comment',
      'delivery_2',
      'org/pages-manager'
    ),
    null
  );
});

test('normalizes and allowlists site-check check_run events', () => {
  const normalized = normalizeSiteCheckRunWebhook(
    {
      action: 'completed',
      check_run: {
        id: 7001,
        node_id: 'SCR_7001',
        name: 'site-check',
        status: 'completed',
        conclusion: 'success',
        head_sha: 'b'.repeat(40),
        details_url: 'https://github.example/org/pages-manager/actions/runs/7001',
        app: { slug: 'github-actions', name: 'GitHub Actions' },
        output: {
          title: 'site-check passed',
          summary: 'Allowed path only.',
        },
        pull_requests: [{ number: 16 }],
      },
    },
    'check_run',
    'delivery-site-check',
    'org/pages-manager'
  );

  assert.equal(normalized.prNumber, 16);
  assert.equal(normalized.checkRunNodeId, 'SCR_7001');
  assert.equal(normalized.headSha, 'b'.repeat(40));
  assert.match(normalized.outputSummary, /Allowed path only/);
  assert.equal(isAllowedSiteCheckRun(normalized), true);
});

test('site-check allowlist requires both trusted check name and app', () => {
  const run = {
    checkName: 'site-check',
    appSlug: 'random-ci',
    appName: 'Random CI',
  };

  assert.equal(isAllowedSiteCheckRun(run), false);
  assert.equal(
    isAllowedSiteCheckRun(run, {
      GITHUB_SITE_CHECK_APP_LOGINS: 'random-ci',
    }),
    true
  );
  assert.equal(
    isAllowedSiteCheckRun(
      {
        checkName: 'site-check',
        appSlug: 'github-actions',
        appName: 'GitHub Actions',
      },
      {
        GITHUB_SITE_CHECK_APP_LOGINS: 'GitHub Actions',
      }
    ),
    true
  );
  assert.equal(
    isAllowedSiteCheckRun(
      {
        checkName: 'Site Check / site-check',
        appSlug: 'github-actions',
        appName: 'GitHub Actions',
      },
      {
        GITHUB_SITE_CHECK_NAMES: 'Site Check / site-check',
      }
    ),
    true
  );
  assert.equal(
    isAllowedSiteCheckRun(
      {
        checkName: 'lint',
        appSlug: 'github-actions',
        appName: 'GitHub Actions',
      },
      {
        GITHUB_SITE_CHECK_NAMES: 'site-check',
      }
    ),
    false
  );
});

test('platform CI is allowlisted separately from site-check', () => {
  const platformRun = {
    checkName: 'Platform CI',
    appSlug: 'github-actions',
    appName: 'GitHub Actions',
  };

  assert.equal(isAllowedSiteCheckRun(platformRun), false);
  assert.equal(isAllowedPlatformCiRun(platformRun), true);
  assert.equal(
    isAllowedPlatformCiRun({
      ...platformRun,
      checkName: 'check',
    }),
    true
  );
  assert.equal(
    isAllowedPlatformCiRun(platformRun, {
      GITHUB_PLATFORM_CI_CHECK_NAMES: 'Platform CI',
    }),
    true
  );
  assert.equal(
    isAllowedPlatformCiRun(platformRun, {
      GITHUB_SITE_CHECK_APP_LOGINS: 'dedicated-site-check',
    }),
    true
  );
  assert.equal(
    isAllowedPlatformCiRun(platformRun, {
      GITHUB_PLATFORM_CI_APP_LOGINS: 'GitHub Actions',
    }),
    true
  );
  assert.equal(
    isAllowedPlatformCiRun(platformRun, {
      GITHUB_PLATFORM_CI_APP_LOGINS: 'dedicated-platform-ci',
    }),
    false
  );
});
