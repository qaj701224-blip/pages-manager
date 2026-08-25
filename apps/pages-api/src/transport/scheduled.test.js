import assert from 'node:assert/strict';
import test from 'node:test';

import { createScheduledHandler } from './scheduled.js';

test('scheduled transport sends cleanup work through the injected task scheduler', async () => {
  const calls = [];
  const store = {};
  const handler = createScheduledHandler({
    readConfig: () => ({ environment: 'production' }),
    createStore: () => store,
    runDueCleanups: async (...args) => calls.push(['cleanup', ...args]),
    runMetadataReconciliation: async (...args) => calls.push(['metadata', ...args]),
    taskScheduler: {
      schedule: async (context, task) => {
        calls.push(['schedule', context]);
        return task;
      },
    },
  });
  const context = { waitUntil: () => {} };

  await handler({}, { DEPLOYMENT_CLEANUP_CRON_LIMIT: '7' }, context);

  assert.deepEqual(calls[0], [
    'cleanup',
    { DEPLOYMENT_CLEANUP_CRON_LIMIT: '7' },
    { environment: 'production' },
    store,
    { limit: 7 },
  ]);
  assert.deepEqual(calls[1], [
    'metadata',
    { DEPLOYMENT_CLEANUP_CRON_LIMIT: '7' },
    { environment: 'production' },
    store,
    { limit: 50 },
  ]);
  assert.deepEqual(calls[2], ['schedule', context]);
});

test('scheduled transport fails closed before scheduling when config or store creation fails', async () => {
  let scheduled = 0;
  const taskScheduler = { schedule: () => (scheduled += 1) };
  const invalidConfig = createScheduledHandler({
    readConfig: () => {
      throw new Error('invalid config');
    },
    createStore: () => ({}),
    runDueCleanups: async () => {},
    runMetadataReconciliation: async () => {},
    taskScheduler,
  });
  const invalidStore = createScheduledHandler({
    readConfig: () => ({}),
    createStore: () => {
      throw new Error('invalid store');
    },
    runDueCleanups: async () => {},
    runMetadataReconciliation: async () => {},
    taskScheduler,
  });

  await invalidConfig({}, {}, {});
  await invalidStore({}, {}, {});

  assert.equal(scheduled, 0);
});

test('scheduled transport requires a narrow task scheduler port', () => {
  assert.throws(
    () => createScheduledHandler({ readConfig: () => ({}), createStore: () => ({}), runDueCleanups: async () => {} }),
    /taskScheduler\.schedule is required/
  );
});
