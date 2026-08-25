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
    site: {
      id: 'site_1',
      slug: 'docs',
      dataNamespace: 'legacy-docs',
      siteUuid: 'uuid_1',
      ownerUserId: 'usr_owner',
      requiredSessionVersion: 4,
    },
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
    schemaVersion: 4,
    kind: 'serve',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    siteUuid: 'uuid_1',
    slug: 'docs',
    dataNamespace: 'legacy-docs',
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

test('does not repair an active pointer whose snapshot belongs to a different site', async () => {
  const writes = new Map();
  const target = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
  };
  const route = {
    id: 'route_new',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    runtime: 'wfp',
    workerName: 'pages-v2-docs-new',
    activeVersionId: 'ver_new',
    visibility: 'org',
    policyVersion: 1,
    routeGeneration: 1,
    routeStatus: 'active',
    cacheTier: 'fast',
  };
  const previous = buildRouteSnapshot({
    site: { id: 'site_previous', slug: 'docs', siteUuid: 'uuid_previous' },
    route: { ...route, id: 'route_previous', workerName: 'pages-v2-docs-previous', activeVersionId: 'ver_previous' },
    version: { id: 'ver_previous', contentHash: 'sha256:previous', ...workerOnlyDecision() },
  });
  const current = buildRouteSnapshot({
    site: { id: 'site_current', slug: 'docs', siteUuid: 'uuid_current' },
    route,
    version: { id: 'ver_new', contentHash: 'sha256:current', ...workerOnlyDecision() },
  });
  await writeRouteSnapshot(target, previous);

  await assert.rejects(() => repairRouteSnapshot(target, current), /ROUTE_POINTER_OWNER_CHANGED/);
  assert.equal(writes.get('production:route_pointer:docs.pages.xd.team').snapshotKey.includes('site_previous'), true);
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

  assert.equal(writes.get('production:route_snapshot:docs.pages.xd.team:site_1:2:1').activeVersionId, 'ver_1');
  assert.deepEqual(writes.get('production:route_pointer:docs.pages.xd.team'), {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 1,
    snapshotKey: 'production:route_snapshot:docs.pages.xd.team:site_1:2:1',
  });
});

