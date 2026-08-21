import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRouteCutover } from './activate-route-cutover.js';

const lease = { lockId: 'lock_1', signal: { aborted: false } };
const version = {
  id: 'ver_2',
  workerName: 'pages-v2-guide-ver-2',
  executionProvider: 'wfp',
};
const activation = {
  exposure: 'public',
  visibility: 'org',
  expectedRoute: { id: 'route_1', activeVersionId: 'ver_1' },
};
const command = {
  environment: 'production',
  siteId: 'site_1',
  version,
  lease,
  activation,
  deploymentShape: 'worker-only',
};

test('deployment route cutover fences OfficeNet before CAS activation in order', async () => {
  const calls = [];
  const route = { id: 'route_1', activeVersionId: 'ver_2' };
  const application = createDeploymentRouteCutover({
    leases: {
      assertHealthy(receivedLease) {
        calls.push(['lease', receivedLease]);
      },
    },
    officeNet: {
      async ensure(input) {
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
    ['lease', lease],
    [
      'office-net',
      {
        environment: 'production',
        siteId: 'site_1',
        workerName: 'pages-v2-guide-ver-2',
        executionProvider: 'wfp',
        deploymentShape: 'worker-only',
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
      },
    ],
  ]);
});

test('deployment route cutover preserves OfficeNet failures before the second fence and CAS', async () => {
  const calls = [];
  const error = { code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', reason: 'settings_failure' };
  const application = createDeploymentRouteCutover({
    leases: { assertHealthy: () => calls.push(['lease']) },
    officeNet: { ensure: async () => (calls.push(['office-net']), { ok: false, error }) },
    routes: { activate: async () => assert.fail('unsafe OfficeNet state must not activate the route') },
  });

  assert.deepEqual(await application.activate(command), { ok: false, kind: 'office_net_failed', error });
  assert.deepEqual(calls, [['lease'], ['office-net']]);
});

test('deployment route cutover preserves typed CAS conflicts', async () => {
  const conflict = { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'cas_conflict' } };
  const application = createDeploymentRouteCutover({
    leases: { assertHealthy() {} },
    officeNet: { ensure: async () => ({ ok: true, result: { status: 'not_applicable' } }) },
    routes: { activate: async () => conflict },
  });

  assert.equal(await application.activate(command), conflict);
});

test('deployment route cutover requires its narrow capabilities', () => {
  assert.throws(() => createDeploymentRouteCutover({ leases: {}, officeNet: {}, routes: {} }), /leases\.assertHealthy/);
  assert.throws(
    () => createDeploymentRouteCutover({ leases: { assertHealthy() {} }, officeNet: {}, routes: {} }),
    /officeNet\.ensure/
  );
  assert.throws(
    () =>
      createDeploymentRouteCutover({
        leases: { assertHealthy() {} },
        officeNet: { ensure() {} },
        routes: {},
      }),
    /routes\.activate/
  );
});
