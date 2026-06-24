import assert from 'node:assert/strict';
import test from 'node:test';

import { startWorkerForJobIfConfigured } from '../../../apps/gateway/src/publishing/worker-dispatcher.js';

test('worker dispatcher ignores missing site jobs', async () => {
  let called = false;
  const result = await startWorkerForJobIfConfigured(null, {
    PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
    async WORKER_FETCH() {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  assert.equal(result, null);
  assert.equal(called, false);
});
