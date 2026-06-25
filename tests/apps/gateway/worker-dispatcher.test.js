import assert from 'node:assert/strict';
import test from 'node:test';

import {
  startWorkerForJobIfConfigured,
  startWorkerForPlatformDevItemIfConfigured,
} from '../../../apps/gateway/src/publishing/worker-dispatcher.js';

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

test('worker dispatcher returns site job start failure when fetch rejects', async () => {
  const result = await startWorkerForJobIfConfigured(
    {
      id: 'job_fetch_reject',
      status: 'received',
    },
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH() {
        throw new Error('connection reset');
      },
    }
  );

  assert.equal(result.started, false);
  assert.equal(result.error, 'connection reset');
});

test('worker dispatcher returns platform item start failure when fetch rejects', async () => {
  const result = await startWorkerForPlatformDevItemIfConfigured(
    {
      id: 'pdev_fetch_reject',
      status: 'received',
      agentEligible: true,
      requiresHumanGate: false,
    },
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH() {
        throw new Error('dns unavailable');
      },
    }
  );

  assert.equal(result.started, false);
  assert.equal(result.error, 'dns unavailable');
});
