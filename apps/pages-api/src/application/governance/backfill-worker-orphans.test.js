import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerOrphanBackfill } from './backfill-worker-orphans.js';

const inventory = {
  workers: [
    { name: 'pages-v2-orphan' },
    { name: 'pages-v2-active' },
    { name: 'pages-v2-existing' },
    { name: 'pages-v2-deleted' },
  ],
  completeness: 'complete',
  scannedCount: 4,
  namespaceScriptCount: 4,
};
const references = {
  activeRoutes: [{ workerName: 'pages-v2-active', executionProvider: 'wfp' }],
  versions: [
    {
      id: 'ver_deleted',
      workerName: 'pages-v2-deleted',
      siteId: 'site_deleted',
      siteDeletedAt: '2026-08-20T00:00:00.000Z',
      artifactAvailability: 'active',
      executionProvider: 'wfp',
      createdAt: '2026-08-20T00:00:00.000Z',
    },
  ],
  cleanupTasks: [{ resourceRef: 'pages-v2-existing', status: 'failed' }],
};
const command = {
  environment: 'production',
  limit: 100,
  workerNames: ['pages-v2-orphan', 'pages-v2-active', 'pages-v2-existing', 'pages-v2-deleted', 'invalid'],
};

function createApplication(overrides = {}) {
  return createWorkerOrphanBackfill({
    inventory: { list: async () => inventory },
    references: { list: async () => references },
    workers: {
      isManaged: (name) => name.startsWith('pages-v2-'),
      isResource: (record) => record.executionProvider === 'wfp',
    },
    cleanupTasks: { create: async () => null },
    audits: { record: async () => null },
    ids: { next: () => 'cln_1' },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    ...overrides,
  });
}

test('worker orphan backfill revalidates every name and creates only safe cleanup tasks', async () => {
  const tasks = [];
  const audits = [];
  let nextId = 0;
  const application = createApplication({
    cleanupTasks: { create: async (task) => tasks.push(task) },
    audits: { record: async (event) => audits.push(event) },
    ids: { next: () => `cln_${++nextId}` },
  });

  assert.deepEqual(await application.backfill(command), {
    ok: true,
    summary: { requested: 5, created: 2, skipped: 3 },
    results: [
      { workerName: 'pages-v2-orphan', status: 'created', rollbackEligible: false },
      { workerName: 'pages-v2-active', status: 'skipped', reason: 'active_route_reference' },
      { workerName: 'pages-v2-existing', status: 'skipped', reason: 'cleanup_task_exists' },
      { workerName: 'pages-v2-deleted', status: 'created', rollbackEligible: false },
      { workerName: 'invalid', status: 'skipped', reason: 'worker_not_managed' },
    ],
  });
  assert.deepEqual(
    tasks.map((task) => [task.resourceRef, task.cleanupReason, task.siteId, task.versionId]),
    [
      ['pages-v2-orphan', 'orphan_backfill', null, null],
      ['pages-v2-deleted', 'site_deleted_backfill', 'site_deleted', 'ver_deleted'],
    ]
  );
  assert.deepEqual(audits.map((event) => event.decision), ['allow', 'skip', 'skip', 'allow', 'skip']);
});

test('worker orphan backfill requires a complete server-side inventory', async () => {
  const application = createApplication({
    inventory: { list: async () => ({ ...inventory, completeness: 'incomplete' }) },
    cleanupTasks: { create: async () => assert.fail('incomplete inventory must stop task creation') },
  });

  assert.deepEqual(await application.backfill(command), { ok: false, reason: 'scan_incomplete' });
});

test('worker orphan backfill fails closed on revalidation or scan limit failures', async () => {
  const error = new Error('inventory unavailable');
  const unavailable = createApplication({ inventory: { list: async () => Promise.reject(error) } });
  const limited = createApplication({
    inventory: { list: async () => ({ ...inventory, scannedCount: 101 }) },
    references: { list: async () => ({ ...references, scanLimitExceeded: true }) },
  });

  assert.deepEqual(await unavailable.backfill(command), {
    ok: false,
    reason: 'revalidation_failed',
    error,
  });
  assert.deepEqual(await limited.backfill(command), { ok: false, reason: 'limit_exceeded' });
});

test('worker orphan backfill turns task persistence failures into audited skips', async () => {
  const audits = [];
  const application = createApplication({
    cleanupTasks: { create: async () => Promise.reject(new Error('write failed')) },
    audits: { record: async (event) => audits.push(event) },
  });

  const result = await application.backfill({ ...command, workerNames: ['pages-v2-orphan'] });

  assert.deepEqual(result, {
    ok: true,
    summary: { requested: 1, created: 0, skipped: 1 },
    results: [{ workerName: 'pages-v2-orphan', status: 'skipped', reason: 'cleanup_task_create_failed' }],
  });
  assert.equal(audits[0].decision, 'deny');
  assert.equal(audits[0].metadata.reason, 'cleanup_task_create_failed');
});

test('worker orphan backfill requires explicit inventory, classification, and task ports', () => {
  assert.throws(
    () =>
      createWorkerOrphanBackfill({
        inventory: {},
        references: {},
        workers: {},
        cleanupTasks: {},
        audits: {},
        ids: {},
        clock: {},
      }),
    /inventory\.list is required/
  );
});
