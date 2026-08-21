import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentPreviousResourceCleanup } from './cleanup-previous-resources.js';

const activeRoute = {
  activeVersionId: 'ver_2',
  workerName: 'pages-v2-guide-ver-2',
  executionProvider: 'wfp',
  dispatchType: 'dispatch-namespace',
  slotId: null,
};
const deployment = { id: 'dep_2' };

function createApplication(overrides = {}) {
  return createDeploymentPreviousResourceCleanup({
    provider: {},
    cleanupTasks: { create: async () => null },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    ids: { next: () => 'cln_1' },
    managedWorkers: { isManaged: () => true },
    config: { cleanupDrainSeconds: 300 },
    ...overrides,
  });
}

test('post-commit cleanup schedules the previous WFP Worker after the slot cleanup decision', async () => {
  const tasks = [];
  const previousRoute = {
    siteId: 'site_1',
    activeVersionId: 'ver_1',
    workerName: 'pages-v2-guide-ver-1',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    routeStatus: 'active',
    slotId: null,
  };
  const application = createApplication({
    cleanupTasks: {
      async create(input) {
        tasks.push(input);
      },
    },
  });

  assert.deepEqual(
    await runCleanup(application, { environment: 'production', previousRoute, activeRoute, deployment }),
    [
      { status: 'not_needed', operation: 'worker_placeholder_put', causeClass: 'cleanup_not_needed' },
      {
        status: 'scheduled',
        operation: 'worker_delete',
        cleanupTaskId: 'cln_1',
        causeClass: 'cleanup_scheduled',
      },
    ]
  );
  assert.deepEqual(tasks, [
    {
      id: 'cln_1',
      environment: 'production',
      resourceType: 'wfp_user_worker',
      resourceRef: 'pages-v2-guide-ver-1',
      siteId: 'site_1',
      versionId: 'ver_1',
      deploymentId: 'dep_2',
      cleanupReason: 'blue_green_previous_worker',
      status: 'pending',
      cleanupAfter: '2026-08-21T00:05:00.000Z',
    },
  ]);
});

test('post-commit cleanup releases a replaced normal Worker slot and skips WFP cleanup', async () => {
  const calls = [];
  const previousRoute = {
    siteId: 'site_1',
    activeVersionId: 'ver_1',
    workerName: 'pages-v2-production-slot-001',
    executionProvider: 'normal-worker-slot',
    dispatchType: 'service-binding',
    routeStatus: 'active',
    slotId: 'slot_1',
  };
  const application = createApplication({
    provider: {
      async cleanupRetainedSlot(input) {
        calls.push(input);
      },
    },
  });

  assert.deepEqual(
    await runCleanup(application, {
      environment: 'production',
      previousRoute,
      activeRoute: { ...activeRoute, slotId: 'slot_2' },
      deployment,
    }),
    [
      { status: 'succeeded', operation: 'worker_placeholder_put', causeClass: 'cleanup_succeeded' },
      { status: 'not_needed', operation: 'worker_delete', causeClass: 'cleanup_not_needed' },
    ]
  );
  assert.deepEqual(calls, [
    {
      slotId: 'slot_1',
      versionId: 'ver_1',
      activeSlotId: 'slot_2',
      updatedAt: '2026-08-21T00:00:00.000Z',
    },
  ]);
});

test('post-commit cleanup reports Provider and task failures without throwing', async () => {
  const providerCause = new Error('placeholder failed');
  providerCause.operation = 'worker_placeholder_put';
  const previousRoute = {
    siteId: 'site_1',
    activeVersionId: 'ver_1',
    workerName: 'pages-v2-production-slot-001',
    executionProvider: 'normal-worker-slot',
    dispatchType: 'service-binding',
    routeStatus: 'active',
    slotId: 'slot_1',
  };
  const slotFailure = createApplication({
    provider: {
      cleanupRetainedSlot: async () => {
        throw providerCause;
      },
    },
  });
  assert.deepEqual(
    await runCleanup(slotFailure, {
      environment: 'production',
      previousRoute,
      activeRoute: { ...activeRoute, slotId: 'slot_2' },
      deployment,
    }),
    [
      {
        status: 'failed',
        operation: 'worker_placeholder_put',
        causeClass: 'cleanup_error',
        error: providerCause,
      },
      { status: 'not_needed', operation: 'worker_delete', causeClass: 'cleanup_not_needed' },
    ]
  );

  const taskFailure = createApplication({
    cleanupTasks: {
      create: async () => {
        throw new Error('secret database detail');
      },
    },
  });
  const wfpRoute = {
    ...previousRoute,
    workerName: 'pages-v2-guide-ver-1',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    slotId: null,
  };
  assert.deepEqual(
    await runCleanup(taskFailure, { environment: 'production', previousRoute: wfpRoute, activeRoute, deployment }),
    [
      { status: 'not_needed', operation: 'worker_placeholder_put', causeClass: 'cleanup_not_needed' },
      {
        status: 'failed',
        operation: 'worker_delete',
        cleanupTaskId: 'cln_1',
        causeClass: 'cleanup_task_store_error',
      },
    ]
  );
});

test('post-commit cleanup requires its clock, ids, and managed Worker rule', () => {
  assert.throws(
    () =>
      createDeploymentPreviousResourceCleanup({
        provider: {},
        cleanupTasks: {},
        clock: {},
        ids: { next() {} },
        managedWorkers: { isManaged() {} },
        config: {},
      }),
    /clock\.now is required/
  );
});

async function runCleanup(application, command) {
  return [await application.cleanupPreviousSlot(command), await application.enqueuePreviousWorker(command)];
}
