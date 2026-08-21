import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackRouteFinalization } from './finalize-rollback-route.js';

const site = { id: 'site_1' };
const deployment = { id: 'dep_1', operation: 'rollback' };
const previousRoute = { id: 'route_1', activeVersionId: 'ver_2' };
const route = { ...previousRoute, activeVersionId: 'ver_1' };
const version = { id: 'ver_1' };
const lease = { lockId: 'lock_1' };
const command = { site, deployment, previousRoute, route, version, lease, environment: 'production' };

test('rollback route finalization commits the snapshot before releasing and completing', async () => {
  const calls = [];
  const completed = { ...deployment, status: 'succeeded' };
  const application = createRollbackRouteFinalization({
    routeSnapshots: {
      async commit(input) {
        calls.push(['snapshot', input]);
        return { ok: true, snapshot: { routeGeneration: 2 } };
      },
    },
    recovery: { recover: async () => assert.fail('successful snapshot must not recover') },
    leases: { release: async (input) => calls.push(['release', input]) },
    completion: {
      async finalize(input) {
        calls.push(['complete', input]);
        return completed;
      },
    },
  });

  assert.deepEqual(await application.finalize(command), { ok: true, completed });
  assert.deepEqual(calls, [
    ['snapshot', { site, route, version, lease }],
    ['release', lease],
    ['complete', { deployment, version, previousRoute }],
  ]);
});

test('rollback route finalization recovers and releases before returning snapshot failure', async () => {
  const calls = [];
  const recovery = { restoredRoute: previousRoute, repairRequired: false };
  const application = createRollbackRouteFinalization({
    routeSnapshots: {
      async commit(input) {
        calls.push(['snapshot', input]);
        return { ok: false, error: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED' } };
      },
    },
    recovery: {
      async recover(input) {
        calls.push(['recover', input]);
        return recovery;
      },
    },
    leases: { release: async (input) => calls.push(['release', input]) },
    completion: { finalize: async () => assert.fail('failed snapshot must not complete success') },
  });

  assert.deepEqual(await application.finalize(command), {
    ok: false,
    error: { reason: 'snapshot_failed', recovery },
  });
  assert.deepEqual(calls, [
    ['snapshot', { site, route, version, lease }],
    [
      'recover',
      {
        site,
        deploymentId: 'dep_1',
        previousRoute,
        failedRoute: route,
        environment: 'production',
        lease,
      },
    ],
    ['release', lease],
  ]);
});

test('rollback route finalization requires its narrow capabilities', () => {
  assert.throws(
    () => createRollbackRouteFinalization({ routeSnapshots: {}, recovery: {}, leases: {}, completion: {} }),
    /routeSnapshots\.commit is required/
  );
});
