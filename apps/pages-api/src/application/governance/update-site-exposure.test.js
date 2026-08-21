import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteExposureUpdate } from './update-site-exposure.js';

const site = { id: 'site_1', slug: 'example', defaultExposure: 'internal' };
const currentSite = { ...site };
const currentRoute = {
  id: 'route_1',
  exposure: 'internal',
  accessMode: 'authenticated',
  visibility: 'org',
  policyVersion: 1,
  routeGeneration: 2,
  activeVersionId: 'ver_1',
  runtimeConfigGeneration: 3,
  routeStatus: 'active',
};
const committedRoute = { ...currentRoute, exposure: 'public', policyVersion: 2, routeGeneration: 3 };
const version = { id: 'ver_1', workerName: 'worker_1' };
const lease = { lockId: 'lock_1' };
const operation = {
  operationId: 'op_1',
  now: '2026-08-21T00:00:00.000Z',
  auditMetadata: { operationId: 'op_1', requestedExposure: 'public' },
};
const command = {
  environment: 'production',
  actorUserId: 'usr_admin',
  site,
  exposure: 'public',
  reason: 'Public launch',
};

function createApplication(overrides = {}) {
  return createSiteExposureUpdate({
    preparation: { prepare: async () => ({ ok: true, context: operation }) },
    leases: { run: async (_input, work) => work(lease) },
    sites: { get: async () => currentSite },
    routes: { get: async () => currentRoute },
    versions: { get: async () => version },
    officeNet: { ensure: async () => ({ status: 'verified' }) },
    policies: {
      update: async () => ({ site: currentSite, route: committedRoute, aclEntries: [] }),
    },
    snapshots: {
      finalize: async () => ({ ok: true, site: currentSite, route: committedRoute }),
    },
    audits: { record: async () => null },
    telemetry: { auditUnconfirmed: () => null },
    clock: { now: () => '2026-08-21T00:00:01.000Z' },
    ...overrides,
  });
}

test('site exposure update preserves lease, state, OfficeNet, policy, snapshot, and audit order', async () => {
  const calls = [];
  const mutation = { site: currentSite, route: committedRoute, aclEntries: [] };
  const application = createApplication({
    preparation: {
      async prepare(input) {
        calls.push(['prepare', input]);
        return { ok: true, context: operation };
      },
    },
    leases: {
      async run(input, work) {
        calls.push(['lease', input]);
        return work(lease);
      },
    },
    sites: { get: async (...args) => (calls.push(['site', ...args]), currentSite) },
    routes: { get: async (...args) => (calls.push(['route', ...args]), currentRoute) },
    versions: { get: async (...args) => (calls.push(['version', ...args]), version) },
    officeNet: { ensure: async (input) => (calls.push(['office-net', input]), { status: 'verified' }) },
    policies: { update: async (input) => (calls.push(['policy', input]), mutation) },
    snapshots: {
      finalize: async (input) => (calls.push(['snapshot', input]), { ok: true, site: currentSite, route: committedRoute }),
    },
    audits: { record: async (input) => calls.push(['audit', input]) },
  });

  assert.deepEqual(await application.execute(command), {
    ok: true,
    access: {
      exposure: 'public',
      accessMode: 'authenticated',
      visibility: 'org',
      aclEntries: [],
      exposureReason: { text: 'Public launch', changedAt: operation.now },
    },
    auditStatus: 'confirmed',
  });
  assert.deepEqual(calls.map((call) => call[0]), [
    'prepare',
    'lease',
    'site',
    'route',
    'version',
    'office-net',
    'policy',
    'snapshot',
    'audit',
  ]);
  assert.deepEqual(calls.find((call) => call[0] === 'policy')[1].expected, {
    policyVersion: 1,
    routeGeneration: 2,
    activeVersionId: 'ver_1',
    runtimeConfigGeneration: 3,
  });
});

test('site exposure update stops before the lease when preparation audit fails', async () => {
  const cause = new Error('audit unavailable');
  const application = createApplication({
    preparation: { prepare: async () => ({ ok: false, error: { reason: 'required_audit_failed', cause } }) },
    leases: { run: async () => assert.fail('required audit failure must stop the lease') },
  });

  assert.deepEqual(await application.execute(command), {
    ok: false,
    reason: 'required_audit_failed',
    error: { reason: 'required_audit_failed', cause },
  });
});

test('site exposure update returns inactive public routes without policy side effects', async () => {
  const application = createApplication({
    routes: { get: async () => ({ ...currentRoute, activeVersionId: null, routeStatus: 'inactive' }) },
    versions: { get: async () => assert.fail('inactive route has no version read') },
    officeNet: { ensure: async () => assert.fail('inactive route must stop OfficeNet') },
    policies: { update: async () => assert.fail('inactive route must stop policy update') },
  });

  assert.deepEqual(await application.execute(command), { ok: false, reason: 'public_route_inactive' });
});

test('site exposure update records a safe failure audit for operational errors', async () => {
  const error = Object.assign(new Error('provider secret must not be copied'), {
    code: 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED',
  });
  const audits = [];
  const application = createApplication({
    officeNet: { ensure: async () => Promise.reject(error) },
    audits: { record: async (event) => audits.push(event) },
  });

  assert.deepEqual(await application.execute(command), { ok: false, reason: 'operation_failed', error });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].metadata.stage, 'failed');
  assert.equal(audits[0].metadata.failureCode, 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED');
  assert.doesNotMatch(JSON.stringify(audits[0]), /provider secret/);
});

test('site exposure update preserves snapshot compensation evidence without a second failure audit', async () => {
  const snapshotError = new Error('snapshot unavailable');
  const audits = [];
  let callbackRejected = false;
  const application = createApplication({
    leases: {
      async run(_input, work) {
        try {
          return await work(lease);
        } catch (error) {
          callbackRejected = true;
          assert.equal(error.code, 'ROUTE_POLICY_REPAIR_REQUIRED');
          throw error;
        }
      },
    },
    snapshots: {
      finalize: async () => ({ ok: false, error: { reason: 'repair_required', cause: snapshotError } }),
    },
    audits: { record: async (event) => audits.push(event) },
  });

  assert.deepEqual(await application.execute(command), {
    ok: false,
    reason: 'repair_required',
    error: snapshotError,
  });
  assert.equal(callbackRejected, true);
  assert.deepEqual(audits, []);
});

test('site exposure update keeps committed success when the final audit is unavailable', async () => {
  const cause = new Error('audit unavailable');
  const warnings = [];
  const application = createApplication({
    audits: { record: async () => Promise.reject(cause) },
    telemetry: { auditUnconfirmed: (input) => warnings.push(input) },
  });

  const result = await application.execute(command);

  assert.equal(result.ok, true);
  assert.equal(result.auditStatus, 'unconfirmed');
  assert.deepEqual(warnings, [
    { operationId: 'op_1', siteId: 'site_1', environment: 'production', cause },
  ]);
});

test('site exposure update requires its explicit stages and ports', () => {
  assert.throws(
    () =>
      createSiteExposureUpdate({
        preparation: {},
        leases: {},
        sites: {},
        routes: {},
        versions: {},
        officeNet: {},
        policies: {},
        snapshots: {},
        audits: {},
        telemetry: {},
        clock: {},
      }),
    /preparation\.prepare is required/
  );
});
