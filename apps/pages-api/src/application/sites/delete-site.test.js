import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeleteSite } from './delete-site.js';

test('delete site use case commits deletion, snapshot, cleanup, and event in order', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  const deleted = { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
  const deletedRoute = { ...activeRoute(), routeStatus: 'inactive' };
  const remove = createDeleteSite({
    siteLifecycle: {
      async getRouteBySiteId() {
        calls.push('route');
        return deletedRoute;
      },
      async deleteSite() {
        calls.push('delete');
        return deleted;
      },
    },
    routeSnapshots: {
      async refreshCurrent() {
        calls.push('snapshot');
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
  assert.deepEqual(calls, ['delete', 'route', 'snapshot', 'cleanup', 'event']);
});

test('delete site use case restores authority and skips post-commit work when snapshot fails', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  const deletedRoute = { ...activeRoute(), routeStatus: 'inactive' };
  const remove = createDeleteSite({
    siteLifecycle: {
      async getRouteBySiteId() {
        return deletedRoute;
      },
      async getHostnameClaim() {
        return { hostname: 'demo.workers.xd.team' };
      },
      async deleteSite() {
        return { ...site, deletedAt: '2027-01-15T08:00:00.000Z' };
      },
      async restoreSiteDeleteIfCurrent(...args) {
        calls.push(['restore', ...args]);
      },
    },
    routeSnapshots: {
      async refreshCurrent() {
        throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'restore');
});

test('delete site use case preserves a committed delete when snapshot compensation is disabled', async () => {
  const calls = [];
  const site = { id: 'site_1', route: activeRoute() };
  const remove = createDeleteSite({
    siteLifecycle: {
      async getRouteBySiteId() {
        return { ...activeRoute(), routeStatus: 'deleted' };
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
  assert.deepEqual(calls, ['delete']);
});

function activeRoute() {
  return {
    id: 'route_1',
    hostname: 'demo.workers.xd.team',
    routeStatus: 'active',
    activeVersionId: 'version_1',
  };
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
