import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRouteSnapshot,
  clearRoutePointerIfCurrent,
  deleteDeploymentFailureRecoveryRecord,
  listDeploymentFailureRecoveryRecords,
  readRouteSnapshotState,
  repairRouteSnapshot,
  RoutePointerDO,
  writeDeploymentFailureRecoveryRecord,
  writeRouteSnapshot,
} from './route-snapshot.js';

test('builds immutable route snapshot from authority records', () => {
  const snapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1', ownerUserId: 'usr_owner', requiredSessionVersion: 4 },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'worker',
      executionProvider: 'normal-worker-slot',
      workerName: 'pages-v2-production-slot-007',
      dispatchType: 'service-binding',
      dispatchBindingName: 'SITE_SLOT_007',
      slotId: 'slot_007',
      activeVersionId: 'ver_1',
      visibility: 'org',
      policyVersion: 1,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_1',
      contentHash: 'sha256:abc',
      ...workerOnlyDecision(),
    },
    aclEntries: [{ effect: 'allow', subjectType: 'email', subjectValue: 'user@example.com' }],
  });

  assert.deepEqual(snapshot, {
    schemaVersion: 3,
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    siteUuid: 'uuid_1',
    slug: 'docs',
    ownerUserId: 'usr_owner',
    requiredSessionVersion: 4,
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    workerName: 'pages-v2-production-slot-007',
    dispatch: {
      type: 'service-binding',
      slotId: 'slot_007',
      bindingName: 'SITE_SLOT_007',
    },
    kv: {
      enabled: true,
      scopes: ['kv:get', 'kv:set', 'kv:delete', 'kv:list'],
    },
    activeVersionId: 'ver_1',
    contentHash: 'sha256:abc',
    deploymentShape: 'worker-only',
    resolvedFallback: null,
    routingMode: 'worker-only',
    exposure: 'internal',
    accessMode: 'org',
    visibility: 'org',
    policyVersion: 1,
    routeGeneration: 2,
    routeStatus: 'active',
    cacheTier: 'fast',
    acl: [{ effect: 'allow', subjectType: 'email', subjectValue: 'user@example.com' }],
  });
});

test('team-owned route snapshots do not publish the creator as owner', () => {
  const snapshot = buildRouteSnapshot({
    site: {
      id: 'site_team',
      slug: 'team-docs',
      siteUuid: 'uuid_team',
      ownerType: 'team',
      ownerId: 'team_1',
      ownerUserId: 'usr_creator',
    },
    route: {
      id: 'route_team',
      hostname: 'team-docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      activeVersionId: 'ver_team',
      visibility: 'acl',
      policyVersion: 1,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'sensitive',
    },
    version: {
      id: 'ver_team',
      contentHash: 'sha256:def',
      ...workerOnlyDecision(),
    },
  });

  assert.equal(snapshot.ownerUserId, null);
});

test('unknown legacy visibility cannot produce a route snapshot', () => {
  assert.throws(
    () =>
      buildRouteSnapshot({
        site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
        route: {
          id: 'route_1',
          hostname: 'docs.pages.xd.team',
          environment: 'production',
          runtime: 'wfp',
          visibility: 'public',
          policyVersion: 1,
          routeGeneration: 2,
          routeStatus: 'active',
          cacheTier: 'fast',
        },
      }),
    /SITE_POLICY_INVALID/,
  );
});

test('repairs a missing or lower pointer without changing the snapshot policy version', async () => {
  const writes = new Map();
  let putCount = 0;
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
      policyVersion: 3,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: { id: 'ver_1', contentHash: 'sha256:abc', ...workerOnlyDecision() },
  });
  const target = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => {
      putCount += 1;
      writes.set(key, JSON.parse(value));
    },
  };

  const repaired = await repairRouteSnapshot(target, snapshot);
  assert.equal(repaired.pointerConfirmed, true);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.snapshot.policyVersion, 3);
  assert.equal(putCount, 2);

  const exact = await repairRouteSnapshot(target, snapshot);
  assert.equal(exact.pointerConfirmed, true);
  assert.equal(exact.repaired, false);
  assert.equal(putCount, 2);
  assert.deepEqual((await readRouteSnapshotState(target, snapshot)).state, 'exact');
});

