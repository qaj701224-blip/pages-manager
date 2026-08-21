import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRouteActivationPreparation } from './prepare-route-activation.js';

const routeBeforeActivation = {
  id: 'route_1',
  activeVersionId: 'ver_1',
  exposure: 'internal',
  visibility: 'internal',
  routeGeneration: 3,
};
const latestRoute = { ...routeBeforeActivation, routeGeneration: 4 };
const command = {
  deploymentId: 'dep_1',
  environment: 'production',
  siteId: 'site_1',
  site: { id: 'site_1', defaultVisibility: 'org' },
  routeBeforeActivation,
  uploadExposure: 'internal',
  ownerTransferApplied: false,
};

function createApplication({ route = latestRoute, update = async () => null, assertConverged = async () => null } = {}) {
  return createDeploymentRouteActivationPreparation({
    routes: { getBySiteId: async () => route },
    deploymentState: { update },
    routeSnapshots: { assertConverged },
  });
}

test('deployment route activation preparation reads, persists, and fences the latest route in order', async () => {
  const calls = [];
  const application = createDeploymentRouteActivationPreparation({
    routes: {
      async getBySiteId(siteId, environment) {
        calls.push(['read', siteId, environment]);
        return latestRoute;
      },
    },
    deploymentState: {
      async update(deploymentId, patch) {
        calls.push(['update', deploymentId, patch]);
      },
    },
    routeSnapshots: {
      async assertConverged(input) {
        calls.push(['snapshot', input]);
      },
    },
  });

  assert.deepEqual(await application.prepare(command), {
    ok: true,
    latestRoute,
    activation: {
      exposure: 'internal',
      visibility: 'org',
      expectedRoute: { ...latestRoute, exposure: 'internal' },
    },
  });
  assert.deepEqual(calls, [
    ['read', 'site_1', 'production'],
    ['update', 'dep_1', { previousVersionId: 'ver_1' }],
    ['snapshot', { route: latestRoute, environment: 'production' }],
  ]);
});

test('deployment route activation preparation rejects a missing route before writes and fences', async () => {
  const application = createApplication({
    route: null,
    update: async () => assert.fail('missing routes must not update deployment state'),
    assertConverged: async () => assert.fail('missing routes must not read snapshot state'),
  });

  assert.deepEqual(await application.prepare(command), {
    ok: false,
    error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'route_missing' },
  });
});

test('deployment route activation preparation preserves the latest route on exposure drift', async () => {
  const publicRoute = { ...latestRoute, exposure: 'public' };
  const result = await createApplication({ route: publicRoute }).prepare(command);

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'exposure_changed' },
    latestRoute: publicRoute,
  });
});

test('deployment route activation preparation maps previous-version persistence failures', async () => {
  const cause = new Error('deployment store unavailable');
  await assert.rejects(
    () =>
      createApplication({
        update: async () => {
          throw cause;
        },
        assertConverged: async () => assert.fail('snapshot fence follows deployment state persistence'),
      }).prepare(command),
    (error) =>
      error.code === 'DEPLOYMENT_STATE_WRITE_FAILED' &&
      error.deploymentStateOperation === 'persist_previous_version_deployment' &&
      error.cause === cause
  );
});

test('deployment route activation preparation requires its narrow capabilities', () => {
  assert.throws(
    () => createDeploymentRouteActivationPreparation({ routes: {}, deploymentState: {}, routeSnapshots: {} }),
    /routes\.getBySiteId is required/
  );
  assert.throws(
    () =>
      createDeploymentRouteActivationPreparation({
        routes: { getBySiteId() {} },
        deploymentState: {},
        routeSnapshots: {},
      }),
    /deploymentState\.update is required/
  );
  assert.throws(
    () =>
      createDeploymentRouteActivationPreparation({
        routes: { getBySiteId() {} },
        deploymentState: { update() {} },
        routeSnapshots: {},
      }),
    /routeSnapshots\.assertConverged is required/
  );
});
