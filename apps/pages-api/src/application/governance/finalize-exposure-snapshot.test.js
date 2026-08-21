import assert from 'node:assert/strict';
import test from 'node:test';

import { createExposureSnapshotFinalization } from './finalize-exposure-snapshot.js';

const currentSite = { id: 'site_1', slug: 'example' };
const currentRoute = { id: 'route_1', exposure: 'internal', activeVersionId: 'ver_1' };
const committedSite = { ...currentSite, defaultExposure: 'public' };
const committedRoute = { ...currentRoute, exposure: 'public', policyVersion: 2 };
const restoredRoute = { ...currentRoute, policyVersion: 3 };
const version = { id: 'ver_1', workerName: 'worker_1' };
const mutation = { site: committedSite, route: committedRoute, aclEntries: [] };
const operation = {
  operationId: 'op_1',
  now: '2026-08-21T00:00:00.000Z',
  auditMetadata: { operationId: 'op_1', requestedExposure: 'public' },
};
const command = {
  environment: 'production',
  actorUserId: 'usr_admin',
  currentSite,
  currentRoute,
  currentExposure: 'internal',
  mutation,
  operation,
};

function createApplication(overrides = {}) {
  return createExposureSnapshotFinalization({
    snapshots: {
      commit: async () => ({ committed: true }),
      clearFailed: async () => null,
    },
    policies: { restore: async () => restoredRoute },
    sites: { get: async () => currentSite },
    routes: { get: async () => restoredRoute },
    versions: { get: async () => version },
    aclEntries: { list: async () => [] },
    audits: { record: async () => null },
    ...overrides,
  });
}

test('exposure snapshot finalization reads the committed version before writing the snapshot', async () => {
  const calls = [];
  const application = createApplication({
    versions: {
      async get(id, environment) {
        calls.push(['version', id, environment]);
        return version;
      },
    },
    snapshots: {
      async commit(input) {
        calls.push(['snapshot', input]);
        return { committed: true };
      },
      clearFailed: async () => assert.fail('successful snapshot must not clear a pointer'),
    },
  });

  assert.deepEqual(await application.finalize(command), {
    ok: true,
    site: committedSite,
    route: committedRoute,
  });
  assert.deepEqual(calls, [
    ['version', 'ver_1', 'production'],
    ['snapshot', { site: committedSite, route: committedRoute, environment: 'production' }],
  ]);
});

test('exposure snapshot finalization restores authority and writes a safe snapshot after commit failure', async () => {
  const calls = [];
  let snapshotCount = 0;
  const snapshotError = new Error('snapshot unavailable');
  const application = createApplication({
    snapshots: {
      async commit(input) {
        snapshotCount += 1;
        calls.push(['snapshot', input]);
        return snapshotCount === 1 ? { error: snapshotError } : { committed: true };
      },
      clearFailed: async () => assert.fail('successful compensation must not clear the pointer'),
    },
    policies: {
      async restore(input) {
        calls.push(['restore', input]);
        return restoredRoute;
      },
    },
    sites: {
      async get(id, environment) {
        calls.push(['site', id, environment]);
        return currentSite;
      },
    },
    routes: {
      async get(id, environment) {
        calls.push(['route', id, environment]);
        return restoredRoute;
      },
    },
    audits: { record: async (event) => calls.push(['audit', event.metadata.stage]) },
  });

  assert.deepEqual(await application.finalize(command), {
    ok: false,
    error: {
      reason: 'repair_required',
      cause: snapshotError,
      compensationStage: 'compensated_failure',
    },
  });
  assert.deepEqual(calls.map((call) => call[0]), ['snapshot', 'restore', 'site', 'snapshot', 'route', 'audit']);
  assert.deepEqual(calls[1][1], {
    siteId: 'site_1',
    currentSite,
    currentRoute,
    committedRoute,
    environment: 'production',
  });
});

test('exposure snapshot finalization clears a possibly committed pointer when compensation fails', async () => {
  const calls = [];
  const snapshotError = new Error('snapshot unavailable');
  const application = createApplication({
    snapshots: {
      commit: async () => ({ error: snapshotError }),
      async clearFailed(input) {
        calls.push(['clear', input]);
      },
    },
    policies: { restore: async () => Promise.reject(new Error('restore failed')) },
    routes: { get: async () => ({ ...committedRoute, exposure: 'public' }) },
    audits: { record: async (event) => calls.push(['audit', event.metadata]) },
  });

  assert.deepEqual(await application.finalize(command), {
    ok: false,
    error: {
      reason: 'repair_required',
      cause: snapshotError,
      compensationStage: 'compensation_failed',
    },
  });
  assert.deepEqual(calls[0], [
    'clear',
    { site: currentSite, route: committedRoute, version, aclEntries: [] },
  ]);
  assert.equal(calls[1][0], 'audit');
  assert.equal(calls[1][1].authorityExposure, 'public');
  assert.equal(calls[1][1].compensation, 'failed');
});

test('exposure snapshot finalization requires its narrow recovery ports', () => {
  assert.throws(
    () =>
      createExposureSnapshotFinalization({
        snapshots: {},
        policies: {},
        sites: {},
        routes: {},
        versions: {},
        aclEntries: {},
        audits: {},
      }),
    /snapshots\.commit is required/
  );
});
