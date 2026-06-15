import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRouteSnapshot, RoutePointerDO, writeRouteSnapshot } from './route-snapshot.js';

test('builds immutable route snapshot from authority records', () => {
  const snapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1', ownerUserId: 'usr_owner', requiredSessionVersion: 4 },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-1',
      activeVersionId: 'ver_1',
      visibility: 'org',
      policyVersion: 1,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_1',
      artifactKind: 'worker',
      contentHash: 'sha256:abc',
    },
    aclEntries: [{ effect: 'allow', subjectType: 'user', subjectValue: 'usr_1' }],
  });

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    siteUuid: 'uuid_1',
    slug: 'docs',
    ownerUserId: 'usr_owner',
    requiredSessionVersion: 4,
    runtime: 'wfp',
    workerName: 'pages-v2-docs-ver-1',
    activeVersionId: 'ver_1',
    artifactKind: 'worker',
    contentHash: 'sha256:abc',
    visibility: 'org',
    policyVersion: 1,
    routeGeneration: 2,
    routeStatus: 'active',
    cacheTier: 'fast',
    acl: [{ effect: 'allow', subjectType: 'user', subjectValue: 'usr_1' }],
  });
});

test('writes immutable snapshot and pointer records', async () => {
  const writes = new Map();
  const snapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-1',
      activeVersionId: 'ver_1',
      visibility: 'org',
      policyVersion: 1,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_1',
      artifactKind: 'worker',
      contentHash: 'sha256:abc',
    },
  });

  await writeRouteSnapshot(
    {
      put: async (key, value) => writes.set(key, JSON.parse(value)),
    },
    snapshot
  );

  assert.equal(writes.get('production:route_snapshot:docs.pages.xd.team:2:1').activeVersionId, 'ver_1');
  assert.deepEqual(writes.get('production:route_pointer:docs.pages.xd.team'), {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 1,
    snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:1',
  });
});

test('does not overwrite a newer route pointer with a stale snapshot', async () => {
  const writes = new Map([
    [
      'production:route_pointer:docs.pages.xd.team',
      {
        hostname: 'docs.pages.xd.team',
        environment: 'production',
        routeGeneration: 2,
        policyVersion: 3,
        snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:3',
      },
    ],
  ]);
  const snapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-1',
      activeVersionId: 'ver_1',
      visibility: 'org',
      policyVersion: 2,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_1',
      artifactKind: 'worker',
      contentHash: 'sha256:abc',
    },
  });

  await assert.rejects(
    () =>
      writeRouteSnapshot(
        {
          get: async (key) => JSON.stringify(writes.get(key)),
          put: async (key, value) => writes.set(key, JSON.parse(value)),
        },
        snapshot
      ),
    /ROUTE_POINTER_STALE/
  );

  assert.deepEqual(writes.get('production:route_pointer:docs.pages.xd.team'), {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 3,
    snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:3',
  });
});

test('RoutePointerDO serializes pointer writes and rejects stale snapshots from durable state', async () => {
  const writes = new Map();
  const durableObject = new RoutePointerDO(createDoState(), {
    ROUTE_SNAPSHOTS: {
      get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
      put: async (key, value) => writes.set(key, JSON.parse(value)),
    },
  });
  const latestSnapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-2',
      activeVersionId: 'ver_2',
      visibility: 'org',
      policyVersion: 3,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_2',
      artifactKind: 'worker',
      contentHash: 'sha256:def',
    },
  });
  const staleSnapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      ...latestSnapshot,
      id: 'route_1',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-1',
      activeVersionId: 'ver_1',
      policyVersion: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_1',
      artifactKind: 'worker',
      contentHash: 'sha256:abc',
    },
  });

  const latestResponse = await durableObject.fetch(writeRequest(latestSnapshot));
  const staleResponse = await durableObject.fetch(writeRequest(staleSnapshot));

  assert.equal(latestResponse.status, 200);
  assert.equal(staleResponse.status, 409);
  assert.equal(writes.get('production:route_pointer:docs.pages.xd.team').policyVersion, 3);
});

function writeRequest(snapshot) {
  return new Request('https://route-pointer-do/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
}

function createDoState() {
  const records = new Map();
  return {
    storage: {
      async get(key) {
        return records.get(key);
      },
      async put(key, value) {
        records.set(key, value);
      },
    },
  };
}
