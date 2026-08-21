import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRouteSnapshotRecovery } from './recover-route-snapshot.js';

const previousRoute = { id: 'route_1', activeVersionId: 'ver_1' };
const failedRoute = { id: 'route_1', activeVersionId: 'ver_2' };
const site = { id: 'site_1', ownerType: 'team', ownerId: 'team_2' };
const previousSite = {
  id: 'site_1',
  ownerType: 'user',
  ownerId: 'usr_1',
  ownerUserId: 'usr_1',
  defaultVisibility: 'internal',
  updatedAt: '2026-08-21T00:00:00.000Z',
};

function recoveryCommand(overrides = {}) {
  return {
    siteId: 'site_1',
    environment: 'production',
    site,
    previousRoute,
    failedRoute,
    runtimeConfig: { enabled: true },
    ownerTransfer: { enabled: true, previousSite },
    ...overrides,
  };
}

test('snapshot recovery restores route, runtime config, owner, and snapshot in order', async () => {
  const calls = [];
  const restoredRoute = { ...previousRoute, routeGeneration: 3 };
  const restoredSite = { ...previousSite };
  const application = createDeploymentRouteSnapshotRecovery({
    routes: {
      async restore(input) {
        calls.push(['route', input]);
        return restoredRoute;
      },
      async restoreOwner(siteId, patch, environment) {
        calls.push(['owner', siteId, patch, environment]);
        return restoredSite;
      },
    },
    runtimeConfig: {
      async restore(command) {
        calls.push(['runtime', command]);
        return { kind: 'restored' };
      },
    },
    routeSnapshots: {
      async writeRestored(input) {
        calls.push(['snapshot', input]);
        return true;
      },
      async clearCurrent(route) {
        calls.push(['clear', route]);
        return true;
      },
    },
  });

  assert.deepEqual(await application.recover(recoveryCommand()), {
    site: restoredSite,
    restoredRoute,
    restoredSnapshotWritten: true,
    routePointerCleared: false,
    repairRequired: false,
  });
  assert.deepEqual(calls.map(([operation]) => operation), ['route', 'runtime', 'owner', 'snapshot']);
  assert.deepEqual(calls[2], [
    'owner',
    'site_1',
    {
      ownerType: 'user',
      ownerId: 'usr_1',
      ownerUserId: 'usr_1',
      defaultVisibility: 'internal',
      updatedAt: '2026-08-21T00:00:00.000Z',
    },
    'production',
  ]);
});

test('snapshot recovery clears the failed route pointer after route restoration fails', async () => {
  const calls = [];
  const application = createDeploymentRouteSnapshotRecovery({
    routes: {
      restore: async () => {
        calls.push('route');
        throw new Error('route restore failed');
      },
      restoreOwner: null,
    },
    runtimeConfig: {
      async restore() {
        calls.push('runtime');
      },
    },
    routeSnapshots: {
      async writeRestored() {
        calls.push('snapshot');
        return true;
      },
      async clearCurrent(route) {
        calls.push(['clear', route]);
        return true;
      },
    },
  });

  assert.deepEqual(
    await application.recover(recoveryCommand({ ownerTransfer: { enabled: false, previousSite: null } })),
    {
      site,
      restoredRoute: null,
      restoredSnapshotWritten: false,
      routePointerCleared: true,
      repairRequired: true,
    }
  );
  assert.deepEqual(calls, ['route', 'runtime', ['clear', failedRoute]]);
});

test('snapshot recovery clears the restored route pointer when the compensation snapshot cannot be written', async () => {
  const restoredRoute = { ...previousRoute, routeGeneration: 3 };
  const cleared = [];
  const application = createDeploymentRouteSnapshotRecovery({
    routes: { restore: async () => restoredRoute, restoreOwner: null },
    runtimeConfig: { restore: async () => ({ kind: 'skipped' }) },
    routeSnapshots: {
      writeRestored: async () => false,
      async clearCurrent(route) {
        cleared.push(route);
        return false;
      },
    },
  });

  assert.deepEqual(
    await application.recover(recoveryCommand({ ownerTransfer: { enabled: false, previousSite: null } })),
    {
      site,
      restoredRoute,
      restoredSnapshotWritten: false,
      routePointerCleared: false,
      repairRequired: true,
    }
  );
  assert.deepEqual(cleared, [restoredRoute]);
});

test('snapshot recovery requires its narrow route and snapshot capabilities', () => {
  assert.throws(
    () => createDeploymentRouteSnapshotRecovery({ routes: {}, runtimeConfig: {}, routeSnapshots: {} }),
    /routes\.restore is required/
  );
});
