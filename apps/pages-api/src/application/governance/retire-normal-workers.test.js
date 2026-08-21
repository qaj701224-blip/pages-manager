import assert from 'node:assert/strict';
import test from 'node:test';

import { createNormalWorkerRetirement } from './retire-normal-workers.js';

test('normal worker retirement deletes from Cloudflare before retiring D1 state', async () => {
  const calls = [];
  const application = createApplication({
    records: [worker()],
    deleteWorker: async (input) => calls.push(['delete', input]),
    retire: async (input) => {
      calls.push(['retire', input]);
      return worker({ status: 'retired' });
    },
  });

  const result = await application.retire(command());

  assert.equal(result.status, 'retired');
  assert.equal(result.worker.status, 'retired');
  assert.deepEqual(calls, [
    ['delete', { workerName: 'pages-v2-production-slot-001' }],
    [
      'retire',
      {
        id: 'slot_1',
        environment: 'production',
        actorUserId: 'usr_admin',
        reason: 'legacy drain',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
  ]);
});

test('normal worker retirement rejects active and missing workers before provider deletion', async () => {
  let deletes = 0;
  const application = createApplication({
    records: [worker({ activeRoute: { siteId: 'site_1' } })],
    deleteWorker: async () => {
      deletes += 1;
    },
  });

  const active = await application.retire(command());
  const missing = await application.retire(command({ id: 'slot_missing' }));

  assert.equal(active.errorCode, 'NORMAL_WORKER_ACTIVE');
  assert.equal(active.worker.lifecycle, 'active');
  assert.deepEqual(missing, {
    id: 'slot_missing',
    status: 'failed',
    errorCode: 'NORMAL_WORKER_NOT_FOUND',
  });
  assert.equal(deletes, 0);
});

test('blocked Cloudflare deletion marks the worker delete pending', async () => {
  const calls = [];
  const application = createApplication({
    records: [worker()],
    deleteWorker: async () => {
      calls.push('delete');
      const error = new Error('still bound');
      error.status = 409;
      throw error;
    },
    markDeletePending: async (input) => {
      calls.push(['pending', input]);
      return worker({ status: 'delete_pending' });
    },
  });

  const result = await application.retire(command());

  assert.equal(result.status, 'delete_pending');
  assert.equal(result.worker.canDelete, true);
  assert.deepEqual(calls.map((item) => (Array.isArray(item) ? item[0] : item)), ['delete', 'pending']);
});

test('normal worker retirement preserves provider and state failure precedence', async () => {
  const genericFailure = createApplication({
    records: [worker()],
    deleteWorker: async () => {
      throw new Error('token rejected');
    },
  });
  const stateFailure = createApplication({
    records: [worker()],
    retire: async () => null,
  });

  assert.equal((await genericFailure.retire(command())).errorCode, 'NORMAL_WORKER_DELETE_FAILED');
  assert.equal((await stateFailure.retire(command())).errorCode, 'NORMAL_WORKER_STATE_INCONSISTENT');
});

test('normal worker batch retirement keeps result order and concurrency bounded at five', async () => {
  const records = Array.from({ length: 6 }, (_, index) => workerRecord(index + 1));
  let activeDeletes = 0;
  let maxActiveDeletes = 0;
  const application = createApplication({
    records,
    deleteWorker: async () => {
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeDeletes -= 1;
    },
    retire: async (input) => ({ ...records.find((item) => item.id === input.id), status: 'retired' }),
  });
  const ids = [...records.map((item) => item.id), 'slot_missing'];

  const result = await application.retireBatch(command({ ids }));

  assert.deepEqual(result.summary, { requested: 7, retired: 6, pending: 0, failed: 1 });
  assert.deepEqual(result.results.map((item) => item.id), ids);
  assert.equal(result.results.at(-1).errorCode, 'NORMAL_WORKER_NOT_FOUND');
  assert.ok(maxActiveDeletes > 1);
  assert.ok(maxActiveDeletes <= 5);
});

test('normal worker retirement requires narrow ports', () => {
  assert.throws(
    () => createNormalWorkerRetirement({ workers: {}, provider: {}, clock: {} }),
    /workers\.list is required/
  );
});

function createApplication({ records = [], deleteWorker = async () => {}, retire, markDeletePending } = {}) {
  return createNormalWorkerRetirement({
    workers: {
      list: async () => records,
      retire: retire || (async (input) => ({ ...records.find((item) => item.id === input.id), status: 'retired' })),
      ...(markDeletePending ? { markDeletePending } : {}),
    },
    provider: { deleteWorker },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });
}

function command(overrides = {}) {
  return {
    id: 'slot_1',
    environment: 'production',
    actorUserId: 'usr_admin',
    reason: 'legacy drain',
    ...overrides,
  };
}

function worker(overrides = {}) {
  return {
    id: 'slot_1',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
    activeRoute: null,
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

function workerRecord(number) {
  const suffix = String(number).padStart(3, '0');
  return worker({
    id: `slot_${suffix}`,
    slotNumber: number,
    workerName: `pages-v2-production-slot-${suffix}`,
    bindingName: `SITE_SLOT_${suffix}`,
  });
}
