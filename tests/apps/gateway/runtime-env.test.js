import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGatewayEnv } from '../../../apps/gateway/src/runtime-env.js';

test('gateway runtime env includes merge announcement settings for ECS dev server', () => {
  const env = buildGatewayEnv({
    GITHUB_REPO: 'xindong/pages-manager',
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C0BA6713S0L',
    MERGE_ANNOUNCEMENT_BASE_REFS: 'master,staging,feat/slack-preview-gateway',
    MERGE_ANNOUNCEMENT_AGENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_INCLUDE_SITE_PRS: 'false',
    MERGE_ANNOUNCEMENT_MENTION_USER_IDS: 'U123,U456',
    PAGES_PLATFORM_GATE_APPROVERS: 'alice,bob',
    PAGES_PLATFORM_GATE_APPROVER_IDS: 'UAPPROVER1,UAPPROVER2',
    GITHUB_SITE_CHECK_NAMES: 'custom-site-check',
    GITHUB_SITE_CHECK_APP_LOGINS: 'custom-site-app',
    GITHUB_PLATFORM_CI_CHECK_NAMES: 'custom-platform-ci',
    GITHUB_PLATFORM_CI_APP_LOGINS: 'custom-platform-app',
    SLACK_AGENT_MERGE_SUMMARY_URL: 'http://slack-agent:8791/internal/slack-agent/merge-summary',
    SLACK_AGENT_SHARED_SECRET: 'agent-secret',
    SLACK_NOTIFIER_URL: 'http://slack-notifier:8792',
  });

  assert.equal(env.GITHUB_REPO, 'xindong/pages-manager');
  assert.equal(env.MERGE_ANNOUNCEMENT_ENABLED, 'true');
  assert.equal(env.MERGE_ANNOUNCEMENT_CHANNEL_ID, 'C0BA6713S0L');
  assert.equal(env.MERGE_ANNOUNCEMENT_BASE_REFS, 'master,staging,feat/slack-preview-gateway');
  assert.equal(env.MERGE_ANNOUNCEMENT_AGENT_ENABLED, 'true');
  assert.equal(env.MERGE_ANNOUNCEMENT_INCLUDE_SITE_PRS, 'false');
  assert.equal(env.MERGE_ANNOUNCEMENT_MENTION_USER_IDS, 'U123,U456');
  assert.equal(env.PAGES_PLATFORM_GATE_APPROVERS, 'alice,bob');
  assert.equal(env.PAGES_PLATFORM_GATE_APPROVER_IDS, 'UAPPROVER1,UAPPROVER2');
  assert.equal(env.GITHUB_SITE_CHECK_NAMES, 'custom-site-check');
  assert.equal(env.GITHUB_SITE_CHECK_APP_LOGINS, 'custom-site-app');
  assert.equal(env.GITHUB_PLATFORM_CI_CHECK_NAMES, 'custom-platform-ci');
  assert.equal(env.GITHUB_PLATFORM_CI_APP_LOGINS, 'custom-platform-app');
  assert.equal(env.SLACK_AGENT_MERGE_SUMMARY_URL, 'http://slack-agent:8791/internal/slack-agent/merge-summary');
  assert.equal(env.SLACK_AGENT_SHARED_SECRET, 'agent-secret');
  assert.equal(env.SLACK_NOTIFIER_URL, 'http://slack-notifier:8792');
});
