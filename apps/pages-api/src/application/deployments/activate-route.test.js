import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRouteActivation } from './activate-route.js';

const expectedRoute = {
  id: 'route_1',
  activeVersionId: 'ver_1',
  exposure: 'public',
  policyVersion: 2,
  routeGeneration: 3,
  runtimeConfigGeneration: 4,
};
const activation = {
  exposure: 'public',
  visibility: 'owner',
  expectedRoute,
};
const version = {
  id: 'ver_2',
  workerName: 'pages-v2-guide-ver-2',
  runtime: 'worker',
  executionProvider: 'normal-worker-slot',
  dispatchType: 'service-binding',
  dispatchBindingName: 'WORKER_SLOT_1',
  slotId: 'slot_1',
};
const telemetry = { start: () => null, finish: async () => null };

test('deployment route activation commits the resolved route through its narrow port', async () => {
  const calls = [];
  const activatedRoute = { ...expectedRoute, activeVersionId: 'ver_2', routeGeneration: 4 };
  const lease = { lockId: 'lock_1', fencingToken: 7 };
  const application = createDeploymentRouteActivation({
    routes: {
      async activate(command) {
        calls.push(command);
        return activatedRoute;
      },
    },
    telemetry,
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.deepEqual(
    await application.activate({
      siteId: 'site_1',
      environment: 'production',
      version,
      lease,
      activation,
    }),
    { ok: true, route: activatedRoute }
  );
  assert.deepEqual(calls, [
    {
      siteId: 'site_1',
      environment: 'production',
      route: {
        activeVersionId: 'ver_2',
        workerName: 'pages-v2-guide-ver-2',
        runtime: 'worker',
        executionProvider: 'normal-worker-slot',
        dispatchType: 'service-binding',
        dispatchBindingName: 'WORKER_SLOT_1',
        slotId: 'slot_1',
        visibility: 'owner',
        lease,
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
      expectedRoute,
    },
  ]);
});

test('deployment route activation reports a typed CAS conflict without hiding route errors', async () => {
  const conflict = createDeploymentRouteActivation({
    routes: { activate: async () => null },
    telemetry,
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });
  assert.deepEqual(
    await conflict.activate({ siteId: 'site_1', environment: 'production', version, lease: null, activation }),
    { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'cas_conflict' } }
  );

  const cause = new Error('route store unavailable');
  const failure = createDeploymentRouteActivation({
    routes: {
      activate: async () => {
        throw cause;
      },
    },
    telemetry,
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });
  await assert.rejects(
    () => failure.activate({ siteId: 'site_1', environment: 'production', version, lease: null, activation }),
    (error) => error === cause
  );
});

test('deployment route activation preserves the rollback artifact availability fence', async () => {
  const calls = [];
  const application = createDeploymentRouteActivation({
    routes: {
      async activate(command) {
        calls.push(command);
        return { id: 'route_1' };
      },
    },
    telemetry,
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  await application.activate({
    siteId: 'site_1',
    environment: 'production',
    version,
    lease: null,
    activation,
    requiredArtifactAvailability: 'active',
  });

  assert.equal(calls[0].route.requiredArtifactAvailability, 'active');
});

test('deployment route activation exposes the pure activation decision', () => {
  const application = createDeploymentRouteActivation({
    routes: { activate: async () => null },
    telemetry,
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.deepEqual(
    application.resolve({
      site: { defaultVisibility: 'org' },
      routeBeforeActivation: { visibility: 'internal' },
      latestRoute: { visibility: 'internal', exposure: null },
      uploadExposure: 'internal',
      ownerTransferApplied: false,
    }),
    {
      ok: true,
      activation: {
        exposure: 'internal',
        visibility: 'org',
        expectedRoute: { visibility: 'internal', exposure: 'internal' },
      },
    }
  );
});

test('deployment route activation traces success, conflicts, and route errors in operation order', async () => {
  const calls = [];
  const stage = { operation: 'activate_route' };
  const createApplication = (activate) =>
    createDeploymentRouteActivation({
      routes: {
        async activate(command) {
          calls.push(['activate', command.siteId]);
          return activate(command);
        },
      },
      telemetry: {
        start() {
          calls.push(['start']);
          return stage;
        },
        async finish(receivedStage, outcome) {
          calls.push(['finish', receivedStage, outcome]);
        },
      },
      clock: { now: () => '2026-08-21T00:00:00.000Z' },
    });
  const command = { siteId: 'site_1', environment: 'production', version, lease: null, activation };

  const route = { id: 'route_1' };
  assert.deepEqual(await createApplication(async () => route).activate(command), { ok: true, route });
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['activate', 'site_1'],
    ['finish', stage, { status: 'succeeded' }],
  ]);

  assert.deepEqual(await createApplication(async () => null).activate(command), {
    ok: false,
    error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'cas_conflict' },
  });
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['activate', 'site_1'],
    ['finish', stage, { status: 'failed', reason: 'cas_conflict' }],
  ]);

  const cause = new Error('route store unavailable');
  await assert.rejects(
    () => createApplication(async () => Promise.reject(cause)).activate(command),
    (error) => error === cause
  );
  assert.deepEqual(calls, [
    ['start'],
    ['activate', 'site_1'],
    ['finish', stage, { status: 'failed', reason: 'route_error', cause }],
  ]);
});

test('deployment route activation requires its route and clock capabilities', () => {
  assert.throws(
    () => createDeploymentRouteActivation({ routes: {}, telemetry, clock: { now: () => 'now' } }),
    /routes\.activate is required/
  );
  assert.throws(
    () => createDeploymentRouteActivation({ routes: { activate: async () => null }, telemetry: {}, clock: {} }),
    /telemetry\.start is required/
  );
  assert.throws(
    () => createDeploymentRouteActivation({ routes: { activate: async () => null }, telemetry, clock: {} }),
    /clock\.now is required/
  );
});
