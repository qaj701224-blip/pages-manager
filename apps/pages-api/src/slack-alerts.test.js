import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCapacityExhaustedPayload, buildS2SAnomalyPayload } from './slack-alerts.js';

test('capacity alert mentions owner once and points legacy slots back to WFP', () => {
  const payload = buildCapacityExhaustedPayload({
    environment: 'staging',
    mentionUserId: 'UTESTMEMBER',
    currentCapacity: { used: 8, total: 10, available: 2 },
    expandBy: 2,
  });

  const serialized = JSON.stringify(payload);
  assert.equal(payload.text, 'Legacy Worker 池容量不足，需要迁移到 WFP');
  assert.equal((serialized.match(/<@UTESTMEMBER>/g) || []).length, 1);
  assert.equal(payload.blocks[0].text.text, 'Legacy Worker 池容量不足');
  assert.equal(
    payload.blocks[1].text.text,
    '<@UTESTMEMBER> *XD Cell legacy Worker 池不可用，请确认新发布走 WFP 并迁移存量站点。*'
  );
  assert.deepEqual(payload.blocks[2].fields, [
    { type: 'mrkdwn', text: '*环境*\nstaging' },
    { type: 'mrkdwn', text: '*容量*\n已用 8 / 总计 10' },
    { type: 'mrkdwn', text: '*剩余*\n2' },
    { type: 'mrkdwn', text: '*建议*\n迁移/重发到 WFP' },
  ]);
  assert.match(serialized, /https:\/\/github\.com\/xindong\/pages-manager\/actions/);
  assert.doesNotMatch(serialized, /Deployment|Site|dep_|site_/);
});

test('S2S anomaly alert contains identifiers but no user identity or credentials', () => {
  const payload = buildS2SAnomalyPayload({
    environment: 'staging',
    clientId: 'xdmaker',
    userId: 'usr_1',
    accessKeyId: 'ak_1',
    reason: 'rate_threshold',
  });
  const serialized = JSON.stringify(payload);
  assert.match(serialized, /staging/);
  assert.match(serialized, /rate_threshold/);
  assert.doesNotMatch(serialized, /user@example|ou_|xdp_|signature|nonce/i);
});