test('does not overwrite a pointer that is ahead of the authority snapshot', async () => {
  const writes = new Map([
    [
      'production:route_pointer:docs.pages.xd.team',
      {
        hostname: 'docs.pages.xd.team',
        environment: 'production',
        routeGeneration: 2,
        policyVersion: 4,
        snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:4',
      },
    ],
  ]);
  let putCount = 0;
  const snapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      visibility: 'org',
      policyVersion: 3,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
  });
  const result = await repairRouteSnapshot(
    {
      get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
      put: async () => {
        putCount += 1;
      },
    },
    snapshot,
  );
  assert.equal(result.state, 'ahead');
  assert.equal(result.pointerConfirmed, false);
  assert.equal(putCount, 0);
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
      contentHash: 'sha256:abc',
      ...workerOnlyDecision(),
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
      contentHash: 'sha256:abc',
      ...workerOnlyDecision(),
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
      contentHash: 'sha256:def',
      ...workerOnlyDecision(),
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
      contentHash: 'sha256:abc',
      ...workerOnlyDecision(),
    },
  });

  const latestResponse = await durableObject.fetch(writeRequest(latestSnapshot));
  const staleResponse = await durableObject.fetch(writeRequest(staleSnapshot));

  assert.equal(latestResponse.status, 200);
  assert.equal(staleResponse.status, 409);
  assert.equal(writes.get('production:route_pointer:docs.pages.xd.team').policyVersion, 3);
});

test('RoutePointerDO treats KV pointer write as the route commit point', async () => {
  const writes = new Map();
  const durableObject = new RoutePointerDO(createDoState({ failPut: true }), {
    ROUTE_SNAPSHOTS: {
      get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
      put: async (key, value) => writes.set(key, JSON.parse(value)),
    },
  });
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
      contentHash: 'sha256:abc',
      ...workerOnlyDecision(),
    },
  });

  const response = await durableObject.fetch(writeRequest(snapshot));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.pointerState, 'durable_state_write_failed_after_kv_commit');
  assert.equal(writes.get('production:route_pointer:docs.pages.xd.team').snapshotKey, body.pointer.snapshotKey);
  assert.equal(writes.get(body.pointer.snapshotKey).activeVersionId, 'ver_1');
});

test('RoutePointerDO conditionally clears the current pointer without deleting a newer writer result', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const writes = new Map([
    [
      pointerKey,
      {
        hostname: 'docs.pages.xd.team',
        environment: 'production',
        routeGeneration: 2,
        policyVersion: 3,
        snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:3',
      },
    ],
  ]);
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
    delete: async (key) => writes.delete(key),
  };
  const durableObject = new RoutePointerDO(createDoState(), { ROUTE_SNAPSHOTS: routeSnapshots });
  const target = {
    ROUTE_SNAPSHOTS: routeSnapshots,
    ROUTE_POINTER_LOCKS: {
      idFromName: () => 'docs-pointer',
      get: () => ({ fetch: (request) => durableObject.fetch(request) }),
    },
  };

  assert.equal(
    await clearRoutePointerIfCurrent(target, {
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      routeGeneration: 2,
      policyVersion: 3,
      snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:3',
    }),
    true
  );
  assert.equal(writes.has(pointerKey), false);

  writes.set(pointerKey, {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 4,
    snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:4',
  });
  assert.equal(
    await clearRoutePointerIfCurrent(target, {
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      routeGeneration: 2,
      policyVersion: 3,
      snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:3',
    }),
    false
  );
  assert.equal(writes.get(pointerKey).policyVersion, 4);
});

