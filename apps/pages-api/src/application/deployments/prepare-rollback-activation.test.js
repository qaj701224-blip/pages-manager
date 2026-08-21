import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackActivationPreparation } from './prepare-rollback-activation.js';

const currentRoute = { id: 'route_1', activeVersionId: 'ver_2' };
const latestRoute = { ...currentRoute, policyVersion: 2 };
const lease = { lockId: 'lock_1' };
const command = { environment: 'production', siteId: 'site_1', currentRoute };

test('rollback activation preparation acquires the lease before reading current route state', async () => {
  const calls = [];
  const application = createRollbackActivationPreparation({
    leases: {
      async acquire(input) {
        calls.push(['acquire', input]);
        return { ok: true, lease };
      },
      async release(input) {
        calls.push(['release', input]);
      },
    },
    routes: {
      async read(input) {
        calls.push(['read', input]);
        return { ok: true, route: latestRoute };
      },
    },
  });

  assert.deepEqual(await application.prepare(command), {
    ok: true,
    lease,
    route: latestRoute,
    routeBeforeActivation: currentRoute,
  });
  assert.deepEqual(calls, [
    ['acquire', { environment: 'production', siteId: 'site_1' }],
    ['read', { environment: 'production', siteId: 'site_1' }],
  ]);
});

test('rollback activation preparation returns lease failures without reading route state', async () => {
  let routeRead = false;
  const failure = { ok: false, error: { code: 'SITE_POLICY_LOCKED', reason: 'acquire_failed' } };
  const application = createRollbackActivationPreparation({
    leases: { acquire: async () => failure, release: async () => null },
    routes: { read: async () => (routeRead = true) },
  });

  assert.equal(await application.prepare(command), failure);
  assert.equal(routeRead, false);
});

test('rollback activation preparation releases its lease before returning route read failures', async () => {
  const calls = [];
  const failure = { ok: false, error: { code: 'ROLLBACK_ACTIVATION_FAILED', reason: 'route_read_failed' } };
  const application = createRollbackActivationPreparation({
    leases: {
      acquire: async () => ({ ok: true, lease }),
      async release(input) {
        calls.push(['release', input]);
      },
    },
    routes: {
      async read() {
        calls.push(['read']);
        return failure;
      },
    },
  });

  assert.equal(await application.prepare(command), failure);
  assert.deepEqual(calls, [['read'], ['release', lease]]);
});

test('rollback activation preparation requires its narrow capabilities', () => {
  assert.throws(
    () => createRollbackActivationPreparation({ leases: {}, routes: {} }),
    /leases\.acquire is required/
  );
});
