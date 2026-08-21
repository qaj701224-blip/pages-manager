import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRouteSnapshotRecoveryAdapter } from './deployment-recovery.js';

test('deployment snapshot recovery adapter writes the restored route with its immutable version', async () => {
  const calls = [];
  const version = { id: 'ver_1' };
  const route = { activeVersionId: 'ver_1', routeStatus: 'active' };
  const site = { id: 'site_1' };
  const adapter = createDeploymentRouteSnapshotRecoveryAdapter({
    store: {
      async getSiteVersion(versionId, environment) {
        calls.push(['version', versionId, environment]);
        return version;
      },
    },
    routeSnapshots: {
      async commitDeployment(input) {
        calls.push(['snapshot', input]);
      },
    },
    routePointers: {},
  });

  assert.equal(await adapter.writeRestored({ site, route, environment: 'production' }), true);
  assert.deepEqual(calls, [
    ['version', 'ver_1', 'production'],
    ['snapshot', { site, route, version }],
  ]);
});

test('deployment snapshot recovery adapter clears only the exact failed pointer tuple', async () => {
  const calls = [];
  const adapter = createDeploymentRouteSnapshotRecoveryAdapter({
    store: {},
    routeSnapshots: {},
    routePointers: {
      async clearIfCurrent(pointer) {
        calls.push(pointer);
        return true;
      },
    },
  });
  const route = {
    hostname: 'guide.workers.xd.team',
    environment: 'production',
    routeGeneration: 3,
    policyVersion: 2,
  };

  assert.equal(await adapter.clearCurrent(route), true);
  assert.deepEqual(calls, [
    {
      hostname: 'guide.workers.xd.team',
      environment: 'production',
      routeGeneration: 3,
      policyVersion: 2,
      snapshotKey: 'production:route_snapshot:guide.workers.xd.team:3:2',
    },
  ]);
});

test('deployment snapshot recovery adapter fail-closes the public route in a safe disabled snapshot', async () => {
  const calls = [];
  const adapter = createDeploymentRouteSnapshotRecoveryAdapter({
    store: {
      async getSiteVersion() {
        return { id: 'ver_1' };
      },
    },
    routeSnapshots: {
      async commitDeployment(input) {
        calls.push(input);
      },
    },
    routePointers: {},
  });
  const site = { id: 'site_1' };
  const route = { activeVersionId: 'ver_1', routeStatus: 'active', exposure: 'public', visibility: 'org' };

  assert.equal(await adapter.writeSafeDisabled({ site, route, environment: 'production' }), true);
  assert.deepEqual(calls[0].route, {
    ...route,
    exposure: 'internal',
    visibility: 'disabled',
    accessMode: 'disabled',
  });
});