test('keeps v4 snapshots immutable when a hostname is reused with the same route tuple', async () => {
  const writes = new Map();
  const target = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
  };
  const previous = buildRouteSnapshot({
    site: { id: 'site_previous', slug: 'docs', siteUuid: 'uuid_previous' },
    route: {
      id: 'route_previous',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-previous',
      activeVersionId: 'ver_previous',
      visibility: 'org',
      policyVersion: 1,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: { id: 'ver_previous', contentHash: 'sha256:previous', ...workerOnlyDecision() },
  });
  const replacement = {
    ...previous,
    siteId: 'site_replacement',
    siteUuid: 'uuid_replacement',
    routeId: 'route_replacement',
    workerName: 'pages-v2-docs-replacement',
    activeVersionId: 'ver_replacement',
    contentHash: 'sha256:replacement',
  };

  const previousWrite = await writeRouteSnapshot(target, previous);
  writes.delete('production:route_pointer:docs.pages.xd.team');
  const replacementWrite = await writeRouteSnapshot(target, replacement);

  assert.notEqual(previousWrite.snapshotKey, replacementWrite.snapshotKey);
  assert.equal(writes.get(previousWrite.snapshotKey).siteId, 'site_previous');
  assert.equal(writes.get(replacementWrite.snapshotKey).siteId, 'site_replacement');
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

test('route repair confirms durable pointer state before reporting the route ready', async () => {
  const writes = new Map();
  const durableRecords = new Map();
  let remainingPutFailures = 1;
  const state = {
    storage: {
      async get(key) {
        return durableRecords.get(key);
      },
      async put(key, value) {
        if (remainingPutFailures > 0) {
          remainingPutFailures -= 1;
          throw new Error('durable state write failed');
        }
        durableRecords.set(key, value);
      },
    },
  };
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
  };
  const durableObject = new RoutePointerDO(state, { ROUTE_SNAPSHOTS: routeSnapshots });
  const target = {
    ROUTE_SNAPSHOTS: routeSnapshots,
    ROUTE_POINTER_LOCKS: {
      idFromName: (name) => name,
      get: () => ({ fetch: (request) => durableObject.fetch(request) }),
    },
  };
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
    version: { id: 'ver_1', contentHash: 'sha256:abc', ...workerOnlyDecision() },
  });

  const pending = await repairRouteSnapshot(target, snapshot);

  assert.equal(pending.state, 'exact');
  assert.equal(pending.pointerConfirmed, false);
  assert.equal(durableRecords.has('pointer'), false);

  const ready = await repairRouteSnapshot(target, snapshot);

  assert.equal(ready.state, 'exact');
  assert.equal(ready.pointerConfirmed, true);
  assert.equal(durableRecords.get('pointer').siteId, 'site_1');
  assert.equal(durableRecords.get('pointer').routeId, 'route_1');
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

test('RoutePointerDO finishes pointer cleanup before publishing a replacement owner', async () => {
  const pointerKey = 'production:route_pointer:old-docs.pages.xd.team';
  const writes = new Map();
  let signalDeleteStarted;
  let releaseDelete;
  const deleteStarted = new Promise((resolve) => {
    signalDeleteStarted = resolve;
  });
  const deleteCanFinish = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  let blockPointerDelete = false;
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
    delete: async (key) => {
      if (blockPointerDelete && key === pointerKey) {
        signalDeleteStarted();
        await deleteCanFinish;
      }
      writes.delete(key);
    },
  };
  const durableObject = new RoutePointerDO(createDoState(), { ROUTE_SNAPSHOTS: routeSnapshots });
  const oldSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'old-docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 2,
    policyVersion: 1,
    routeStatus: 'active',
    runtime: 'wfp',
  };
  const replacementSnapshot = {
    ...oldSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 1,
  };

  assert.equal((await durableObject.fetch(writeRequest(oldSnapshot))).status, 200);
  blockPointerDelete = true;
  const clearPromise = durableObject.fetch(
    writeClearRequest({
      hostname: oldSnapshot.hostname,
      environment: oldSnapshot.environment,
      siteId: oldSnapshot.siteId,
      routeId: oldSnapshot.routeId,
      routeGeneration: 3,
      policyVersion: oldSnapshot.policyVersion,
      snapshotKey: 'production:route_snapshot:old-docs.pages.xd.team:site_old:3:1',
    }),
  );
  await deleteStarted;

  let replacementSettled = false;
  const replacementPromise = durableObject.fetch(writeRequest(replacementSnapshot)).then((response) => {
    replacementSettled = true;
    return response;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(replacementSettled, false);
  } finally {
    releaseDelete();
  }

  assert.equal((await clearPromise).status, 200);
  assert.equal((await replacementPromise).status, 200);
  assert.equal(writes.get(pointerKey).snapshotKey, 'production:route_snapshot:old-docs.pages.xd.team:site_new:1:1');
});

