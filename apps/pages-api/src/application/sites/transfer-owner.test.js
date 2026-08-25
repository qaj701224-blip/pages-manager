import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestPagesStore } from '../../../test-support/pages-store-fixture.js';
import { createSiteMetadataPort } from '../ports/site-metadata.js';
import { createSiteOwnershipPort } from '../ports/site-ownership.js';
import { createUpdateSiteMetadata } from './update-site-metadata.js';
import { createTransferSiteOwner } from './transfer-owner.js';

test('transfer owner use case locks, re-reads authority, and snapshots the committed site and route', async () => {
  const calls = [];
  const lease = { lockId: 'lock_1', fencingToken: 2 };
  const currentSite = {
    id: 'site_1',
    slug: 'guides',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_old',
    ownerUserId: 'usr_old',
  };
  const route = {
    id: 'route_1',
    hostname: 'guides.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    routeStatus: 'active',
    activeVersionId: 'version_1',
    routeGeneration: 3,
    policyVersion: 1,
    runtimeConfigGeneration: 0,
    visibility: 'org',
  };
  const committedRoute = { ...route, policyVersion: 2 };
  let routeReads = 0;
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...ownershipSupport(),
      async withSiteCommitLock(environment, siteId, callback, options) {
        calls.push(['lock', environment, siteId, options]);
        return callback(lease);
      },
      async getSiteForUser(siteId) {
        calls.push(['site', siteId]);
        return currentSite;
      },
      async transferSiteOwner(siteId, input, environment) {
        calls.push(['transfer', siteId, input, environment]);
        return { ...currentSite, ownerType: input.ownerType, ownerId: input.ownerId };
      },
      async getRouteBySiteId(siteId, environment) {
        calls.push(['route', siteId, environment]);
        routeReads += 1;
        return routeReads === 1 ? route : committedRoute;
      },
    },
    routeSnapshots: {
      async refreshActive(input) {
        calls.push(['snapshot', input]);
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  const result = await transfer({
    environment: 'production',
    site: { id: 'site_1', slug: 'docs', ownerType: 'user', ownerId: 'usr_old' },
    actor: { type: 'user', userId: 'usr_old' },
    target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_1' },
    buildAuditEvent: (updatedAt, site) => ({ id: 'audit_1', createdAt: updatedAt, siteSlug: site.slug }),
  });

  assert.equal(result.route, committedRoute);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['lock', 'site', 'route', 'transfer', 'route', 'snapshot']
  );
  assert.deepEqual(calls[0].slice(1), ['production', 'site_1', { bestEffortRelease: true }]);
  assert.deepEqual(calls[3][2].expected, { ownerType: 'user', ownerId: 'usr_old' });
  assert.equal(calls[3][2].bumpPolicyVersion, true);
  assert.equal(calls[3][2].lease, lease);
  assert.deepEqual(calls[3][2].auditEvent, {
    id: 'audit_1',
    createdAt: '2027-01-15T08:00:00.000Z',
    siteSlug: 'guides',
  });
  assert.equal(calls[5][1].site.slug, 'guides');
  assert.equal(calls[5][1].route, committedRoute);
});

test('transfer owner use case restores the previous owner with a newer policy snapshot after an ambiguous write', async () => {
  const lease = { lockId: 'lock_1', fencingToken: 2 };
  const transfers = [];
  const snapshots = [];
  const previousSite = {
    id: 'site_1',
    slug: 'guides',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_old',
    ownerUserId: 'usr_old',
    defaultVisibility: 'org',
  };
  const initialRoute = {
    id: 'route_1',
    hostname: 'guides.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    routeStatus: 'active',
    activeVersionId: 'version_1',
    routeGeneration: 3,
    policyVersion: 1,
    runtimeConfigGeneration: 0,
    visibility: 'org',
  };
  const committedRoute = { ...initialRoute, policyVersion: 2 };
  const restoredRoute = { ...initialRoute, policyVersion: 3 };
  let routeReads = 0;
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...ownershipSupport(),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(lease);
      },
      async getSiteForUser() {
        return previousSite;
      },
      async transferSiteOwner(siteId, input) {
        transfers.push(input);
        return { ...previousSite, id: siteId, ownerType: input.ownerType, ownerId: input.ownerId };
      },
      async getRouteBySiteId() {
        routeReads += 1;
        return [initialRoute, committedRoute, restoredRoute][routeReads - 1];
      },
    },
    routeSnapshots: {
      async refreshActive(input) {
        snapshots.push(input);
        if (snapshots.length === 1) throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: {
        id: 'site_1',
        slug: 'docs',
        ownerType: 'user',
        ownerId: 'usr_old',
        ownerUserId: 'usr_old',
        defaultVisibility: 'org',
      },
      actor: { type: 'user', userId: 'usr_old' },
      target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_1' },
      compensateSnapshotFailure: true,
    }),
    (error) => error.code === 'ROUTE_POLICY_REPAIR_REQUIRED' && error.cause?.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );
  assert.equal(transfers.length, 2);
  assert.equal(transfers[0].bumpPolicyVersion, true);
  assert.deepEqual(transfers[1], {
    ownerType: 'user',
    ownerId: 'usr_old',
    ownerUserId: 'usr_old',
    defaultVisibility: 'org',
    updatedAt: '2027-01-15T08:00:00.000Z',
    expected: { ownerType: 'team', ownerId: 'team_1' },
    expectedRoute: {
      id: 'route_1',
      routeGeneration: 3,
      policyVersion: 2,
      activeVersionId: 'version_1',
      runtimeConfigGeneration: 0,
      visibility: 'org',
    },
    bumpPolicyVersion: true,
    lease,
  });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].site.ownerId, 'team_1');
  assert.equal(snapshots[0].route.policyVersion, 2);
  assert.equal(snapshots[1].site.ownerId, 'usr_old');
  assert.equal(snapshots[1].route.policyVersion, 3);
});

