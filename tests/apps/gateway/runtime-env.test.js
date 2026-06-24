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
  assert.equal(env.SLACK_AGENT_MERGE_SUMMARY_URL, 'http://slack-agent:8791/internal/slack-agent/merge-summary');
  assert.equal(env.SLACK_AGENT_SHARED_SECRET, 'agent-secret');
  assert.equal(env.SLACK_NOTIFIER_URL, 'http://slack-notifier:8792');
});