test('RoutePointerDO clears retired hostnames only for the expected site and route', async () => {
  const pointerKey = 'production:route_pointer:old-docs.pages.xd.team';
  const snapshotKey = 'production:route_snapshot:old-docs.pages.xd.team:2:3';
  const pointer = {
    hostname: 'old-docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 3,
    snapshotKey,
  };
  const snapshot = {
    schemaVersion: 3,
    hostname: pointer.hostname,
    environment: pointer.environment,
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: pointer.routeGeneration,
    policyVersion: pointer.policyVersion,
  };
  const writes = new Map([
    [pointerKey, pointer],
    [snapshotKey, snapshot],
  ]);
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    delete: async (key) => writes.delete(key),
  };
  const durableObject = new RoutePointerDO(createDoState(), { ROUTE_SNAPSHOTS: routeSnapshots });
  const target = {
    ROUTE_SNAPSHOTS: routeSnapshots,
    ROUTE_POINTER_LOCKS: {
      idFromName: () => 'old-docs-pointer',
      get: () => ({ fetch: (request) => durableObject.fetch(request) }),
    },
  };
  const expected = {
    ...pointer,
    routeGeneration: 3,
    siteId: 'site_expected',
    routeId: 'route_old',
  };

  assert.equal(await clearRoutePointerIfCurrent(target, expected), false);
  assert.equal(writes.has(pointerKey), true);

  assert.equal(await clearRoutePointerIfCurrent(target, { ...expected, siteId: 'site_old' }), true);
  assert.equal(writes.has(pointerKey), false);
  assert.equal(await clearRoutePointerIfCurrent(target, { ...expected, siteId: 'site_old' }), true);
});

test('RoutePointerDO fences delayed writes from a cleared route identity', async () => {
  const pointerKey = 'production:route_pointer:old-docs.pages.xd.team';
  const writes = new Map();
  const durableObject = new RoutePointerDO(createDoState(), {
    ROUTE_SNAPSHOTS: {
      get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
      put: async (key, value) => writes.set(key, JSON.parse(value)),
      delete: async (key) => writes.delete(key),
    },
  });
  const oldSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'old-docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 2,
    policyVersion: 1,
  };

  assert.equal((await durableObject.fetch(writeRequest(oldSnapshot))).status, 200);
  assert.equal(
    (
      await durableObject.fetch(
        writeClearRequest({
          hostname: oldSnapshot.hostname,
          environment: oldSnapshot.environment,
          siteId: oldSnapshot.siteId,
          routeId: oldSnapshot.routeId,
          routeGeneration: 3,
          policyVersion: 1,
          snapshotKey: 'production:route_snapshot:old-docs.pages.xd.team:3:1',
        }),
      )
    ).status,
    200,
  );
  assert.equal(writes.has(pointerKey), false);

  assert.equal((await durableObject.fetch(writeRequest(oldSnapshot))).status, 409);
  assert.equal(writes.has(pointerKey), false);

  const replacementSnapshot = {
    ...oldSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 1,
  };
  assert.equal((await durableObject.fetch(writeRequest(replacementSnapshot))).status, 200);
  assert.equal(writes.get(pointerKey).snapshotKey, 'production:route_snapshot:old-docs.pages.xd.team:site_new:1:1');

  assert.equal(
    (
      await durableObject.fetch(
        writeRequest({ ...oldSnapshot, routeGeneration: 4 }),
      )
    ).status,
    409,
  );
  assert.equal(writes.get(pointerKey).snapshotKey, 'production:route_snapshot:old-docs.pages.xd.team:site_new:1:1');
});