test('transfer owner clears the restored pointer when its compensation snapshot fails', async () => {
  const lease = { lockId: 'lock_1', fencingToken: 2 };
  const previousSite = {
    id: 'site_1',
    slug: 'guides',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_old',
    ownerUserId: 'usr_old',
    defaultVisibility: 'org',
  };
  const initialRoute = {
    id: 'route_1',
    hostname: 'guides.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    routeStatus: 'active',
    activeVersionId: 'version_1',
    routeGeneration: 3,
    policyVersion: 1,
    runtimeConfigGeneration: 0,
    visibility: 'org',
  };
  const committedRoute = { ...initialRoute, policyVersion: 2 };
  const restoredRoute = { ...initialRoute, policyVersion: 3 };
  const routes = [initialRoute, committedRoute, restoredRoute];
  let pointer = null;
  const clearInputs = [];
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...ownershipSupport(),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(lease);
      },
      async getSiteForUser() {
        return previousSite;
      },
      async transferSiteOwner(siteId, input) {
        return { ...previousSite, id: siteId, ownerType: input.ownerType, ownerId: input.ownerId };
      },
      async getRouteBySiteId() {
        return routes.shift();
      },
    },
    routeSnapshots: {
      async refreshActive(input) {
        pointer = input;
        throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
      },
      async clearCurrent(input) {
        clearInputs.push(input);
        if (pointer?.route.policyVersion <= input.route.policyVersion) pointer = null;
        return pointer === null;
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: previousSite,
      actor: { type: 'user', userId: 'usr_old' },
      target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_old' },
      compensateSnapshotFailure: true,
    }),
    (error) => error.code === 'ROUTE_POLICY_REPAIR_REQUIRED'
  );
  assert.equal(clearInputs.length, 1);
  assert.equal(clearInputs[0].route, restoredRoute);
  assert.equal(pointer, null);
});

test('transfer owner clears the previous pointer when the committed route cannot be re-read', async () => {
  const previousSite = {
    id: 'site_1',
    slug: 'guides',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_old',
    ownerUserId: 'usr_old',
  };
  const route = {
    id: 'route_1',
    hostname: 'guides.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    routeStatus: 'active',
    activeVersionId: 'version_1',
    routeGeneration: 3,
    policyVersion: 1,
    runtimeConfigGeneration: 0,
    visibility: 'org',
  };
  let routeReads = 0;
  let clearInput = null;
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...ownershipSupport(),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback({ lockId: 'lock_1', fencingToken: 2 });
      },
      async getSiteForUser() {
        return previousSite;
      },
      async transferSiteOwner(siteId, input) {
        return { ...previousSite, id: siteId, ownerType: input.ownerType, ownerId: input.ownerId };
      },
      async getRouteBySiteId() {
        routeReads += 1;
        if (routeReads === 1) return route;
        throw new Error('authority read unavailable');
      },
    },
    routeSnapshots: {
      async refreshActive() {
        assert.fail('snapshot cannot be built without the committed route');
      },
      async clearCurrent(input) {
        clearInput = input;
        return true;
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: previousSite,
      actor: { type: 'user', userId: 'usr_old' },
      target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_old' },
    }),
    (error) => error.code === 'ROUTE_POLICY_REPAIR_REQUIRED'
  );
  assert.equal(clearInput.site.ownerId, 'team_1');
  assert.equal(clearInput.route.id, route.id);
  assert.equal(clearInput.route.routeGeneration, route.routeGeneration);
  assert.equal(clearInput.route.policyVersion, route.policyVersion + 1);
});

test('transfer owner use case rejects stale transport authority after entering the lock', async () => {
  let mutated = false;
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...ownershipSupport(),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback({ lockId: 'lock_1', fencingToken: 2 });
      },
      async getSiteForUser() {
        return {
          id: 'site_1',
          slug: 'docs',
          environment: 'production',
          ownerType: 'team',
          ownerId: 'team_current',
          ownerUserId: 'usr_current',
          managementRole: 'publisher',
        };
      },
      async transferSiteOwner() {
        mutated = true;
      },
      async getRouteBySiteId() {
        throw new Error('route must not be read');
      },
    },
    routeSnapshots: { async refreshActive() {} },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: { id: 'site_1', ownerType: 'user', ownerId: 'usr_old' },
      actor: { type: 'user', userId: 'usr_old' },
      target: { ownerType: 'team', ownerId: 'team_target', ownerUserId: 'usr_old' },
    }),
    (error) => error.code === 'SITE_POLICY_CONFLICT'
  );
  assert.equal(mutated, false);
});

