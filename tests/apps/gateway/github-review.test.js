import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyReviewAgentComment,
  isAllowedReviewAgent,
  normalizeReviewAgentWebhook,
  reviewAgentLogins,
} from '../../../apps/gateway/src/github-review.js';

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
  assert.equal(classifyReviewAgentComment({ body: 'Here are some automated review suggestions.' }), 'suggestion');
  assert.equal(classifyReviewAgentComment({ body: '建议优化一下视觉层级。' }), 'suggestion');
  assert.equal(classifyReviewAgentComment({ reviewState: 'approved', body: 'LGTM' }), 'note');
  assert.equal(classifyReviewAgentComment({ body: "Didn't find any major issues." }), 'note');
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
