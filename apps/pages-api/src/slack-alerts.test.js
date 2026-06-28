import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCapacityExhaustedPayload } from './slack-alerts.js';

test('capacity alert mentions owner once and shows only environment capacity and expansion', () => {
  const payload = buildCapacityExhaustedPayload({
    environment: 'staging',
    mentionUserId: 'UTESTMEMBER',
    currentCapacity: { used: 8, total: 10, available: 2 },
    expandBy: 2,
  });

  const serialized = JSON.stringify(payload);
  assert.equal(payload.text, '静态页面池容量不足，需要扩容');
  assert.equal((serialized.match(/<@UTESTMEMBER>/g) || []).length, 1);
  assert.equal(payload.blocks[0].text.text, '静态页面池容量不足');
  assert.equal(payload.blocks[1].text.text, '<@UTESTMEMBER> *XD Cell Worker 池数量不足，请检查资源池容量。*');
  assert.deepEqual(payload.blocks[2].fields, [
    { type: 'mrkdwn', text: '*环境*\nstaging' },
    { type: 'mrkdwn', text: '*容量*\n已用 8 / 总计 10' },
    { type: 'mrkdwn', text: '*剩余*\n2' },
    { type: 'mrkdwn', text: '*扩容*\n+2' },
  ]);
  assert.match(serialized, /https:\/\/github\.com\/xindong\/pages-manager\/actions/);
  assert.doesNotMatch(serialized, /Deployment|Site|dep_|site_/);
});
