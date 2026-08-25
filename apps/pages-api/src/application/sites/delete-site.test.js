import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeleteSite } from './delete-site.js';

test('delete site use case clears retiring pointers before committing deletion', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  const deleted = { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
  const deletedRoute = { ...activeRoute(), routeStatus: 'inactive' };
  const retiringClaim = {
    hostname: 'old-demo.workers.xd.team',
    environment: 'production',
    ownerSystem: 'v2',
    ownerId: 'site_1',
    ownerRef: 'route_1',
    status: 'held',
    releaseReason: 'site_slug_renamed_pending_cleanup',
    reuseHoldUntil: null,
  };
  let routeReads = 0;
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(environment, siteId, callback, options) {
        assert.equal(environment, 'production');
        assert.equal(siteId, 'site_1');
        assert.deepEqual(options, { bestEffortRelease: true });
        calls.push('lock');
        return callback(siteCommitLease('lock_1', 1));
      },
      async listSiteHostnameClaims() {
        calls.push('claims');
        return [retiringClaim];
      },
      async getRouteBySiteId() {
        calls.push('route');
        routeReads += 1;
        return routeReads === 1 ? activeRoute() : deletedRoute;
      },
      async deleteSite(_siteId, input) {
        assert.deepEqual(input.lease, siteCommitLease('lock_1', 1));
        calls.push('delete');
        return deleted;
      },
    },
    routeSnapshots: {
      async refreshCurrent() {
        calls.push('snapshot');
      },
      async clearRetired(input) {
        assert.equal(input.claim, retiringClaim);
        calls.push('clear-retired');
        return true;
      },
      async clearCurrent() {
        calls.push('clear-current');
        return true;
      },
    },
    async enqueueDeletedResources() {
      calls.push('cleanup');
    },
    events: {
      async siteDeleted() {
        calls.push('event');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  const result = await remove({ environment: 'production', site, actor: { userId: 'usr_1' } });

  assert.equal(result.site, deleted);
  assert.equal(result.cleanupAfter, '2027-01-15T08:05:00.000Z');
  assert.deepEqual(calls, [
    'lock',
    'route',
    'claims',
    'clear-retired',
    'delete',
    'route',
    'snapshot',
    'clear-current',
    'cleanup',
    'event',
  ]);
});

test('delete site keeps the fail-closed deletion when canonical pointer cleanup is unavailable', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  let routeReads = 0;
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(_environment, _siteId, callback) {
        calls.push('lock');
        return callback(siteCommitLease('lock_1', 1));
      },
      async getRouteBySiteId() {
        routeReads += 1;
        return routeReads === 1 ? activeRoute() : { ...activeRoute(), routeGeneration: 2, routeStatus: 'deleted' };
      },
      async deleteSite() {
        calls.push('delete');
        return { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
      },
    },
    routeSnapshots: {
      async refreshCurrent() {
        calls.push('snapshot');
      },
      async clearCurrent() {
        calls.push('clear-current');
        throw new Error('pointer cleanup unavailable');
      },
    },
    async enqueueDeletedResources() {
      calls.push('cleanup');
    },
    events: {
      async siteDeleted() {
        calls.push('event');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  const result = await remove({ environment: 'production', site, actor: { userId: 'usr_1' } });

  assert.equal(result.site.deletedAt, '2027-01-15T08:00:00.000Z');
  assert.deepEqual(calls, ['lock', 'delete', 'snapshot', 'clear-current', 'cleanup', 'event']);
});

test('delete inactive site clears its canonical pointer before committing a finite hostname hold', async () => {
  const calls = [];
  const previousRoute = { ...activeRoute(), activeVersionId: null, routeStatus: 'inactive' };
  const deletedRoute = { ...previousRoute, routeGeneration: 2, routeStatus: 'deleted' };
  const site = { id: 'site_1', route: previousRoute };
  let routeReads = 0;
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(_environment, _siteId, callback) {
        calls.push('lock');
        return callback(siteCommitLease('lock_1', 1));
      },
      async getRouteBySiteId() {
        routeReads += 1;
        return routeReads === 1 ? previousRoute : deletedRoute;
      },
      async deleteSite() {
        calls.push('delete');
        return { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
      },
    },
    routeSnapshots: {
      async clearCurrent() {
        calls.push('clear-current');
        return true;
      },
      async refreshCurrent() {
        assert.fail('inactive routes do not need a post-commit snapshot after pointer cleanup');
      },
    },
    async enqueueDeletedResources() {
      calls.push('cleanup');
    },
    events: {
      async siteDeleted() {
        calls.push('event');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  const result = await remove({ environment: 'production', site, actor: { userId: 'usr_1' } });

  assert.equal(result.site.deletedAt, '2027-01-15T08:00:00.000Z');
  assert.deepEqual(calls, ['lock', 'clear-current', 'delete', 'cleanup', 'event']);
});

for (const [failure, clearCurrent] of [
  ['returns false', async () => false],
  [
    'throws',
    async () => {
      throw new Error('pointer cleanup unavailable');
    },
  ],
]) {
  test(`delete inactive site aborts before committing when pointer cleanup ${failure}`, async () => {
    const calls = [];
    const previousRoute = { ...activeRoute(), activeVersionId: null, routeStatus: 'disabled' };
    const site = { id: 'site_1', route: previousRoute };
    const remove = createDeleteSite({
      siteLifecycle: {
        ...authorizationMethods(site),
        async withSiteCommitLock(_environment, _siteId, callback) {
          calls.push('lock');
          return callback(siteCommitLease('lock_1', 1));
        },
        async getRouteBySiteId() {
          calls.push('route');
          return previousRoute;
        },
        async listSiteHostnameClaims() {
          calls.push('claims');
          return [];
        },
        async deleteSite() {
          assert.fail('delete must not commit before pointer cleanup is confirmed');
        },
      },
      routeSnapshots: {
        async clearCurrent() {
          calls.push('clear-current');
          return clearCurrent();
        },
        async refreshCurrent() {
          assert.fail('inactive pointer cleanup failures must not write a post-commit snapshot');
        },
      },
      async enqueueDeletedResources() {
        assert.fail('cleanup must not run when deletion is not committed');
      },
      events: {
        async siteDeleted() {
          assert.fail('event must not run when deletion is not committed');
        },
      },
      clock: { now: () => '2027-01-15T08:00:00.000Z' },
      reuseHoldSeconds: 300,
    });

    await assert.rejects(
      remove({ environment: 'production', site, actor: { userId: 'usr_1' } }),
      (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
    );
    assert.deepEqual(calls, ['lock', 'route', 'claims', 'clear-current']);
  });
}

test('delete site aborts before the authority commit when a retiring pointer cannot be cleared', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  const retiringClaim = {
    hostname: 'old-demo.workers.xd.team',
    environment: 'production',
    ownerSystem: 'v2',
    ownerId: 'site_1',
    ownerRef: 'route_1',
    status: 'held',
    releaseReason: 'site_slug_renamed_pending_cleanup',
    reuseHoldUntil: null,
  };
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(_environment, _siteId, callback) {
        calls.push('lock');
        return callback(siteCommitLease('lock_1', 1));
      },
      async getRouteBySiteId() {
        calls.push('route');
        return activeRoute();
      },
      async listSiteHostnameClaims() {
        calls.push('claims');
        return [retiringClaim];
      },
      async deleteSite() {
        assert.fail('delete must not commit while a retired hostname still routes');
      },
    },
    routeSnapshots: {
      async refreshCurrent() {
        assert.fail('deleted snapshot must not be written before retired cleanup succeeds');
      },
      async clearRetired() {
        calls.push('clear-retired');
        return false;
      },
    },
    async enqueueDeletedResources() {
      assert.fail('cleanup must not be queued');
    },
    events: {
      async siteDeleted() {
        assert.fail('delete event must not be emitted');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    remove({ environment: 'production', site, actor: { userId: 'usr_1' } }),
    (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );
  assert.deepEqual(calls, ['lock', 'route', 'claims', 'clear-retired']);
});

test('delete site rejects a team deactivated after the site read before external side effects', async () => {
  const calls = [];
  const site = authorizedSite({
    id: 'site_1',
    ownerType: 'team',
    ownerId: 'team_1',
    managementRole: 'publisher',
    route: activeRoute(),
  });
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(_environment, _siteId, callback) {
        calls.push('lock');
        return callback(siteCommitLease('lock_1', 1));
      },
      async getSiteForUser() {
        calls.push('site');
        return site;
      },
      async getTeam() {
        calls.push('team');
        return null;
      },
      async getRouteBySiteId() {
        assert.fail('route must not be read after the team becomes inactive');
      },
      async deleteSite() {
        assert.fail('delete must not commit after the team becomes inactive');
      },
    },
    routeSnapshots: {
      async refreshCurrent() {
        assert.fail('route snapshots must not change after the team becomes inactive');
      },
      async clearCurrent() {
        assert.fail('route pointers must not change after the team becomes inactive');
      },
      async clearRetired() {
        assert.fail('retired pointers must not change after the team becomes inactive');
      },
    },
    async enqueueDeletedResources() {
      assert.fail('cleanup must not run after the team becomes inactive');
    },
    events: {
      async siteDeleted() {
        assert.fail('events must not run after the team becomes inactive');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    remove({ environment: 'production', site, actor: { type: 'user', userId: 'usr_1' } }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.deepEqual(calls, ['lock', 'site', 'team']);
});

test('delete site rechecks an access key with a fresh clock immediately before committing', async () => {
  const currentSite = authorizedSite({ id: 'site_1', route: activeRoute() });
  const times = ['2027-01-15T08:00:00.000Z', '2027-01-15T08:00:02.000Z'];
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(currentSite),
      async getAccessKeyById() {
        return {
          id: 'ak_1',
          ownerType: 'user',
          ownerId: 'usr_1',
          ownerUserId: 'usr_1',
          scopes: ['deploy:site'],
          siteId: 'site_1',
          expiresAt: '2027-01-15T08:00:01.000Z',
        };
      },
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(siteCommitLease('lock_1', 1));
      },
      async getRouteBySiteId() {
        return activeRoute();
      },
      async deleteSite() {
        assert.fail('delete must not commit after the access key expires');
      },
    },
    routeSnapshots: {
      async refreshCurrent() {},
    },
    async enqueueDeletedResources() {
      assert.fail('cleanup must not run');
    },
    events: {
      async siteDeleted() {
        assert.fail('event must not run');
      },
    },
    clock: { now: () => times.shift() },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    remove({
      environment: 'production',
      site: currentSite,
      actor: {
        type: 'access_key',
        tokenId: 'ak_1',
        userId: 'usr_1',
        ownerType: 'user',
        ownerId: 'usr_1',
        scopes: ['deploy:site'],
        siteId: 'site_1',
      },
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.deepEqual(times, []);
});

test('delete site use case restores authority and skips post-commit work when snapshot fails', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  const deletedRoute = { ...activeRoute(), activeVersionId: null, routeGeneration: 2, routeStatus: 'deleted' };
  const restoredRoute = { ...activeRoute(), routeGeneration: 3 };
  let restored = false;
  let routeReads = 0;
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(siteCommitLease('lock_1', 1));
      },
      async getRouteBySiteId() {
        routeReads += 1;
        return routeReads === 1 ? activeRoute() : deletedRoute;
      },
      async getSite() {
        return restored ? authorizedSite(site) : { ...authorizedSite(site), deletedAt: '2027-01-15T08:00:00.000Z' };
      },
      async getHostnameClaim() {
        return { hostname: 'demo.workers.xd.team' };
      },
      async deleteSite() {
        return { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
      },
      async restoreSiteDeleteIfCurrent(...args) {
        calls.push(['restore', ...args]);
        restored = true;
        return restoredRoute;
      },
    },
    routeSnapshots: {
      async refreshCurrent(input) {
        calls.push(['snapshot', input]);
        if (input.route === deletedRoute) throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
      },
      async clearCurrent() {
        calls.push('clear-current');
      },
    },
    async enqueueDeletedResources() {
      assert.fail('cleanup must not run after snapshot failure');
    },
    events: {
      async siteDeleted() {
        assert.fail('event must not run after snapshot failure');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    remove({ environment: 'production', site, actor: { userId: 'usr_1' }, compensateSnapshotFailure: true }),
    (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['snapshot', 'restore', 'snapshot']
  );
  assert.deepEqual(calls[1].at(-1), siteCommitLease('lock_1', 1));
  assert.equal(calls[2][1].site.deletedAt, undefined);
  assert.equal(calls[2][1].route, restoredRoute);
});

test('delete site use case preserves a committed delete when snapshot compensation is disabled', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  let routeReads = 0;
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(siteCommitLease('lock_1', 1));
      },
      async getRouteBySiteId() {
        routeReads += 1;
        return routeReads === 1 ? activeRoute() : { ...activeRoute(), routeStatus: 'deleted' };
      },
      async deleteSite() {
        calls.push('delete');
        return { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
      },
      async restoreSiteDeleteIfCurrent() {
        assert.fail('restore must not run when compensation is disabled');
      },
    },
    routeSnapshots: {
      async refreshCurrent() {
        throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
      },
      async clearCurrent() {
        calls.push('clear-current');
        return true;
      },
    },
    async enqueueDeletedResources() {
      assert.fail('cleanup must not run after snapshot failure');
    },
    events: {
      async siteDeleted() {
        assert.fail('event must not run after snapshot failure');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    remove({ environment: 'production', site, actor: { userId: 'usr_1' }, compensateSnapshotFailure: false }),
    (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );
  assert.deepEqual(calls, ['delete', 'clear-current']);
});

for (const [failure, clearCurrent] of [
  ['returns false', async () => false],
  [
    'throws',
    async () => {
      throw new Error('pointer cleanup unavailable');
    },
  ],
]) {
  test(`delete site use case restores authority when snapshot write fails and pointer cleanup ${failure}`, async () => {
    const calls = [];
    const site = { id: 'site_1', route: activeRoute(), updatedAt: '2027-01-15T07:59:00.000Z' };
    const previousClaims = [{ hostname: 'demo.workers.xd.team', status: 'active' }];
    const deletedRoute = { ...activeRoute(), activeVersionId: null, routeGeneration: 2, routeStatus: 'deleted' };
    const restoredRoute = { ...activeRoute(), routeGeneration: 3 };
    let restored = false;
    let routeReads = 0;
    const remove = createDeleteSite({
      siteLifecycle: {
        ...authorizationMethods(site),
        async withSiteCommitLock(_environment, _siteId, callback) {
          return callback(siteCommitLease('lock_1', 1));
        },
        async getRouteBySiteId() {
          routeReads += 1;
          return routeReads === 1 ? activeRoute() : deletedRoute;
        },
        async getSite() {
          return restored ? authorizedSite(site) : { ...authorizedSite(site), deletedAt: '2027-01-15T08:00:00.000Z' };
        },
        async listSiteHostnameClaims() {
          return previousClaims;
        },
        async deleteSite() {
          calls.push('delete');
          return { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
        },
        async restoreSiteDeleteIfCurrent(...args) {
          calls.push(['restore', ...args]);
          restored = true;
          return restoredRoute;
        },
      },
      routeSnapshots: {
        async refreshCurrent(input) {
          calls.push(['snapshot', input]);
          if (input.route === deletedRoute) throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
        },
        async clearCurrent() {
          calls.push('clear-current');
          return clearCurrent();
        },
      },
      async enqueueDeletedResources() {
        assert.fail('cleanup must not run after snapshot failure');
      },
      events: {
        async siteDeleted() {
          assert.fail('event must not run after snapshot failure');
        },
      },
      clock: { now: () => '2027-01-15T08:00:00.000Z' },
      reuseHoldSeconds: 300,
    });

    await assert.rejects(
      remove({ environment: 'production', site, actor: { userId: 'usr_1' }, compensateSnapshotFailure: false }),
      (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
    );
    assert.deepEqual(
      calls.map((call) => (Array.isArray(call) ? call[0] : call)),
      ['delete', 'snapshot', 'clear-current', 'restore', 'snapshot']
    );
    assert.deepEqual(calls[3].slice(1), [
      'site_1',
      authorizedSite(site),
      activeRoute(),
      previousClaims,
      deletedRoute,
      'production',
      siteCommitLease('lock_1', 1),
    ]);
    assert.equal(calls[4][1].route, restoredRoute);
  });
}

test('delete site use case clears the restored pointer and requires repair when compensation snapshot fails', async () => {
  const site = authorizedSite({ id: 'site_1', route: activeRoute() });
  const deleted = { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
  const deletedRoute = { ...activeRoute(), activeVersionId: null, routeGeneration: 2, routeStatus: 'deleted' };
  const restoredRoute = { ...activeRoute(), routeGeneration: 3 };
  const routes = [activeRoute(), deletedRoute];
  let pointer = null;
  let restored = false;
  const clearInputs = [];
  const remove = createDeleteSite({
    siteLifecycle: {
      ...authorizationMethods(site),
      async withSiteCommitLock(_environment, _siteId, callback) {
        return callback(siteCommitLease('lock_1', 1));
      },
      async getRouteBySiteId() {
        return routes.shift();
      },
      async getSite() {
        return restored ? site : deleted;
      },
      async deleteSite() {
        return deleted;
      },
      async restoreSiteDeleteIfCurrent() {
        restored = true;
        return restoredRoute;
      },
    },
    routeSnapshots: {
      async refreshCurrent(input) {
        pointer = input;
        throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
      },
      async clearCurrent(input) {
        clearInputs.push(input);
        if (pointer?.route.routeGeneration <= input.route.routeGeneration) pointer = null;
        return pointer === null;
      },
    },
    async enqueueDeletedResources() {
      assert.fail('cleanup must not run after snapshot failure');
    },
    events: {
      async siteDeleted() {
        assert.fail('event must not run after snapshot failure');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    remove({ environment: 'production', site, actor: { userId: 'usr_1' }, compensateSnapshotFailure: true }),
    (error) => error.code === 'ROUTE_POLICY_REPAIR_REQUIRED'
  );
  assert.equal(clearInputs.length, 1);
  assert.equal(clearInputs[0].route, restoredRoute);
  assert.equal(pointer, null);
});

function activeRoute() {
  return {
    id: 'route_1',
    hostname: 'demo.workers.xd.team',
    environment: 'production',
    siteId: 'site_1',
    routeStatus: 'active',
    activeVersionId: 'version_1',
    routeGeneration: 1,
    policyVersion: 1,
    runtimeConfigGeneration: 0,
    visibility: 'org',
  };
}

function authorizationMethods(currentSite) {
  const authorized = authorizedSite(currentSite);
  return {
    async getSite() {
      return authorized;
    },
    async getSiteForUser() {
      return authorized;
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

function authorizedSite(currentSite) {
  return {
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    ...currentSite,
  };
}

function siteCommitLease(lockId, fencingToken) {
  return { lockId, fencingToken };
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
