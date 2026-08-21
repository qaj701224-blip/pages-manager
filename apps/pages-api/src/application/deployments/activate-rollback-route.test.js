import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackRouteCutover } from './activate-rollback-route.js';

const lease = { lockId: 'lock_1', signal: { aborted: false } };
const currentRoute = { id: 'route_1', activeVersionId: 'ver_2', visibility: 'org' };
const version = { id: 'ver_1', workerName: 'worker-1', executionProvider: 'wfp' };
const activation = { visibility: 'org', expectedRoute: currentRoute };
const command = {
  environment: 'production',
  siteId: 'site_1',
  currentRoute,
  version,
  lease,
  exposure: 'public',
  activation,
};

test('rollback route cutover preserves convergence and double-fence order around OfficeNet verification', async () => {
  const calls = [];
  const route = { ...currentRoute, activeVersionId: 'ver_1' };
  const application = createRollbackRouteCutover({
    routeSnapshots: {
      async assertConverged(input) {
        calls.push(['snapshot', input]);
      },
    },
    leases: { assertHealthy: (input) => calls.push(['lease', input]) },
    officeNet: {
      async verify(input) {
        calls.push(['office-net', input]);
        return { ok: true, result: { status: 'verified' } };
      },
    },
    routes: {
      async activate(input) {
        calls.push(['activate', input]);
        return { ok: true, route };
      },
    },
  });

  assert.deepEqual(await application.activate(command), { ok: true, route });
  assert.deepEqual(calls, [
    ['snapshot', { route: currentRoute, environment: 'production' }],
    ['lease', lease],
    [
      'office-net',
      {
        environment: 'production',
        siteId: 'site_1',
        version,
        currentVersionId: 'ver_2',
        exposure: 'public',
        signal: lease.signal,
      },
    ],
    ['lease', lease],
    [
      'activate',
      {
        siteId: 'site_1',
        environment: 'production',
        version,
        lease,
        activation,
        requiredArtifactAvailability: 'active',
      },
    ],
  ]);
});

test('rollback route cutover stops before its second fence and CAS on OfficeNet failure', async () => {
  const calls = [];
  const error = { code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', reason: 'settings_failure' };
  const application = createRollbackRouteCutover({
    routeSnapshots: { assertConverged: async () => calls.push(['snapshot']) },
    leases: { assertHealthy: () => calls.push(['lease']) },
    officeNet: { verify: async () => (calls.push(['office-net']), { ok: false, error }) },
    routes: { activate: async () => assert.fail('unsafe OfficeNet state must not activate the route') },
  });

  assert.deepEqual(await application.activate(command), { ok: false, kind: 'office_net_failed', error });
  assert.deepEqual(calls, [['snapshot'], ['lease'], ['office-net']]);
});

test('rollback route cutover preserves typed CAS conflicts', async () => {
  const conflict = { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'cas_conflict' } };
  const application = createRollbackRouteCutover({
    routeSnapshots: { assertConverged: async () => null },
    leases: { assertHealthy() {} },
    officeNet: { verify: async () => ({ ok: true, result: { status: 'not_applicable' } }) },
    routes: { activate: async () => conflict },
  });

  assert.equal(await application.activate(command), conflict);
});

test('rollback route cutover requires its narrow capabilities', () => {
  assert.throws(
    () => createRollbackRouteCutover({ routeSnapshots: {}, leases: {}, officeNet: {}, routes: {} }),
    /routeSnapshots\.assertConverged is required/
  );
});