test('RoutePointerDO does not clear a missing KV pointer after durable ownership changed', async () => {
  const pointerKey = 'production:route_pointer:old-docs.pages.xd.team';
  const writes = new Map();
  const durableObject = new RoutePointerDO(createDoState(), {
    ROUTE_SNAPSHOTS: {
      get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
      put: async (key, value) => writes.set(key, JSON.parse(value)),
      delete: async (key) => writes.delete(key),
    },
  });
  const deletedSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'old-docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 3,
    policyVersion: 1,
    routeStatus: 'deleted',
    runtime: 'disabled',
  };
  const replacementSnapshot = {
    ...deletedSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 1,
    routeStatus: 'active',
    runtime: 'wfp',
  };

  assert.equal((await durableObject.fetch(writeRequest(deletedSnapshot))).status, 200);
  assert.equal((await durableObject.fetch(writeRequest(replacementSnapshot))).status, 200);
  writes.delete(pointerKey);

  const clearResponse = await durableObject.fetch(
    writeClearRequest({
      hostname: deletedSnapshot.hostname,
      environment: deletedSnapshot.environment,
      siteId: deletedSnapshot.siteId,
      routeId: deletedSnapshot.routeId,
      routeGeneration: deletedSnapshot.routeGeneration,
      policyVersion: deletedSnapshot.policyVersion,
      snapshotKey: 'production:route_snapshot:old-docs.pages.xd.team:site_old:3:1',
    }),
  );

  assert.equal(clearResponse.status, 409);
  assert.deepEqual(await clearResponse.json(), { cleared: false, reason: 'POINTER_STATE_CHANGED' });
  assert.equal((await durableObject.fetch(writeRequest({ ...deletedSnapshot, routeGeneration: 4 }))).status, 409);
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

test('RoutePointerDO keeps the route tombstone when KV pointer cleanup must be retried', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const snapshotKey = 'production:route_snapshot:docs.pages.xd.team:2:3';
  const pointer = {
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 3,
    snapshotKey,
  };
  const snapshot = {
    schemaVersion: 4,
    kind: 'serve',
    ...pointer,
    siteId: 'site_1',
    routeId: 'route_1',
  };
  const writes = new Map([
    [pointerKey, pointer],
    [snapshotKey, snapshot],
  ]);
  let pointerDeleteFails = true;
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
    delete: async (key) => {
      if (pointerDeleteFails) throw new Error('route snapshot KV unavailable');
      writes.delete(key);
    },
  };
  const durableObject = new RoutePointerDO(createDoState(), { ROUTE_SNAPSHOTS: routeSnapshots });
  const expectedPointer = { ...pointer, siteId: snapshot.siteId, routeId: snapshot.routeId };
  const response = await durableObject.fetch(
    writeClearRequest(expectedPointer)
  );

  assert.equal(response.status, 409);
  assert.equal(writes.has(pointerKey), true);
  assert.equal((await durableObject.fetch(writeRequest(snapshot))).status, 409);

  pointerDeleteFails = false;
  assert.equal((await durableObject.fetch(writeClearRequest(expectedPointer))).status, 200);
  assert.equal(writes.has(pointerKey), false);
});

test('RoutePointerDO allows a new owner to replace a deleted snapshot when pointer cleanup never reached the DO', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const writes = new Map();
  const durableObject = new RoutePointerDO(createDoState(), {
    ROUTE_SNAPSHOTS: {
      get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
      put: async (key, value) => writes.set(key, JSON.parse(value)),
      delete: async (key) => writes.delete(key),
    },
  });
  const activeSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 2,
    policyVersion: 1,
    routeStatus: 'active',
    runtime: 'wfp',
  };
  const deletedSnapshot = {
    ...activeSnapshot,
    routeGeneration: 3,
    routeStatus: 'deleted',
    runtime: 'disabled',
  };
  const replacementSnapshot = {
    ...activeSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 1,
  };

  assert.equal((await durableObject.fetch(writeRequest(activeSnapshot))).status, 200);
  assert.equal((await durableObject.fetch(writeRequest({ ...replacementSnapshot, routeGeneration: 4 }))).status, 409);
  assert.equal((await durableObject.fetch(writeRequest(deletedSnapshot))).status, 200);

  assert.equal((await durableObject.fetch(writeRequest(replacementSnapshot))).status, 200);
  assert.equal(writes.get(pointerKey).snapshotKey, 'production:route_snapshot:docs.pages.xd.team:site_new:1:1');
  assert.equal((await durableObject.fetch(writeRequest({ ...deletedSnapshot, routeGeneration: 4 }))).status, 409);
});