test('RoutePointerDO force-clears an ahead public pointer but preserves an ahead internal pointer', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const aheadPointer = {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 4,
    snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:4',
  };
  const writes = new Map([
    [pointerKey, aheadPointer],
    [aheadPointer.snapshotKey, { exposure: 'public' }],
  ]);
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
    delete: async (key) => writes.delete(key),
  };
  const durableObject = new RoutePointerDO(createDoState(), { ROUTE_SNAPSHOTS: routeSnapshots });
  const target = {
    ROUTE_SNAPSHOTS: routeSnapshots,
    ROUTE_POINTER_LOCKS: {
      idFromName: () => 'docs-pointer',
      get: () => ({ fetch: (request) => durableObject.fetch(request) }),
    },
  };
  const expectedPointer = {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 3,
    snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:3',
  };

  assert.equal(await clearRoutePointerIfCurrent(target, expectedPointer), true);
  assert.equal(writes.has(pointerKey), false);

  writes.set(pointerKey, aheadPointer);
  writes.set(aheadPointer.snapshotKey, { exposure: 'org' });
  assert.equal(await clearRoutePointerIfCurrent(target, expectedPointer), false);
  assert.deepEqual(writes.get(pointerKey), aheadPointer);
});

test('RoutePointerDO reports durable pointer cleanup failure after KV pointer removal', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const pointer = {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 3,
    snapshotKey: 'production:route_snapshot:docs.pages.xd.team:2:3',
  };
  const writes = new Map([[pointerKey, pointer]]);
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
    delete: async (key) => writes.delete(key),
  };
  const durableObject = new RoutePointerDO(createDoState({ failDelete: true }), { ROUTE_SNAPSHOTS: routeSnapshots });
  const response = await durableObject.fetch(
    writeClearRequest(pointer)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.cleared, true);
  assert.equal(body.pointerState, 'durable_state_delete_failed_after_kv_commit');
  assert.equal(writes.has(pointerKey), false);

  const repairSnapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-2',
      activeVersionId: 'ver_2',
      visibility: 'org',
      policyVersion: 4,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: { id: 'ver_2', contentHash: 'sha256:def', ...workerOnlyDecision() },
  });
  const repairResponse = await durableObject.fetch(writeRequest(repairSnapshot));
  assert.equal(repairResponse.status, 200);
});

test('RoutePointerDO stores deployment failure recovery records independently from route snapshot KV', async () => {
  const durableObject = new RoutePointerDO(createDoState(), {
    ROUTE_SNAPSHOTS: {
      put: async () => {
        throw new Error('route snapshot KV unavailable');
      },
    },
  });
  const target = {
    ROUTE_POINTER_LOCKS: {
      idFromName: () => 'docs-pointer',
      get: () => ({ fetch: (request) => durableObject.fetch(request) }),
    },
  };
  const scope = { environment: 'production', hostname: 'docs.pages.xd.team' };
  const value = JSON.stringify({ schemaVersion: 1, deploymentId: 'dep_1' });

  assert.equal(
    await writeDeploymentFailureRecoveryRecord(target, { ...scope, deploymentId: 'dep_1', value }),
    true
  );
  assert.deepEqual(await listDeploymentFailureRecoveryRecords(target, scope), [{ deploymentId: 'dep_1', value }]);
  assert.equal(await deleteDeploymentFailureRecoveryRecord(target, { ...scope, deploymentId: 'dep_1' }), true);
  assert.deepEqual(await listDeploymentFailureRecoveryRecords(target, scope), []);
});

function writeRequest(snapshot) {
  return new Request('https://route-pointer-do/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
}

function writeClearRequest(pointer) {
  return new Request('https://route-pointer-do/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  });
}

function createDoState({ failPut = false, failDelete = false } = {}) {
  const records = new Map();
  return {
    storage: {
      async get(key) {
        return records.get(key);
      },
      async put(key, value) {
        if (failPut) throw new Error('durable state write failed');
        records.set(key, value);
      },
      async delete(key) {
        if (failDelete) throw new Error('durable state delete failed');
        return records.delete(key);
      },
      async list({ prefix = '' } = {}) {
        return new Map([...records].filter(([key]) => typeof key === 'string' && key.startsWith(prefix)));
      },
    },
  };
}

function workerOnlyDecision() {
  return {
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
  };
}
