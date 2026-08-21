import assert from 'node:assert/strict';
import test from 'node:test';

import { createSuccessfulRollbackFinalization } from './finalize-successful-rollback.js';

const deployment = { id: 'dep_1', operation: 'rollback', status: 'activating' };
const completed = { ...deployment, status: 'succeeded', versionId: 'ver_1' };
const version = { id: 'ver_1' };
const previousRoute = { activeVersionId: 'ver_2' };

test('successful rollback finalization persists before recording the skipped webhook', async () => {
  const calls = [];
  const application = createSuccessfulRollbackFinalization({
    completion: {
      async complete(input) {
        calls.push(['complete', input]);
        return completed;
      },
    },
    telemetry: {
      async webhookSkipped() {
        calls.push(['webhookSkipped']);
      },
    },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.equal(await application.finalize({ deployment, version, previousRoute }), completed);
  assert.deepEqual(calls, [
    [
      'complete',
      {
        deployment,
        versionId: 'ver_1',
        previousVersionId: 'ver_2',
        completedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
    ['webhookSkipped'],
  ]);
});

test('successful rollback finalization requires its narrow capabilities', () => {
  assert.throws(
    () => createSuccessfulRollbackFinalization({ completion: {}, telemetry: {}, clock: {} }),
    /completion\.complete is required/
  );
  assert.throws(
    () =>
      createSuccessfulRollbackFinalization({
        completion: { complete() {} },
        telemetry: {},
        clock: { now() {} },
      }),
    /telemetry\.webhookSkipped is required/
  );
});