test('RoutePointerDO persists a new owner fence before publishing its KV pointer', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const writes = new Map();
  const durableRecords = new Map();
  let failNextDurablePut = false;
  const state = {
    storage: {
      async get(key) {
        return durableRecords.get(key);
      },
      async put(key, value) {
        if (failNextDurablePut) {
          failNextDurablePut = false;
          throw new Error('durable state write failed');
        }
        durableRecords.set(key, value);
      },
    },
  };
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
  };
  const durableObject = new RoutePointerDO(state, { ROUTE_SNAPSHOTS: routeSnapshots });
  const deletedSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 3,
    policyVersion: 1,
    routeStatus: 'deleted',
    runtime: 'disabled',
  };
  const replacementSnapshot = {
    ...deletedSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 1,
    routeStatus: 'active',
    runtime: 'wfp',
  };

  assert.equal((await durableObject.fetch(writeRequest(deletedSnapshot))).status, 200);
  const oldPointer = writes.get(pointerKey);

  failNextDurablePut = true;
  const failedReplacement = await durableObject.fetch(writeRequest(replacementSnapshot));

  assert.equal(failedReplacement.status, 409);
  assert.deepEqual(writes.get(pointerKey), oldPointer);
  assert.equal(durableRecords.get('pointer').siteId, 'site_old');

  assert.equal((await durableObject.fetch(writeRequest(replacementSnapshot))).status, 200);
  assert.equal(durableRecords.get('pointer').siteId, 'site_new');
  assert.equal(writes.get(pointerKey).snapshotKey, 'production:route_snapshot:docs.pages.xd.team:site_new:1:1');
  assert.equal((await durableObject.fetch(writeRequest({ ...deletedSnapshot, routeGeneration: 4 }))).status, 409);
});

test('RoutePointerDO retries a fenced owner replacement after its KV write fails', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const writes = new Map();
  const durableRecords = new Map();
  let failReplacementSnapshotPut = false;
  const state = {
    storage: {
      async get(key) {
        return durableRecords.get(key);
      },
      async put(key, value) {
        durableRecords.set(key, value);
      },
    },
  };
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => {
      if (failReplacementSnapshotPut && key.includes(':site_new:')) {
        failReplacementSnapshotPut = false;
        throw new Error('route snapshot KV unavailable');
      }
      writes.set(key, JSON.parse(value));
    },
  };
  const durableObject = new RoutePointerDO(state, { ROUTE_SNAPSHOTS: routeSnapshots });
  const deletedSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 3,
    policyVersion: 1,
    routeStatus: 'deleted',
    runtime: 'disabled',
  };
  const replacementSnapshot = {
    ...deletedSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 2,
    routeStatus: 'active',
    runtime: 'wfp',
  };

  assert.equal((await durableObject.fetch(writeRequest(deletedSnapshot))).status, 200);
  const deletedPointer = writes.get(pointerKey);

  failReplacementSnapshotPut = true;
  assert.equal((await durableObject.fetch(writeRequest(replacementSnapshot))).status, 409);
  assert.equal(durableRecords.get('pointer').siteId, 'site_new');
  assert.deepEqual(writes.get(pointerKey), deletedPointer);

  const staleReplacement = await durableObject.fetch(
    writeRequest({ ...replacementSnapshot, routeGeneration: 1 }),
  );
  assert.equal(staleReplacement.status, 409);
  assert.deepEqual(writes.get(pointerKey), deletedPointer);

  assert.equal((await durableObject.fetch(writeRequest(replacementSnapshot))).status, 200);
  assert.equal(writes.get(pointerKey).snapshotKey, 'production:route_snapshot:docs.pages.xd.team:site_new:2:1');
  assert.equal((await durableObject.fetch(writeRequest({ ...deletedSnapshot, routeGeneration: 4 }))).status, 409);
});

