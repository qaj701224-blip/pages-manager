import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteRouteSnapshots } from '../../infrastructure/route-snapshots/site-route-snapshots.js';
import {
  buildRouteSnapshot,
  clearRoutePointerIfCurrent,
  routePointerKey,
  routeSnapshotKey,
  writeRouteSnapshot,
} from '../../route-snapshot.js';
import { createDeleteSite } from './delete-site.js';
import { createTransferSiteOwner } from './transfer-owner.js';

const NOW = '2027-01-15T08:00:00.000Z';

test('owner transfer restores an older owner at P+2 after the first pointer write commits and throws', async () => {
  const previousSite = siteRecord();
  const initialRoute = activeRoute();
  const state = { site: previousSite, route: initialRoute };
  const snapshots = createAmbiguousSnapshotHarness();
  await snapshots.seed(previousSite, initialRoute);
  snapshots.failNextPointerWrite();

  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...authorizationMethods(state),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(siteCommitLease());
      },
      async getTeamMember() {
        return { role: 'publisher' };
      },
      async getRouteBySiteId() {
        return state.route;
      },
      async transferSiteOwner(_siteId, input) {
        assert.equal(input.expected.ownerId, state.site.ownerId);
        assert.equal(input.expectedRoute.policyVersion, state.route.policyVersion);
        state.site = {
          ...state.site,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          ownerUserId: input.ownerUserId,
        };
        state.route = {
          ...state.route,
          policyVersion: state.route.policyVersion + (input.bumpPolicyVersion ? 1 : 0),
        };
        return state.site;
      },
    },
    routeSnapshots: snapshots.adapter,
    clock: { now: () => NOW },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: previousSite,
      actor: { type: 'user', userId: 'usr_old' },
      target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_old' },
      compensateSnapshotFailure: true,
    }),
    (error) => error.code === 'ROUTE_POLICY_REPAIR_REQUIRED' && error.cause?.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );

  assert.equal(state.site.ownerType, 'user');
  assert.equal(state.site.ownerId, 'usr_old');
  assert.equal(state.route.policyVersion, initialRoute.policyVersion + 2);
  const { pointer, snapshot } = snapshots.current(initialRoute.hostname);
  assert.equal(pointer.policyVersion, initialRoute.policyVersion + 2);
  assert.equal(snapshot.ownerUserId, 'usr_old');
  assert.equal(snapshot.policyVersion, initialRoute.policyVersion + 2);
});

test('site delete restores an active route at G+2 after the first pointer write commits and throws', async () => {
  const previousSite = siteRecord();
  const initialRoute = activeRoute();
  const state = { site: previousSite, route: initialRoute };
  const snapshots = createAmbiguousSnapshotHarness();
  await snapshots.seed(previousSite, initialRoute);
  snapshots.failNextPointerWrite();

  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(state),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(siteCommitLease());
      },
      async getRouteBySiteId() {
        return state.route;
      },
      async listSiteHostnameClaims() {
        return [];
      },
      async deleteSite() {
        state.site = { ...state.site, deletedAt: NOW };
        state.route = {
          ...state.route,
          activeVersionId: null,
          workerName: null,
          runtime: 'disabled',
          dispatchType: null,
          routeGeneration: state.route.routeGeneration + 1,
          routeStatus: 'deleted',
        };
        return state.site;
      },
      async restoreSiteDeleteIfCurrent(_siteId, site, route, _claims, expectedRoute, _environment, lease) {
        assert.equal(expectedRoute, state.route);
        assert.deepEqual(lease, siteCommitLease());
        state.site = site;
        state.route = {
          ...route,
          routeGeneration: expectedRoute.routeGeneration + 1,
        };
        return state.route;
      },
    },
    routeSnapshots: snapshots.adapter,
    async enqueueDeletedResources() {
      assert.fail('cleanup must not run after a compensated snapshot failure');
    },
    events: {
      async siteDeleted() {
        assert.fail('delete event must not run after a compensated snapshot failure');
      },
    },
    clock: { now: () => NOW },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    remove({
      environment: 'production',
      site: previousSite,
      actor: { type: 'user', userId: 'usr_old' },
      compensateSnapshotFailure: true,
    }),
    (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );

  assert.equal(state.site.deletedAt, null);
  assert.equal(state.route.routeStatus, 'active');
  assert.equal(state.route.routeGeneration, initialRoute.routeGeneration + 2);
  const { pointer, snapshot } = snapshots.current(initialRoute.hostname);
  assert.equal(pointer.routeGeneration, initialRoute.routeGeneration + 2);
  assert.equal(snapshot.routeStatus, 'active');
  assert.equal(snapshot.activeVersionId, initialRoute.activeVersionId);
});

