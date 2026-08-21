import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackSite } from './rollback-site.js';

const site = { id: 'site_1' };
const deployment = { id: 'dep_1', operation: 'rollback' };
const currentRoute = { id: 'route_1', activeVersionId: 'ver_2', visibility: 'org', exposure: 'public' };
const latestRoute = { ...currentRoute, policyVersion: 2 };
const route = { ...latestRoute, activeVersionId: 'ver_1' };
const version = { id: 'ver_1', artifactAvailability: 'active' };
const lease = { lockId: 'lock_1' };
const command = { site, deployment, currentRoute, version, environment: 'production', exposure: 'public' };

function createApplication(overrides = {}) {
  return createRollbackSite({
    preparation: {
      prepare: async () => ({ ok: true, lease, route: latestRoute, routeBeforeActivation: currentRoute }),
    },
    cutover: { activate: async () => ({ ok: true, route }) },
    versions: { get: async () => version },
    finalization: { finalize: async () => ({ ok: true, completed: { ...deployment, status: 'succeeded' } }) },
    leases: { release: async () => null },
    ...overrides,
  });
}

test('rollback site orchestrates preparation, cutover, and finalization in order', async () => {
  const calls = [];
  const completed = { ...deployment, status: 'succeeded' };
  const application = createApplication({
    preparation: {
      async prepare(input) {
        calls.push(['prepare', input]);
        return { ok: true, lease, route: latestRoute, routeBeforeActivation: currentRoute };
      },
    },
    cutover: {
      async activate(input) {
        calls.push(['activate', input]);
        return { ok: true, route };
      },
    },
    finalization: {
      async finalize(input) {
        calls.push(['finalize', input]);
        return { ok: true, completed };
      },
    },
  });

  assert.deepEqual(await application.execute(command), { ok: true, route, completed });
  assert.deepEqual(calls, [
    ['prepare', { environment: 'production', siteId: 'site_1', currentRoute }],
    [
      'activate',
      {
        environment: 'production',
        siteId: 'site_1',
        currentRoute: latestRoute,
        version,
        lease,
        exposure: 'public',
        activation: {
          visibility: 'org',
          expectedRoute: { ...latestRoute, exposure: 'public' },
        },
      },
    ],
    [
      'finalize',
      { site, deployment, previousRoute: latestRoute, route, version, lease, environment: 'production' },
    ],
  ]);
});

test('rollback site preserves preparation failures without starting cutover', async () => {
  const failure = { code: 'SITE_POLICY_LOCKED', reason: 'acquire_failed' };
  const application = createApplication({
    preparation: { prepare: async () => ({ ok: false, error: failure }) },
    cutover: { activate: async () => assert.fail('preparation failure must stop cutover') },
  });

  assert.deepEqual(await application.execute(command), {
    ok: false,
    stage: 'prepare',
    error: failure,
    previousRoute: currentRoute,
  });
});

test('rollback site releases the lease and preserves activation exceptions', async () => {
  const cause = Object.assign(new Error('activation failed'), { code: 'SITE_POLICY_CONFLICT' });
  const released = [];
  const application = createApplication({
    cutover: { activate: async () => Promise.reject(cause) },
    leases: { release: async (input) => released.push(input) },
  });

  assert.deepEqual(await application.execute(command), {
    ok: false,
    stage: 'activate',
    error: { reason: 'activation_error', cause },
    previousRoute: currentRoute,
  });
  assert.deepEqual(released, [lease]);
});

test('rollback site preserves OfficeNet failures before finalization', async () => {
  const officeNetError = { code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', reason: 'settings_failure' };
  const released = [];
  const application = createApplication({
    cutover: { activate: async () => ({ ok: false, kind: 'office_net_failed', error: officeNetError }) },
    leases: { release: async (input) => released.push(input) },
    finalization: { finalize: async () => assert.fail('OfficeNet failure must stop finalization') },
  });

  assert.deepEqual(await application.execute(command), {
    ok: false,
    stage: 'activate',
    error: { reason: 'office_net_failed', officeNetError },
    previousRoute: currentRoute,
  });
  assert.deepEqual(released, [lease]);
});

test('rollback site rechecks artifact availability after a route CAS conflict', async () => {
  const released = [];
  const application = createApplication({
    cutover: { activate: async () => ({ ok: false, error: { reason: 'cas_conflict' } }) },
    versions: { get: async () => ({ ...version, artifactAvailability: 'retiring' }) },
    leases: { release: async (input) => released.push(input) },
  });

  assert.deepEqual(await application.execute(command), {
    ok: false,
    stage: 'activate',
    error: { reason: 'version_unavailable' },
    previousRoute: latestRoute,
  });
  assert.deepEqual(released, [lease]);
});

test('rollback site returns route finalization recovery evidence', async () => {
  const error = { reason: 'snapshot_failed', recovery: { repairRequired: true } };
  const application = createApplication({
    finalization: { finalize: async () => ({ ok: false, error }) },
  });

  assert.deepEqual(await application.execute(command), {
    ok: false,
    stage: 'finalize',
    error,
    previousRoute: latestRoute,
    route,
  });
});

test('rollback site requires its narrow stages', () => {
  assert.throws(
    () => createRollbackSite({ preparation: {}, cutover: {}, versions: {}, finalization: {}, leases: {} }),
    /preparation\.prepare is required/
  );
});