test('route repair lets a new owner replace an ahead deleted pointer after the reuse hold', async () => {
  const pointerKey = 'production:route_pointer:docs.pages.xd.team';
  const writes = new Map();
  const durableObject = new RoutePointerDO(createDoState(), {
    ROUTE_SNAPSHOTS: {
      get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
      put: async (key, value) => writes.set(key, JSON.parse(value)),
      delete: async (key) => writes.delete(key),
    },
  });
  const target = {
    ROUTE_SNAPSHOTS: durableObject.env.ROUTE_SNAPSHOTS,
    ROUTE_POINTER_LOCKS: {
      idFromName: () => 'docs-pointer',
      get: () => ({ fetch: (request) => durableObject.fetch(request) }),
    },
  };
  const deletedSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 3,
    policyVersion: 1,
    routeStatus: 'deleted',
    runtime: 'disabled',
  };
  const replacementSnapshot = {
    ...deletedSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 1,
    routeStatus: 'active',
    runtime: 'wfp',
  };

  assert.equal((await durableObject.fetch(writeRequest(deletedSnapshot))).status, 200);
  const repaired = await repairRouteSnapshot(target, replacementSnapshot);

  assert.equal(repaired.pointerConfirmed, true);
  assert.equal(repaired.repaired, true);
  assert.equal(writes.get(pointerKey).snapshotKey, 'production:route_snapshot:docs.pages.xd.team:site_new:1:1');
  assert.equal((await durableObject.fetch(writeRequest({ ...deletedSnapshot, routeGeneration: 4 }))).status, 409);
});

test('route repair heals a historical replacement pointer without letting the old owner reclaim KV', async () => {
  const writes = new Map();
  const durableRecords = new Map();
  const state = {
    storage: {
      async get(key) {
        return durableRecords.get(key);
      },
      async put(key, value) {
        durableRecords.set(key, value);
      },
    },
  };
  const routeSnapshots = {
    get: async (key) => (writes.has(key) ? JSON.stringify(writes.get(key)) : null),
    put: async (key, value) => writes.set(key, JSON.parse(value)),
    delete: async (key) => writes.delete(key),
  };
  const durableObject = new RoutePointerDO(state, { ROUTE_SNAPSHOTS: routeSnapshots });
  const target = {
    ROUTE_SNAPSHOTS: routeSnapshots,
    ROUTE_POINTER_LOCKS: {
      idFromName: () => 'docs-pointer',
      get: () => ({ fetch: (request) => durableObject.fetch(request) }),
    },
  };
  const deletedSnapshot = {
    schemaVersion: 4,
    kind: 'serve',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_old',
    routeId: 'route_old',
    routeGeneration: 3,
    policyVersion: 1,
    routeStatus: 'deleted',
    runtime: 'disabled',
  };
  const replacementSnapshot = {
    ...deletedSnapshot,
    siteId: 'site_new',
    routeId: 'route_new',
    routeGeneration: 1,
    routeStatus: 'active',
    runtime: 'wfp',
  };

  assert.equal((await durableObject.fetch(writeRequest(deletedSnapshot))).status, 200);
  const replacementKey = 'production:route_snapshot:docs.pages.xd.team:site_new:1:1';
  writes.set(replacementKey, replacementSnapshot);
  writes.set('production:route_pointer:docs.pages.xd.team', {
    hostname: replacementSnapshot.hostname,
    environment: replacementSnapshot.environment,
    routeGeneration: replacementSnapshot.routeGeneration,
    policyVersion: replacementSnapshot.policyVersion,
    snapshotKey: replacementKey,
  });
  assert.equal(durableRecords.get('pointer').siteId, 'site_old');

  const delayedOldWrite = await durableObject.fetch(writeRequest({ ...deletedSnapshot, routeGeneration: 4 }));

  assert.equal(delayedOldWrite.status, 409);
  assert.equal(writes.get('production:route_pointer:docs.pages.xd.team').snapshotKey, replacementKey);

  const repaired = await repairRouteSnapshot(target, replacementSnapshot);

  assert.equal(repaired.pointerConfirmed, true);
  assert.equal(durableRecords.get('pointer').siteId, 'site_new');
  assert.equal(durableRecords.get('pointer').routeId, 'route_new');
  assert.equal((await durableObject.fetch(writeRequest({ ...deletedSnapshot, routeGeneration: 4 }))).status, 409);
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

function createDoState({ failPut = false } = {}) {
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