function createAmbiguousSnapshotHarness() {
  const records = new Map();
  let failNextPointer = false;
  const kv = {
    async get(key) {
      return records.get(key) || null;
    },
    async put(key, value) {
      records.set(key, value);
      if (failNextPointer && key.includes(':route_pointer:')) {
        failNextPointer = false;
        throw new Error('simulated response loss after pointer commit');
      }
    },
    async delete(key) {
      records.delete(key);
    },
  };
  const version = {
    id: 'version_1',
    contentHash: 'sha256:version-1',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    deploymentShape: 'worker-only',
    resolvedFallback: null,
    routingMode: 'worker-only',
  };
  const adapter = createSiteRouteSnapshots({
    store: {
      async getSiteVersion() {
        return version;
      },
      async listSiteAclEntries() {
        return [];
      },
    },
    buildSnapshot: buildRouteSnapshot,
    writeSnapshot: (snapshot) => writeRouteSnapshot(kv, snapshot),
    clearPointer: (pointer) =>
      clearRoutePointerIfCurrent(kv, {
        ...pointer,
        snapshotKey: routeSnapshotKey(
          pointer.environment,
          pointer.hostname,
          pointer.routeGeneration,
          pointer.policyVersion,
          pointer.siteId
        ),
      }),
  });

  return {
    adapter,
    async seed(site, route) {
      await writeRouteSnapshot(kv, buildRouteSnapshot({ site, route, version }));
    },
    failNextPointerWrite() {
      failNextPointer = true;
    },
    current(hostname) {
      const pointer = JSON.parse(records.get(routePointerKey('production', hostname)));
      return { pointer, snapshot: JSON.parse(records.get(pointer.snapshotKey)) };
    },
  };
}

function siteRecord() {
  return {
    id: 'site_1',
    slug: 'docs',
    dataNamespace: 'docs',
    siteUuid: 'uuid_1',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_old',
    ownerUserId: 'usr_old',
    defaultVisibility: 'org',
    deletedAt: null,
  };
}

function activeRoute() {
  return {
    id: 'route_1',
    hostname: 'docs.pages.xd.team',
    siteId: 'site_1',
    environment: 'production',
    runtime: 'wfp',
    executionProvider: 'wfp',
    workerName: 'pages-v2-docs-version-1',
    dispatchType: 'dispatch-namespace',
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: 'version_1',
    visibility: 'org',
    exposure: 'internal',
    policyVersion: 1,
    routeGeneration: 1,
    runtimeConfigGeneration: 0,
    routeStatus: 'active',
    cacheTier: 'fast',
    updatedAt: NOW,
  };
}

function authorizationMethods(state) {
  return {
    async getSite() {
      return state.site;
    },
    async getSiteForUser() {
      return state.site;
    },
    async getAccessKeyById() {
      return null;
    },
    async getUser(userId) {
      return { id: userId, employeeStatus: 'active' };
    },
    async getTeam(teamId) {
      return { id: teamId, environment: 'production', status: 'active', deletedAt: null };
    },
    async isPlatformAdmin() {
      return false;
    },
  };
}

function siteCommitLease() {
  return { lockId: 'lock_1', fencingToken: 1 };
}
