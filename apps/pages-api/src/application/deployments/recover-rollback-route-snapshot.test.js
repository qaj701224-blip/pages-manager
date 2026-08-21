import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackRouteSnapshotRecovery } from './recover-rollback-route-snapshot.js';

const site = { id: 'site_1' };
const previousRoute = { id: 'route_1', activeVersionId: 'ver_1', exposure: 'public' };
const failedRoute = { id: 'route_1', activeVersionId: 'ver_2', exposure: 'public' };
const restoredRoute = {
  ...previousRoute,
  workerName: 'pages-v2-guide-ver-1',
  executionProvider: 'wfp',
  policyVersion: 2,
  routeGeneration: 4,
  runtimeConfigGeneration: 3,
};
const restoredVersion = {
  id: 'ver_1',
  workerName: restoredRoute.workerName,
  executionProvider: 'wfp',
  deploymentShape: 'worker',
};

function command(overrides = {}) {
  return {
    environment: 'production',
    site,
    previousRoute,
    failedRoute,
    lease: { lockId: 'lock_1', signal: { aborted: false } },
    ...overrides,
  };
}

function createApplication(overrides = {}) {
  return createRollbackRouteSnapshotRecovery({
    routes: {
      restore: async () => restoredRoute,
      getVersion: async () => restoredVersion,
      updateAccessPolicy: async () => ({ route: { ...restoredRoute, exposure: 'internal', accessMode: 'disabled' } }),
    },
    officeNet: { ensure: async () => null },
    routeSnapshots: {
      writeRestored: async () => true,
      writeSafeDisabled: async () => true,
      clearCurrent: async () => false,
    },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    ...overrides,
  });
}

test('rollback snapshot recovery restores the route and re-verifies its public Worker before writing the snapshot', async () => {
  const calls = [];
  const application = createApplication({
    routes: {
      async restore(input) {
        calls.push(['restore', input]);
        return restoredRoute;
      },
      async getVersion(versionId, environment) {
        calls.push(['version', versionId, environment]);
        return restoredVersion;
      },
      updateAccessPolicy: async () => null,
    },
    officeNet: {
      async ensure(input) {
        calls.push(['officeNet', input]);
      },
    },
    routeSnapshots: {
      async writeRestored(input) {
        calls.push(['snapshot', input]);
        return true;
      },
      writeSafeDisabled: async () => false,
      clearCurrent: async () => false,
    },
  });

  assert.deepEqual(await application.recover(command()), {
    restoredRoute,
    failure: null,
    restoredSnapshotWritten: true,
    routePointerCleared: false,
    repairRequired: false,
  });
  assert.deepEqual(calls.map(([operation]) => operation), ['restore', 'version', 'officeNet', 'snapshot']);
  assert.deepEqual(calls[2][1], {
    environment: 'production',
    siteId: 'site_1',
    workerName: 'pages-v2-guide-ver-1',
    executionProvider: 'wfp',
    deploymentShape: 'worker',
    exposure: 'public',
    signal: command().lease.signal,
  });
});

test('rollback snapshot recovery fail-closes an unverifiable public route before writing its restored snapshot', async () => {
  const officeNetError = new Error('office net remains attached');
  officeNetError.code = 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
  const calls = [];
  const safeRoute = { ...restoredRoute, exposure: 'internal', accessMode: 'disabled' };
  const application = createApplication({
    routes: {
      restore: async () => restoredRoute,
      getVersion: async () => restoredVersion,
      async updateAccessPolicy(input) {
        calls.push(['policy', input]);
        return { route: safeRoute };
      },
    },
    officeNet: {
      ensure: async () => {
        throw officeNetError;
      },
    },
    routeSnapshots: {
      async writeRestored(input) {
        calls.push(['snapshot', input]);
        return true;
      },
      writeSafeDisabled: async () => false,
      clearCurrent: async () => false,
    },
  });

  assert.deepEqual(await application.recover(command()), {
    restoredRoute: safeRoute,
    failure: { kind: 'office_net', error: officeNetError },
    restoredSnapshotWritten: true,
    routePointerCleared: false,
    repairRequired: false,
  });
  assert.deepEqual(calls[0][1], {
    environment: 'production',
    siteId: 'site_1',
    exposure: 'internal',
    accessMode: 'disabled',
    expected: {
      policyVersion: 2,
      routeGeneration: 4,
      activeVersionId: 'ver_1',
      runtimeConfigGeneration: 3,
    },
    lease: command().lease,
    updatedAt: '2026-08-21T00:00:00.000Z',
  });
  assert.deepEqual(calls.map(([operation]) => operation), ['policy', 'snapshot']);
});

test('rollback snapshot recovery writes a safe disabled snapshot when the authority downgrade fails', async () => {
  const officeNetError = new Error('office net remains attached');
  const policyError = new Error('policy update failed');
  const calls = [];
  const application = createApplication({
    routes: {
      restore: async () => restoredRoute,
      getVersion: async () => restoredVersion,
      updateAccessPolicy: async () => {
        throw policyError;
      },
    },
    officeNet: {
      ensure: async () => {
        throw officeNetError;
      },
    },
    routeSnapshots: {
      writeRestored: async () => false,
      async writeSafeDisabled(input) {
        calls.push(input);
        return true;
      },
      clearCurrent: async () => false,
    },
  });

  assert.deepEqual(await application.recover(command()), {
    restoredRoute,
    failure: { kind: 'safe_route_update', error: policyError },
    restoredSnapshotWritten: true,
    routePointerCleared: false,
    repairRequired: false,
  });
  assert.deepEqual(calls, [{ site, route: restoredRoute, environment: 'production' }]);
});

test('rollback snapshot recovery clears the failed pointer when route restoration fails', async () => {
  const restoreError = new Error('route restore failed');
  const calls = [];
  const application = createApplication({
    routes: {
      restore: async () => {
        throw restoreError;
      },
      getVersion: async () => null,
      updateAccessPolicy: async () => null,
    },
    routeSnapshots: {
      writeRestored: async () => false,
      writeSafeDisabled: async () => false,
      async clearCurrent(route) {
        calls.push(route);
        return true;
      },
    },
  });

  assert.deepEqual(await application.recover(command()), {
    restoredRoute: null,
    failure: { kind: 'route_restore', error: restoreError },
    restoredSnapshotWritten: false,
    routePointerCleared: true,
    repairRequired: true,
  });
  assert.deepEqual(calls, [failedRoute]);
});

test('rollback snapshot recovery requires its narrow fail-closed capabilities', () => {
  assert.throws(
    () => createRollbackRouteSnapshotRecovery({ routes: {}, officeNet: {}, routeSnapshots: {}, clock: {} }),
    /routes\.restore is required/
  );
});
