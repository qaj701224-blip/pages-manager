import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerOrphanScan } from './scan-worker-orphans.js';

test('worker orphan scan joins provider inventory and D1 references into one projection', async () => {
  const calls = [];
  const inventory = {
    workers: [{ name: 'pages-v2-orphan' }],
    completeness: 'complete',
    scannedCount: 1,
    namespaceScriptCount: 1,
  };
  const references = { activeRoutes: [], versions: [], cleanupTasks: [] };
  const scan = { workers: [{ name: 'pages-v2-orphan', orphanCandidate: true }] };
  const application = createWorkerOrphanScan({
    inventory: { list: async (input) => (calls.push(['inventory', input]), inventory) },
    references: { list: async (input) => (calls.push(['references', input]), references) },
    projection: { build: (input) => (calls.push(['projection', input]), scan) },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.deepEqual(await application.scan({ environment: 'production', limit: 100 }), { ok: true, scan });
  assert.deepEqual(calls, [
    ['inventory', { maxWorkers: 100 }],
    ['references', { environment: 'production', limit: 100 }],
    [
      'projection',
      {
        workers: inventory.workers,
        references,
        environment: 'production',
        scannedAt: '2026-08-21T00:00:00.000Z',
        completeness: 'complete',
        scannedCount: 1,
        namespaceScriptCount: 1,
      },
    ],
  ]);
});

test('worker orphan scan accepts legacy array inventory metadata', async () => {
  const workers = [{ name: 'pages-v2-orphan' }];
  let projectionInput;
  const application = createWorkerOrphanScan({
    inventory: { list: async () => workers },
    references: { list: async () => ({}) },
    projection: { build: (input) => ((projectionInput = input), { workers: [] }) },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.equal((await application.scan({ environment: 'production', limit: 100 })).ok, true);
  assert.equal(projectionInput.workers, workers);
  assert.equal(projectionInput.completeness, null);
});

test('worker orphan scan fails closed when inventory or references exceed the configured limit', async () => {
  const application = createWorkerOrphanScan({
    inventory: {
      list: async () => ({ workers: [], completeness: 'complete', scannedCount: 101, namespaceScriptCount: 101 }),
    },
    references: { list: async () => ({ scanLimitExceeded: true }) },
    projection: { build: () => assert.fail('limit failure must stop projection') },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.deepEqual(await application.scan({ environment: 'production', limit: 100 }), {
    ok: false,
    reason: 'limit_exceeded',
  });
});

test('worker orphan scan preserves provider failures for safe transport mapping', async () => {
  const error = Object.assign(new Error('WFP_API_RESPONSE_INVALID'), { code: 'WFP_API_RESPONSE_INVALID' });
  const application = createWorkerOrphanScan({
    inventory: { list: async () => Promise.reject(error) },
    references: { list: async () => ({}) },
    projection: { build: () => null },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.deepEqual(await application.scan({ environment: 'production', limit: 100 }), {
    ok: false,
    reason: 'scan_failed',
    error,
  });
});

test('worker orphan scan requires narrow inventory and projection ports', () => {
  assert.throws(
    () => createWorkerOrphanScan({ inventory: {}, references: {}, projection: {}, clock: {} }),
    /inventory\.list is required/
  );
});
