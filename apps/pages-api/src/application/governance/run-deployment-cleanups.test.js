import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRunDeploymentCleanupTask,
  createDeploymentCleanupRunner,
} from './run-deployment-cleanups.js';

test('cleanup runner distinguishes task lookup failure, absence, and execution', async () => {
  const missing = createRunner({ get: async () => null });
  const failedRead = createRunner({
    get: async () => {
      throw new Error('D1 unavailable');
    },
  });
  const executed = createRunner({ get: async () => task('task_1') });

  assert.deepEqual(await missing.runOne({ id: 'missing', environment: 'production' }), {
    ok: false,
    reason: 'task_not_found',
  });
  assert.deepEqual(await failedRead.runOne({ id: 'task_1', environment: 'production' }), {
    ok: false,
    reason: 'task_read_failed',
  });
  assert.equal((await executed.runOne({ id: 'task_1', environment: 'production' })).execution.outcome, 'succeeded');
});

test('cleanup runner deduplicates and orders due tasks before sequential execution', async () => {
  const calls = [];
  const first = task('task_first', { cleanupAfter: '2026-08-20T00:00:00.000Z' });
  const second = task('task_second', { cleanupAfter: '2026-08-21T00:00:00.000Z', status: 'failed' });
  const future = task('task_future', { cleanupAfter: '2026-08-22T00:00:00.000Z' });
  const byId = new Map([first, second, future].map((item) => [item.id, item]));
  const runner = createRunner({
    list: async ({ status }) =>
      status === 'pending' ? [second, first, future] : status === 'failed' ? [second] : [],
    get: async (id) => byId.get(id),
    execute: async (item) => {
      calls.push(item.id);
      return item.id === 'task_second'
        ? { ok: false, outcome: 'skipped', value: null }
        : { ok: true, outcome: 'succeeded', value: item };
    },
  });

  assert.deepEqual(await runner.runDue({ environment: 'production', limit: 10 }), {
    processed: 2,
    succeeded: 1,
    failed: 0,
    skipped: 1,
  });
  assert.deepEqual(calls, ['task_first', 'task_second']);
});

test('cleanup runner counts refreshed task and executor failures without aborting the batch', async () => {
  const first = task('task_first');
  const second = task('task_second');
  const runner = createRunner({
    list: async ({ status }) => (status === 'pending' ? [first, second] : []),
    get: async (id) => {
      if (id === 'task_first') throw new Error('read failed');
      return second;
    },
    execute: async () => {
      throw new Error('executor failed');
    },
  });

  assert.deepEqual(await runner.runDue({ environment: 'production', limit: 10 }), {
    processed: 2,
    succeeded: 0,
    failed: 2,
    skipped: 0,
  });
});

test('cleanup runnable policy supports expired running tasks and rejects active locks', () => {
  const now = '2026-08-21T00:00:00.000Z';
  assert.equal(
    canRunDeploymentCleanupTask(task('expired', { status: 'running', lockedUntil: '2026-08-20T23:59:59.000Z' }), now),
    true
  );
  assert.equal(
    canRunDeploymentCleanupTask(task('active', { status: 'running', lockedUntil: '2026-08-21T00:00:01.000Z' }), now),
    false
  );
});

test('cleanup runner requires narrow task, executor, and clock ports', () => {
  assert.throws(() => createDeploymentCleanupRunner({ tasks: {}, executor: {}, clock: {} }), /tasks\.list is required/);
});

function createRunner({
  list = async () => [],
  get = async () => null,
  execute = async (item) => ({ ok: true, outcome: 'succeeded', value: item }),
} = {}) {
  return createDeploymentCleanupRunner({
    tasks: { list, get },
    executor: { execute },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });
}

function task(id, overrides = {}) {
  return {
    id,
    environment: 'production',
    status: 'pending',
    cleanupAfter: '2026-08-20T00:00:00.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    lockedUntil: null,
    ...overrides,
  };
}
