import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteRouteSnapshots } from './site-route-snapshots.js';

test('deployment snapshot commit reloads site authority and ACL before writing', async () => {
  const calls = [];
  const latestSite = { id: 'site_1', slug: 'guide', requiredSessionVersion: 2 };
  const aclEntries = [{ effect: 'allow', subjectType: 'user', subjectValue: 'usr_2' }];
  const route = { id: 'route_1', activeVersionId: 'ver_2' };
  const version = { id: 'ver_2' };
  const snapshot = { routeId: 'route_1', activeVersionId: 'ver_2' };
  const routeSnapshots = createSiteRouteSnapshots({
    store: {
      async listSiteAclEntries(siteId) {
        calls.push(['listSiteAclEntries', siteId]);
        return aclEntries;
      },
      async getSite(siteId) {
        calls.push(['getSite', siteId]);
        return latestSite;
      },
    },
    buildSnapshot(input) {
      calls.push(['buildSnapshot', input]);
      return snapshot;
    },
    async writeSnapshot(input) {
      calls.push(['writeSnapshot', input]);
    },
  });

  assert.equal(
    await routeSnapshots.commitDeployment({ site: { id: 'site_1', slug: 'stale' }, route, version }),
    snapshot
  );
  assert.deepEqual(calls, [
    ['listSiteAclEntries', 'site_1'],
    ['getSite', 'site_1'],
    ['buildSnapshot', { site: latestSite, route, version, aclEntries }],
    ['writeSnapshot', snapshot],
  ]);
});

test('metadata repair confirms the canonical snapshot and clears a retired hostname by site identity', async () => {
  const calls = [];
  const site = { id: 'site_1', slug: 'guides' };
  const route = {
    id: 'route_1',
    hostname: 'guides.pages.xd.team',
    environment: 'production',
    activeVersionId: 'ver_2',
    routeGeneration: 3,
    policyVersion: 1,
  };
  const version = { id: 'ver_2' };
  const claim = {
    ownerSystem: 'v2',
    ownerId: 'site_1',
    ownerRef: 'route_1',
    environment: 'production',
    hostname: 'docs.pages.xd.team',
  };
  const routeSnapshots = createSiteRouteSnapshots({
    store: {
      async getSiteVersion(versionId, environment) {
        calls.push(['getSiteVersion', versionId, environment]);
        return version;
      },
      async listSiteAclEntries(siteId) {
        calls.push(['listSiteAclEntries', siteId]);
        return [];
      },
    },
    buildSnapshot(input) {
      calls.push(['buildSnapshot', input]);
      return { kind: 'serve' };
    },
    async writeSnapshot() {},
    async repairSnapshot(snapshot) {
      calls.push(['repairSnapshot', snapshot]);
      return { pointerConfirmed: true };
    },
    async clearPointer(pointer) {
      calls.push(['clearPointer', pointer]);
      return true;
    },
  });

  assert.deepEqual(
    await routeSnapshots.repairCurrent({ site, route, environment: 'production' }),
    { kind: 'serve' },
  );
  assert.equal(await routeSnapshots.clearRetired({ site, route, claim }), true);
  assert.equal(await routeSnapshots.clearCurrent({ site, route }), true);
  assert.deepEqual(calls, [
    ['getSiteVersion', 'ver_2', 'production'],
    ['listSiteAclEntries', 'site_1'],
    ['buildSnapshot', { site, route, version, aclEntries: [] }],
    ['repairSnapshot', { kind: 'serve' }],
    [
      'clearPointer',
      {
        hostname: 'docs.pages.xd.team',
        environment: 'production',
        routeGeneration: 3,
        policyVersion: 1,
        siteId: 'site_1',
        routeId: 'route_1',
      },
    ],
    [
      'clearPointer',
      {
        hostname: 'guides.pages.xd.team',
        environment: 'production',
        routeGeneration: 3,
        policyVersion: 1,
        siteId: 'site_1',
        routeId: 'route_1',
      },
    ],
  ]);
});

test('metadata repair rejects a pointer that cannot be confirmed', async () => {
  const routeSnapshots = createSiteRouteSnapshots({
    store: {
      async getSiteVersion() {
        return { id: 'ver_1' };
      },
      async listSiteAclEntries() {
        return [];
      },
    },
    buildSnapshot: () => ({ kind: 'serve' }),
    async writeSnapshot() {},
    async repairSnapshot() {
      return { pointerConfirmed: false };
    },
  });

  await assert.rejects(
    () =>
      routeSnapshots.repairCurrent({
        site: { id: 'site_1' },
        route: { activeVersionId: 'ver_1' },
        environment: 'production',
      }),
    /ROUTE_SNAPSHOT_WRITE_FAILED/,
  );
});