test('transfer owner rejects the current owner inside the lock without mutating policy or snapshots', async () => {
  let mutated = false;
  let routeRead = false;
  let snapshotWritten = false;
  const currentSite = {
    id: 'site_1',
    slug: 'docs',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_owner',
    ownerUserId: 'usr_owner',
  };
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...ownershipSupport(),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback({ lockId: 'lock_1', fencingToken: 2 });
      },
      async getSiteForUser() {
        return currentSite;
      },
      async transferSiteOwner() {
        mutated = true;
      },
      async getRouteBySiteId() {
        routeRead = true;
      },
    },
    routeSnapshots: {
      async refreshActive() {
        snapshotWritten = true;
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: currentSite,
      actor: { type: 'user', userId: 'usr_owner' },
      target: { ownerType: 'user', ownerId: 'usr_owner', ownerUserId: 'usr_owner' },
    }),
    (error) => error.code === 'SITE_TRANSFER_INVALID'
  );
  assert.equal(mutated, false);
  assert.equal(routeRead, false);
  assert.equal(snapshotWritten, false);
});

test('transfer owner requires source team admin after entering the lock', async () => {
  let mutated = false;
  const currentSite = {
    id: 'site_1',
    slug: 'docs',
    environment: 'production',
    ownerType: 'team',
    ownerId: 'team_source',
    ownerUserId: 'usr_publisher',
    managementRole: 'publisher',
  };
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      ...ownershipSupport(),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback({ lockId: 'lock_1', fencingToken: 2 });
      },
      async getSiteForUser() {
        return currentSite;
      },
      async transferSiteOwner() {
        mutated = true;
      },
      async getRouteBySiteId() {
        assert.fail('route must not be read');
      },
    },
    routeSnapshots: { async refreshActive() {} },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: currentSite,
      actor: { type: 'user', userId: 'usr_publisher' },
      target: { ownerType: 'user', ownerId: 'usr_target', ownerUserId: 'usr_target' },
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.equal(mutated, false);
});

test('owner transfer lease prevents a slug rename from interleaving with snapshot refresh', { timeout: 3000 }, async () => {
  const now = '2027-01-15T08:00:00.000Z';
  const store = createTestPagesStore({ now: () => now });
  const original = await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_old',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
  await store.createUser({ userId: 'usr_old', email: 'old@example.com', employeeStatus: 'active' });
  await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_old',
  });
  await store.addTeamMember({
    teamId: 'team_1',
    userId: 'usr_old',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const snapshotEntered = deferred();
  const finishSnapshot = deferred();
  let snapshotInput = null;
  const transfer = createTransferSiteOwner({
    siteOwnership: createSiteOwnershipPort(store),
    routeSnapshots: {
      async refreshActive(input) {
        snapshotInput = input;
        snapshotEntered.resolve();
        await finishSnapshot.promise;
      },
    },
    clock: { now: () => now },
  });
  const rename = createUpdateSiteMetadata({
    siteMetadata: createSiteMetadataPort(store),
    routeSnapshots: {
      async repairCurrent() {},
      async clearRetired() {
        return true;
      },
    },
    hostnameForSlug: (slug) => `${slug}.pages.xd.team`,
    ids: { next: () => 'audit_metadata_1' },
    clock: { now: () => now },
    reuseHoldSeconds: 300,
  });

  const transferPromise = transfer({
    environment: 'production',
    site: original,
    actor: { type: 'user', userId: 'usr_old' },
    target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_old' },
  });
  await snapshotEntered.promise;

  const renameOutcome = await rename({
    environment: 'production',
    siteId: original.id,
    actor: { type: 'user', userId: 'usr_old' },
    patch: { slug: 'guides' },
  }).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  finishSnapshot.resolve();
  const transferred = await transferPromise;

  assert.equal(renameOutcome.error?.code, 'SITE_METADATA_CONFLICT');
  assert.equal(renameOutcome.value, undefined);
  assert.equal(snapshotInput.site.slug, 'docs');
  assert.equal(snapshotInput.site.ownerType, 'team');
  assert.equal(snapshotInput.site.ownerId, 'team_1');
  assert.equal(snapshotInput.route.hostname, 'docs.pages.xd.team');
  assert.equal(transferred.site.slug, 'docs');
  assert.equal((await store.getSite(original.id)).slug, 'docs');
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownershipSupport() {
  return {
    async getSite() {
      return null;
    },
    async getSiteForUser() {
      return null;
    },
    async getAccessKeyById() {
      return null;
    },
    async getUser(userId) {
      return { id: userId, employeeStatus: 'active' };
    },
    async isPlatformAdmin() {
      return false;
    },
    async getTeam(teamId) {
      return { id: teamId, environment: 'production', status: 'active', deletedAt: null };
    },
    async getTeamMember() {
      return { role: 'publisher' };
    },
  };
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
