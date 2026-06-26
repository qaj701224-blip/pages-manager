import assert from 'node:assert/strict';
import test from 'node:test';

import { D1PagesStore, createHostnameClaim } from './store.js';
import { createTestPagesStore } from './test-store.js';

test('test store enforces unique site slug per environment', async () => {
  const store = createSeededStore();

  await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });

  await assert.rejects(
    () =>
      store.createSite({
        id: 'site_2',
        slug: 'docs',
        ownerUserId: 'usr_1',
        siteUuid: 'uuid_2',
        defaultVisibility: 'org',
        environment: 'production',
        routeId: 'route_2',
        hostname: 'docs-2.pages.xd.team',
      }),
    /SITE_SLUG_CONFLICT/
  );

  const stagingSite = await store.createSite({
    id: 'site_3',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_3',
    defaultVisibility: 'org',
    environment: 'staging',
    routeId: 'route_3',
    hostname: 'docs-staging.pages.xd.team',
  });

  assert.equal(stagingSite.id, 'site_3');
});

test('createSite creates owner membership and inactive route authority record', async () => {
  const store = createSeededStore();

  await store.createSite({
    id: 'site_1',
    slug: 'portal',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'portal.pages.xd.team',
  });

  assert.deepEqual(await store.listSiteMembers('site_1'), [
    {
      siteId: 'site_1',
      userId: 'usr_1',
      role: 'owner',
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(await store.getRouteBySiteId('site_1'), {
    id: 'route_1',
    hostname: 'portal.pages.xd.team',
    siteId: 'site_1',
    environment: 'production',
    runtime: 'disabled',
    executionProvider: null,
    workerName: null,
    dispatchType: null,
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: null,
    visibility: 'acl',
    policyVersion: 1,
    routeGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: 'sensitive',
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
});

test('createSite writes hostname claim in the same authority operation', async () => {
  const store = createSeededStore();

  await store.createSite({
    id: 'site_1',
    slug: 'portal',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'portal.pages.xd.team',
  });

  assert.deepEqual(await store.getHostnameClaim('portal.pages.xd.team'), {
    id: 'claim_route_1',
    environment: 'production',
    hostname: 'portal.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'site_1',
    ownerRef: 'route_1',
    status: 'active',
    source: 'v2_create',
    acquiredAt: '2026-06-15T00:00:00.000Z',
    leaseExpiresAt: null,
    releasedAt: null,
    reuseHoldUntil: null,
    releaseReason: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
});

test('createSite rejects v2 create when hostname claim is held by another owner', async () => {
  const store = createSeededStore();
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.workers.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:portal',
    ownerRef: 'pages-portal',
    source: 'backfill_v1_sites',
  });

  await assert.rejects(
    () =>
      store.createSite({
        id: 'site_1',
        slug: 'portal',
        ownerUserId: 'usr_1',
        siteUuid: 'uuid_1',
        defaultVisibility: 'acl',
        environment: 'production',
        routeId: 'route_1',
        hostname: 'portal.pages.xd.team',
      }),
    /HOSTNAME_CLAIM_CONFLICT/
  );

  assert.equal(await store.getRouteBySiteId('site_1'), null);
  assert.equal(await store.getSite('site_1'), null);
  assert.deepEqual(await store.listSiteMembers('site_1'), []);
});

test('createSite revives expired hostname delete hold when recreating same slug', async () => {
  let now = '2026-06-15T00:00:00.000Z';
  const store = createSeededStore({ now: () => now });

  await store.createSite({
    id: 'site_1',
    slug: 'portal',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'portal.workers.xd.team',
  });
  await store.deleteSite(
    'site_1',
    {
      deletedAt: '2026-06-15T00:01:00.000Z',
      reuseHoldUntil: '2026-06-15T00:06:00.000Z',
    },
    'production'
  );

  await assert.rejects(
    () =>
      store.createSite({
        id: 'site_2',
        slug: 'portal',
        ownerUserId: 'usr_1',
        siteUuid: 'uuid_2',
        defaultVisibility: 'acl',
        environment: 'production',
        routeId: 'route_2',
        hostname: 'portal.workers.xd.team',
      }),
    /HOSTNAME_CLAIM_CONFLICT/
  );

  now = '2026-06-15T00:06:01.000Z';
  const site = await store.createSite({
    id: 'site_2',
    slug: 'portal',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_2',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'portal.workers.xd.team',
  });
  const claim = await store.getHostnameClaim('portal.workers.xd.team');

  assert.equal(site.id, 'site_2');
  assert.equal(claim.id, 'claim_route_1');
  assert.equal(claim.status, 'active');
  assert.equal(claim.ownerId, 'site_2');
  assert.equal(claim.ownerRef, 'route_2');
  assert.equal(claim.reuseHoldUntil, null);
  assert.equal(claim.releaseReason, null);
});

test('hostname claim lifecycle confirms pending claims and allows released claims to be acquired again', async () => {
  const store = createSeededStore();
  const claim = {
    environment: 'production',
    hostname: 'portal.workers.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:portal',
    ownerRef: 'pages-portal',
    source: 'v1_deploy',
    status: 'pending',
  };

  const acquired = await store.acquireHostnameClaim(claim);
  const confirmed = await store.confirmHostnameClaim(claim);

  assert.equal(acquired.ok, true);
  assert.equal(confirmed.ok, true);
  assert.equal((await store.getHostnameClaim(claim.hostname)).status, 'active');

  const failedClaim = { ...claim, hostname: 'retry.workers.xd.team', normalizedSlug: 'retry', ownerId: 'v1:production:retry' };
  await store.acquireHostnameClaim(failedClaim);
  const released = await store.releaseHostnameClaim({ ...failedClaim, releaseReason: 'v1_deploy_failed' });
  const reacquired = await store.acquireHostnameClaim({ ...failedClaim, ownerId: 'v1:production:retry-2' });

  assert.equal(released.ok, true);
  assert.equal(reacquired.ok, true);
  assert.equal(reacquired.claim.status, 'pending');
  assert.equal(reacquired.claim.ownerId, 'v1:production:retry-2');
});

test('hostname claim delete hold blocks reuse until reuse_hold_until expires', async () => {
  let now = '2026-06-15T00:00:00.000Z';
  const store = createSeededStore({ now: () => now });
  const claim = {
    environment: 'production',
    hostname: 'portal.workers.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'workers',
    ownerSystem: 'v2',
    ownerId: 'site_1',
    ownerRef: 'route_1',
    source: 'v2_create',
  };

  await store.acquireHostnameClaim(claim);
  const held = await store.releaseHostnameClaim({
    ...claim,
    releaseReason: 'site_deleted',
    reuseHoldUntil: '2026-06-15T00:05:00.000Z',
  });
  const blocked = await store.acquireHostnameClaim({
    ...claim,
    ownerId: 'site_2',
    ownerRef: 'route_2',
  });
  now = '2026-06-15T00:05:01.000Z';
  const reacquired = await store.acquireHostnameClaim({
    ...claim,
    ownerId: 'site_2',
    ownerRef: 'route_2',
  });

  assert.equal(held.ok, true);
  assert.equal(held.claim.status, 'held');
  assert.equal(held.claim.reuseHoldUntil, '2026-06-15T00:05:00.000Z');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(reacquired.ok, true);
  assert.equal(reacquired.claim.status, 'active');
  assert.equal(reacquired.claim.ownerId, 'site_2');
  assert.equal(reacquired.claim.reuseHoldUntil, null);
});

test('hostname claim rejects slug conflicts even when hostname differs', async () => {
  const store = createSeededStore();
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.workers.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:portal',
    source: 'v1_deploy',
  });

  const result = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'site_portal',
    source: 'v2_create',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(result.claim.ownerSystem, 'v1');
});

test('hostname claim allows legacy v1/v2 same-owner coexistence and blocks third owners', async () => {
  const store = createSeededStore();
  const v1 = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.workers.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'owner_a',
    source: 'v1_deploy',
  });
  const v2 = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'owner_a',
    source: 'v2_create',
  });
  const third = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal-preview.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'owner_b',
    source: 'v2_create',
  });

  assert.equal(v1.ok, true);
  assert.equal(v2.ok, true);
  assert.equal((await store.getHostnameClaim('portal.workers.xd.team')).ownerSystem, 'v1');
  assert.equal((await store.getHostnameClaim('portal.pages.xd.team')).ownerSystem, 'v2');
  assert.equal(third.ok, false);
  assert.equal(third.code, 'HOSTNAME_CLAIM_CONFLICT');
});

test('hostname claim releases a slug group after all delete holds expire', async () => {
  const now = '2026-06-15T00:06:00.000Z';
  const store = createSeededStore({ now: () => now });
  store.hostnameClaims.set(
    'portal.workers.xd.team',
    createHostnameClaim(
      {
        environment: 'production',
        hostname: 'portal.workers.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:portal',
        ownerRef: 'pages-portal',
        source: 'v1_delete',
        status: 'held',
        releasedAt: '2026-06-15T00:00:00.000Z',
        reuseHoldUntil: '2026-06-15T00:05:00.000Z',
        releaseReason: 'site_deleted',
      },
      '2026-06-15T00:00:00.000Z'
    )
  );
  store.hostnameClaims.set(
    'portal.pages.xd.team',
    createHostnameClaim(
      {
        environment: 'production',
        hostname: 'portal.pages.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'pages',
        ownerSystem: 'v2',
        ownerId: 'site_portal_old',
        ownerRef: 'route_portal_old',
        source: 'v2_delete',
        status: 'held',
        releasedAt: '2026-06-15T00:00:00.000Z',
        reuseHoldUntil: '2026-06-15T00:05:00.000Z',
        releaseReason: 'site_deleted',
      },
      '2026-06-15T00:00:00.000Z'
    )
  );

  const reacquired = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.workers.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'workers',
    ownerSystem: 'v2',
    ownerId: 'site_portal_new',
    ownerRef: 'route_portal_new',
    source: 'v2_create',
  });

  assert.equal(reacquired.ok, true);
  assert.equal(reacquired.claim.ownerSystem, 'v2');
  assert.equal(reacquired.claim.ownerId, 'site_portal_new');
  assert.equal(reacquired.claim.reuseHoldUntil, null);
});

test('hostname claim keeps a slug group locked while another hostname is still in delete hold', async () => {
  const now = '2026-06-15T00:04:00.000Z';
  const store = createSeededStore({ now: () => now });
  store.hostnameClaims.set(
    'portal.workers.xd.team',
    createHostnameClaim(
      {
        environment: 'production',
        hostname: 'portal.workers.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:portal',
        ownerRef: 'pages-portal',
        source: 'v1_delete',
        status: 'held',
        releasedAt: '2026-06-15T00:00:00.000Z',
        reuseHoldUntil: '2026-06-15T00:03:00.000Z',
        releaseReason: 'site_deleted',
      },
      '2026-06-15T00:00:00.000Z'
    )
  );
  store.hostnameClaims.set(
    'portal.pages.xd.team',
    createHostnameClaim(
      {
        environment: 'production',
        hostname: 'portal.pages.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'pages',
        ownerSystem: 'v2',
        ownerId: 'site_portal_old',
        ownerRef: 'route_portal_old',
        source: 'v2_delete',
        status: 'held',
        releasedAt: '2026-06-15T00:00:00.000Z',
        reuseHoldUntil: '2026-06-15T00:05:00.000Z',
        releaseReason: 'site_deleted',
      },
      '2026-06-15T00:00:00.000Z'
    )
  );

  const blocked = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.workers.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'workers',
    ownerSystem: 'v2',
    ownerId: 'site_portal_new',
    ownerRef: 'route_portal_new',
    source: 'v2_create',
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(blocked.claim.hostname, 'portal.pages.xd.team');
});

test('upsertUserFromSso creates users and bumps session version on status changes', async () => {
  const store = createSeededStore();

  const created = await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'user@example.com',
    realname: '示例用户',
    account: 'user@example.com',
    accountId: 'acct_1',
    employeenum: 'user',
    employeeStatus: 'active',
    sessionVersion: 2,
    lastLoginAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const disabled = await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'user@example.com',
    employeeStatus: 'disabled',
    sessionVersion: 1,
    lastLoginAt: '2026-06-15T00:01:00.000Z',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });

  assert.equal(created.sessionVersion, 2);
  assert.equal(created.realname, '示例用户');
  assert.equal(created.account, 'user@example.com');
  assert.equal(created.accountId, 'acct_1');
  assert.equal(created.employeenum, 'user');
  assert.equal(disabled.employeeStatus, 'disabled');
  assert.equal(disabled.sessionVersion, 3);
  assert.equal((await store.getUser('usr_sso')).lastLoginAt, '2026-06-15T00:01:00.000Z');
});

test('upsertUserFromSso does not reactivate a disabled user from a stale active profile', async () => {
  const store = createSeededStore();

  await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'user@example.com',
    employeeStatus: 'active',
    sessionVersion: 1,
    lastLoginAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const disabled = await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'user@example.com',
    employeeStatus: 'disabled',
    sessionVersion: 1,
    lastLoginAt: '2026-06-15T00:01:00.000Z',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });
  const staleActive = await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'stale@example.com',
    realname: '旧 Profile',
    employeeStatus: 'active',
    sessionVersion: 1,
    lastLoginAt: '2026-06-15T00:02:00.000Z',
    updatedAt: '2026-06-15T00:02:00.000Z',
  });

  assert.equal(disabled.employeeStatus, 'disabled');
  assert.equal(staleActive.employeeStatus, 'disabled');
  assert.equal(staleActive.email, 'user@example.com');
  assert.equal(staleActive.realname, null);
  assert.equal(staleActive.sessionVersion, disabled.sessionVersion);
  assert.equal((await store.getUser('usr_sso')).employeeStatus, 'disabled');
});

test('site versions are immutable records', async () => {
  const store = createSeededStore();
  await createSite(store);

  const version = await store.createSiteVersion({
    id: 'ver_1',
    siteId: 'site_1',
    deploymentId: 'dep_1',
    workerName: 'pages-v2-site-1',
    runtime: 'wfp',
    artifactRef: 'dispatch/pages-v2-site-1',
    contentHash: 'sha256:abc',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    createdBy: 'usr_1',
  });
  version.workerName = 'mutated';

  assert.equal((await store.getSiteVersion('ver_1')).workerName, 'pages-v2-site-1');
  await assert.rejects(
    () =>
      store.createSiteVersion({
        id: 'ver_1',
        siteId: 'site_1',
        deploymentId: 'dep_2',
        workerName: 'pages-v2-site-2',
        runtime: 'wfp',
        artifactRef: 'dispatch/pages-v2-site-2',
        contentHash: 'sha256:def',
        deploymentShape: 'worker-only',
        requestedFallback: 'auto',
        resolvedFallback: null,
        routingMode: 'worker-only',
        createdBy: 'usr_1',
      }),
    /VERSION_EXISTS/
  );
});

test('site versions persist resolved deployment metadata', async () => {
  const store = createSeededStore();
  await createSite(store);

  await store.createSiteVersion({
    id: 'ver_meta',
    siteId: 'site_1',
    deploymentId: 'dep_meta',
    workerName: 'pages-v2-docs-ver-meta',
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    dispatchType: 'service-binding',
    dispatchBindingName: 'PAGES_SLOT_001',
    slotId: 'slot_001',
    artifactRef: 'slot://production/slot_001/pages-v2-docs-ver-meta/ver_meta',
    contentHash: 'sha256:abc',
    deploymentShape: 'worker-with-assets',
    requestedFallback: 'auto',
    resolvedFallback: 'not-found',
    routingMode: 'worker-first',
    workerEntry: '_worker.js',
    assetsConfigJson: { not_found_handling: '404-page', run_worker_first: true },
    workerModulesJson: [{ moduleName: '_worker.js', size: 18 }],
    assetManifestJson: [{ path: '/index.html', size: 5 }],
    canonicalContentHash: 'sha256:canonical',
    artifactAvailability: 'active',
    createdBy: 'usr_1',
  });

  const version = await store.getSiteVersion('ver_meta');
  assert.equal(version.deploymentShape, 'worker-with-assets');
  assert.equal(version.requestedFallback, 'auto');
  assert.equal(version.resolvedFallback, 'not-found');
  assert.equal(version.routingMode, 'worker-first');
  assert.equal(version.workerEntry, '_worker.js');
  assert.deepEqual(version.assetsConfigJson, { not_found_handling: '404-page', run_worker_first: true });
  assert.deepEqual(version.workerModulesJson, [{ moduleName: '_worker.js', size: 18 }]);
  assert.deepEqual(version.assetManifestJson, [{ path: '/index.html', size: 5 }]);
  assert.equal(version.canonicalContentHash, 'sha256:canonical');
  assert.equal(version.artifactAvailability, 'active');
});

test('site policy changes update visibility, ACL, cache tier, and policy version', async () => {
  const store = createSeededStore();
  await createSite(store);

  const aclEntries = await store.replaceSiteAclEntries(
    'site_1',
    [
      { id: 'acl_1', subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' },
      { id: 'acl_2', subjectType: 'department', subjectValue: 'dept_design', accessRole: 'viewer', effect: 'allow' },
    ],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:01:00.000Z' },
    'production'
  );

  assert.deepEqual(
    aclEntries.map(({ id, subjectType, subjectValue, effect }) => ({ id, subjectType, subjectValue, effect })),
    [
      { id: 'acl_1', subjectType: 'email', subjectValue: 'user@example.com', effect: 'allow' },
      { id: 'acl_2', subjectType: 'department', subjectValue: 'dept_design', effect: 'allow' },
    ]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 2);

  const route = await store.updateSiteVisibility(
    'site_1',
    { visibility: 'disabled', updatedAt: '2026-06-15T00:02:00.000Z' },
    'production'
  );

  assert.equal(route.visibility, 'disabled');
  assert.equal(route.cacheTier, 'strict');
  assert.equal(route.policyVersion, 3);
  assert.equal((await store.getSite('site_1')).defaultVisibility, 'disabled');
});

test('site ACL incremental helpers dedupe entries and update policy version only on changes', async () => {
  const store = createSeededStore();
  await createSite(store);
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_1', subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:01:00.000Z' },
    'production'
  );

  const granted = await store.addSiteAclEntries(
    'site_1',
    [
      { id: 'acl_duplicate', subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' },
      { id: 'acl_2', subjectType: 'department', subjectValue: '心动/技术平台部', accessRole: 'viewer', effect: 'allow' },
    ],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:02:00.000Z' },
    'production'
  );
  const duplicateGrant = await store.addSiteAclEntries(
    'site_1',
    [
      {
        id: 'acl_duplicate_2',
        subjectType: 'department',
        subjectValue: '心动/技术平台部',
        accessRole: 'viewer',
        effect: 'allow',
      },
    ],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:03:00.000Z' },
    'production'
  );
  const revoked = await store.removeSiteAclEntries(
    'site_1',
    [{ id: 'ignored', subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' }],
    { updatedAt: '2026-06-15T00:04:00.000Z' },
    'production'
  );

  assert.deepEqual(
    granted.map(({ id, subjectType, subjectValue }) => ({ id, subjectType, subjectValue })),
    [
      { id: 'acl_1', subjectType: 'email', subjectValue: 'user@example.com' },
      { id: 'acl_2', subjectType: 'department', subjectValue: '心动/技术平台部' },
    ]
  );
  assert.deepEqual(duplicateGrant, granted);
  assert.deepEqual(
    revoked.map(({ id, subjectType, subjectValue }) => ({ id, subjectType, subjectValue })),
    [{ id: 'acl_2', subjectType: 'department', subjectValue: '心动/技术平台部' }]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 4);
});

test('conditional restore helpers do not clobber newer route state', async () => {
  const store = createSeededStore();
  await createSite(store);
  const previousRoute = await store.getRouteBySiteId('site_1');
  const failedRoute = await store.activateSiteVersion(
    'site_1',
    {
      activeVersionId: 'ver_1',
      workerName: 'pages-v2-docs-ver-1',
      visibility: 'org',
      updatedAt: '2026-06-15T00:01:00.000Z',
    },
    'production'
  );
  const newerRoute = await store.activateSiteVersion(
    'site_1',
    {
      activeVersionId: 'ver_2',
      workerName: 'pages-v2-docs-ver-2',
      visibility: 'org',
      updatedAt: '2026-06-15T00:02:00.000Z',
    },
    'production'
  );

  const restored = await store.restoreSiteRouteIfCurrent('site_1', previousRoute, failedRoute, 'production');

  assert.equal(restored.activeVersionId, 'ver_2');
  assert.equal(restored.workerName, 'pages-v2-docs-ver-2');
  assert.equal((await store.getRouteBySiteId('site_1')).routeGeneration, newerRoute.routeGeneration);
});

test('conditional route activation rejects stale route authority records', async () => {
  const store = createSeededStore();
  await createSite(store);
  const previousRoute = await store.getRouteBySiteId('site_1');
  const newerRoute = await store.activateSiteVersion(
    'site_1',
    {
      activeVersionId: 'ver_newer',
      workerName: 'pages-v2-docs-newer',
      runtime: 'worker',
      executionProvider: 'wfp',
      dispatchType: 'dispatch-namespace',
      visibility: 'org',
      updatedAt: '2026-06-15T00:01:00.000Z',
    },
    'production'
  );

  const staleRoute = await store.activateSiteVersion(
    'site_1',
    {
      activeVersionId: 'ver_stale',
      workerName: 'pages-v2-docs-stale',
      runtime: 'worker',
      executionProvider: 'wfp',
      dispatchType: 'dispatch-namespace',
      visibility: 'org',
      updatedAt: '2026-06-15T00:02:00.000Z',
    },
    'production',
    previousRoute
  );

  assert.equal(staleRoute, null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_newer');
  assert.equal((await store.getRouteBySiteId('site_1')).routeGeneration, newerRoute.routeGeneration);
});

test('access keys persist hash metadata without plaintext', async () => {
  const store = createSeededStore();

  await assert.rejects(
    () =>
      store.createAccessKey({
        id: 'ak_bad',
        ownerUserId: 'usr_1',
        plaintext: 'xdp_prod_secret',
        keyHash: 'hash_1',
        pepperId: 'pepper_1',
        name: 'bad',
        scopes: ['deploy:site'],
        siteId: null,
        expiresAt: null,
      }),
    /ACCESS_KEY_PLAINTEXT_FORBIDDEN/
  );

  const key = await store.createAccessKey({
    id: 'ak_1',
    ownerUserId: 'usr_1',
    keyHash: 'hash_1',
    pepperId: 'pepper_1',
    name: 'ci',
    scopes: ['deploy:site'],
    siteId: null,
    expiresAt: null,
  });

  assert.equal(key.keyHash, 'hash_1');
  assert.equal(key.pepperId, 'pepper_1');
  assert.equal('plaintext' in key, false);
});

test('deployment idempotency returns existing records and rejects hash conflicts', async () => {
  const store = createSeededStore();
  await createSite(store);

  const first = await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_a',
    visibility: 'org',
    status: 'pending',
  });
  assert.equal(first.kind, 'created');

  const replay = await store.createDeploymentForIdempotency({
    id: 'dep_2',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_a',
    visibility: 'org',
    status: 'pending',
  });
  assert.equal(replay.kind, 'existing');
  assert.equal(replay.deployment.id, 'dep_1');

  const conflict = await store.createDeploymentForIdempotency({
    id: 'dep_3',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_b',
    visibility: 'org',
    status: 'pending',
  });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(await store.getDeployment('dep_3'), null);
});

test('D1 store retries another available worker slot when CAS loses a race', async () => {
  const slots = new Map([
    ['slot_001', workerSlotRow({ id: 'slot_001', slot_number: 1 })],
    ['slot_002', workerSlotRow({ id: 'slot_002', slot_number: 2 })],
  ]);
  const db = fakeSlotDb(slots, { loseFirstUpdate: true });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const assigned = await store.assignAvailableWorkerSlot({
    environment: 'production',
    siteId: 'site_1',
    routeId: 'route_1',
    versionId: 'ver_1',
    assignedAt: '2026-06-15T00:01:00.000Z',
  });

  assert.equal(assigned.id, 'slot_002');
  assert.equal(assigned.status, 'assigned');
  assert.equal(assigned.assignedVersionId, 'ver_1');
  assert.equal(slots.get('slot_001').status, 'available');
});

test('D1 store upserts SSO users atomically and keeps disabled users disabled', async () => {
  const db = fakeUserDb();
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'user@example.com',
    employeeStatus: 'active',
    sessionVersion: 1,
    lastLoginAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const disabled = await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'user@example.com',
    employeeStatus: 'disabled',
    sessionVersion: 1,
    lastLoginAt: '2026-06-15T00:01:00.000Z',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });
  const staleActive = await store.upsertUserFromSso({
    userId: 'usr_sso',
    email: 'stale@example.com',
    realname: '旧 Profile',
    employeeStatus: 'active',
    sessionVersion: 1,
    lastLoginAt: '2026-06-15T00:02:00.000Z',
    updatedAt: '2026-06-15T00:02:00.000Z',
  });

  assert.equal(disabled.employeeStatus, 'disabled');
  assert.equal(staleActive.employeeStatus, 'disabled');
  assert.equal(staleActive.email, 'user@example.com');
  assert.equal(staleActive.realname, null);
  assert.equal(staleActive.sessionVersion, disabled.sessionVersion);
  assert.equal(db.selectBeforeFirstUpsert, false);
});

test('D1 store createSite rolls back when a same-slug claim appears during the batch', async () => {
  const db = fakeCreateSiteD1Db({
    beforeBatch(state) {
      state.claims.set(
        'portal.workers.xd.team',
        hostnameClaimRow({
          id: 'claim_v1_portal',
          environment: 'production',
          hostname: 'portal.workers.xd.team',
          normalizedSlug: 'portal',
          hostnameFamily: 'workers',
          ownerSystem: 'v1',
          ownerId: 'v1:production:portal',
          ownerRef: 'pages-portal',
          source: 'v1_deploy',
          acquiredAt: '2026-06-15T00:00:00.000Z',
        })
      );
    },
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  await assert.rejects(
    () =>
      store.createSite({
        id: 'site_1',
        slug: 'portal',
        ownerUserId: 'usr_1',
        siteUuid: 'uuid_1',
        defaultVisibility: 'org',
        environment: 'production',
        routeId: 'route_1',
        hostname: 'portal.pages.xd.team',
      }),
    /HOSTNAME_CLAIM_CONFLICT/
  );

  assert.equal(await store.getSite('site_1'), null);
  assert.equal(await store.getRouteBySiteId('site_1'), null);
  assert.deepEqual(await store.listSiteMembers('site_1'), []);
  assert.equal((await store.getHostnameClaim('portal.workers.xd.team')).ownerSystem, 'v1');
  assert.equal(await store.getHostnameClaim('portal.pages.xd.team'), null);
});

test('D1 store createSite revives an expired held hostname claim', async () => {
  const db = fakeCreateSiteD1Db({
    claims: [
      hostnameClaimRow({
        id: 'claim_route_old',
        environment: 'production',
        hostname: 'portal.workers.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'workers',
        ownerSystem: 'v2',
        ownerId: 'site_old',
        ownerRef: 'route_old',
        status: 'held',
        source: 'v2_delete',
        acquiredAt: '2026-06-15T00:00:00.000Z',
        releasedAt: '2026-06-15T00:01:00.000Z',
        reuseHoldUntil: '2026-06-15T00:05:00.000Z',
        releaseReason: 'site_deleted',
      }),
    ],
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:06:00.000Z' });

  const site = await store.createSite({
    id: 'site_new',
    slug: 'portal',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_new',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_new',
    hostname: 'portal.workers.xd.team',
  });
  const claim = await store.getHostnameClaim('portal.workers.xd.team');

  assert.equal(site.id, 'site_new');
  assert.equal(claim.id, 'claim_route_old');
  assert.equal(claim.ownerSystem, 'v2');
  assert.equal(claim.ownerId, 'site_new');
  assert.equal(claim.ownerRef, 'route_new');
  assert.equal(claim.status, 'active');
  assert.equal(claim.reuseHoldUntil, null);
  assert.equal(claim.releaseReason, null);
  assert.equal((await store.getRouteBySiteId('site_new')).hostname, 'portal.workers.xd.team');
  assert.deepEqual(await store.listSiteMembers('site_new'), [
    {
      siteId: 'site_new',
      userId: 'usr_1',
      role: 'owner',
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:06:00.000Z',
    },
  ]);
});

test('D1 store acquireHostnameClaim rejects a same-slug claim inserted before the final insert', async () => {
  const db = fakeCreateSiteD1Db({
    beforeInsertHostnameClaim(state) {
      state.claims.set(
        'portal.workers.xd.team',
        hostnameClaimRow({
          id: 'claim_v1_portal',
          environment: 'production',
          hostname: 'portal.workers.xd.team',
          normalizedSlug: 'portal',
          hostnameFamily: 'workers',
          ownerSystem: 'v1',
          ownerId: 'v1:production:portal',
          ownerRef: 'pages-portal',
          source: 'v1_deploy',
        })
      );
    },
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const result = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'site_portal',
    ownerRef: 'route_portal',
    source: 'v2_create',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(result.claim.ownerSystem, 'v1');
  assert.equal(await store.getHostnameClaim('portal.pages.xd.team'), null);
});

test('D1 store acquireHostnameClaim allows legacy v1/v2 same-owner coexistence', async () => {
  const db = fakeCreateSiteD1Db({
    claims: [
      hostnameClaimRow({
        id: 'claim_v1_portal',
        environment: 'production',
        hostname: 'portal.workers.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'owner_a',
        ownerRef: 'pages-portal',
        source: 'v1_deploy',
      }),
    ],
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const result = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'owner_a',
    ownerRef: 'route_portal',
    source: 'v2_create',
  });
  const third = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal-preview.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'owner_b',
    ownerRef: 'route_portal_preview',
    source: 'v2_create',
  });

  assert.equal(result.ok, true);
  assert.equal((await store.getHostnameClaim('portal.pages.xd.team')).ownerSystem, 'v2');
  assert.equal(third.ok, false);
  assert.equal(third.code, 'HOSTNAME_CLAIM_CONFLICT');
});

test('D1 store acquireHostnameClaim rejects an expired held reacquire when another same-slug claim appears', async () => {
  const db = fakeCreateSiteD1Db({
    claims: [
      hostnameClaimRow({
        id: 'claim_route_old',
        environment: 'production',
        hostname: 'portal.pages.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'pages',
        ownerSystem: 'v2',
        ownerId: 'site_old',
        ownerRef: 'route_old',
        status: 'held',
        source: 'v2_delete',
        acquiredAt: '2026-06-15T00:00:00.000Z',
        releasedAt: '2026-06-15T00:01:00.000Z',
        reuseHoldUntil: '2026-06-15T00:05:00.000Z',
        releaseReason: 'site_deleted',
      }),
    ],
    beforeUpdateHostnameClaim(state) {
      state.claims.set(
        'portal.workers.xd.team',
        hostnameClaimRow({
          id: 'claim_v1_portal',
          environment: 'production',
          hostname: 'portal.workers.xd.team',
          normalizedSlug: 'portal',
          hostnameFamily: 'workers',
          ownerSystem: 'v1',
          ownerId: 'v1:production:portal',
          ownerRef: 'pages-portal',
          source: 'v1_deploy',
        })
      );
    },
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:06:00.000Z' });

  const result = await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'portal.pages.xd.team',
    normalizedSlug: 'portal',
    hostnameFamily: 'pages',
    ownerSystem: 'v2',
    ownerId: 'site_new',
    ownerRef: 'route_new',
    source: 'v2_create',
  });
  const oldClaim = await store.getHostnameClaim('portal.pages.xd.team');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(oldClaim.ownerId, 'site_old');
  assert.equal(oldClaim.status, 'held');
  assert.equal((await store.getHostnameClaim('portal.workers.xd.team')).ownerSystem, 'v1');
});

function createSeededStore(options = {}) {
  const store = createTestPagesStore({
    now: options.now || (() => '2026-06-15T00:00:00.000Z'),
  });
  store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  return store;
}

function fakeCreateSiteD1Db({ claims = [], beforeBatch, beforeInsertHostnameClaim, beforeUpdateHostnameClaim } = {}) {
  const state = {
    sites: new Map(),
    routes: new Map(),
    members: [],
    claims: new Map(claims.map((claim) => [claim.hostname, claim])),
  };
  let beforeBatchRan = false;
  let beforeInsertHostnameClaimRan = false;
  let beforeUpdateHostnameClaimRan = false;
  const db = {
    state,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: () => fakeCreateSiteFirst(state, sql, args),
            all: () => fakeCreateSiteAll(state, sql, args),
            run: () =>
              fakeCreateSiteRun(state, sql, args, {
                beforeInsertHostnameClaim:
                  beforeInsertHostnameClaim && !beforeInsertHostnameClaimRan
                    ? () => {
                        beforeInsertHostnameClaimRan = true;
                        beforeInsertHostnameClaim(state);
                      }
                    : null,
                beforeUpdateHostnameClaim:
                  beforeUpdateHostnameClaim && !beforeUpdateHostnameClaimRan
                    ? () => {
                        beforeUpdateHostnameClaimRan = true;
                        beforeUpdateHostnameClaim(state);
                      }
                    : null,
              }),
          };
        },
      };
    },
    async batch(statements) {
      if (beforeBatch && !beforeBatchRan) {
        beforeBatchRan = true;
        beforeBatch(state);
      }
      const snapshot = cloneCreateSiteD1State(state);
      try {
        for (const statement of statements) await statement.run();
      } catch (error) {
        restoreCreateSiteD1State(state, snapshot);
        throw error;
      }
    },
  };
  return db;
}

async function fakeCreateSiteFirst(state, sql, args) {
  if (/SELECT \* FROM sites WHERE environment = \? AND slug = \? AND deleted_at IS NULL/.test(sql)) {
    const [environment, slug] = args;
    return (
      [...state.sites.values()].find(
        (site) => site.environment === environment && site.slug === slug && site.deleted_at == null
      ) || null
    );
  }
  if (/SELECT \* FROM sites WHERE id = \?/.test(sql)) return state.sites.get(args[0]) || null;
  if (/SELECT \* FROM hostname_claims WHERE hostname = \?/.test(sql)) return state.claims.get(args[0]) || null;
  if (/WHERE environment = \? AND normalized_slug = \? AND owner_system = \? AND owner_id = \?/.test(sql)) {
    const [environment, normalizedSlug, ownerSystem, ownerId, now] = args;
    return (
      [...state.claims.values()].find(
        (claim) =>
          claim.environment === environment &&
          claim.normalized_slug === normalizedSlug &&
          claim.owner_system === ownerSystem &&
          claim.owner_id === ownerId &&
          isBlockingCreateSiteClaim(claim, now)
      ) || null
    );
  }
  if (/SELECT \* FROM hostname_claims\s+WHERE environment = \?/.test(sql)) {
    const [environment, normalizedSlug, now, excludeHostname, ownerSystem, ownerId, , , , hostnameFamily] = args;
    return (
      [...state.claims.values()].find(
        (claim) =>
          claim.environment === environment &&
          claim.normalized_slug === normalizedSlug &&
          isBlockingCreateSiteClaim(claim, now) &&
          claim.hostname !== excludeHostname &&
          !(claim.owner_system === ownerSystem && claim.owner_id === ownerId) &&
          !hostnameClaimRowsCanLegacyCoexist(claim, {
            owner_system: ownerSystem,
            owner_id: ownerId,
            hostname_family: hostnameFamily,
          })
      ) || null
    );
  }
  if (/SELECT \* FROM site_routes WHERE site_id = \?/.test(sql)) {
    const [siteId, environment] = args;
    return (
      [...state.routes.values()].find(
        (route) => route.site_id === siteId && (!environment || route.environment === environment)
      ) || null
    );
  }
  throw new Error(`Unhandled first SQL: ${sql}`);
}

async function fakeCreateSiteAll(state, sql, args) {
  if (/SELECT \* FROM site_members WHERE site_id = \?/.test(sql)) {
    return { results: state.members.filter((member) => member.site_id === args[0]) };
  }
  throw new Error(`Unhandled all SQL: ${sql}`);
}

async function fakeCreateSiteRun(state, sql, args, hooks = {}) {
  if (/INSERT INTO hostname_claims \(id, environment\)/.test(sql)) {
    const [, hostname, ownerSystem, ownerId, status] = args;
    const claim = state.claims.get(hostname);
    if (claim?.owner_system === ownerSystem && claim.owner_id === ownerId && claim.status === status) {
      return { meta: { changes: 0 } };
    }
    throw new Error('constraint failed: hostname_claims.environment');
  }
  if (/UPDATE hostname_claims\s+SET environment = \?/.test(sql)) {
    if (hooks.beforeUpdateHostnameClaim) hooks.beforeUpdateHostnameClaim();
    return updateCreateSiteHostnameClaim(state, args);
  }
  if (/INSERT INTO hostname_claims/.test(sql)) {
    if (hooks.beforeInsertHostnameClaim) hooks.beforeInsertHostnameClaim();
    return insertCreateSiteHostnameClaim(state, args);
  }
  if (/INSERT INTO sites/.test(sql)) return insertCreateSiteSite(state, args);
  if (/INSERT INTO site_routes/.test(sql)) return insertCreateSiteRoute(state, args);
  if (/INSERT INTO site_members/.test(sql)) return insertCreateSiteMember(state, args);
  throw new Error(`Unhandled run SQL: ${sql}`);
}

function updateCreateSiteHostnameClaim(state, args) {
  const [
    environment,
    normalizedSlug,
    hostnameFamily,
    ownerSystem,
    ownerId,
    ownerRef,
    status,
    source,
    acquiredAt,
    leaseExpiresAt,
    reuseHoldUntil,
    updatedAt,
    hostname,
    now,
    conflictEnvironment,
    conflictSlug,
    conflictNow,
    excludeHostname,
    conflictOwnerSystem,
    conflictOwnerId,
  ] = args;
  const claim = state.claims.get(hostname);
  if (!claim || !['released', 'held'].includes(claim.status)) return { meta: { changes: 0 } };
  if (claim.reuse_hold_until && claim.reuse_hold_until > now) return { meta: { changes: 0 } };
  if (
    hasBlockingCreateSiteClaim(
      state,
      conflictEnvironment,
      conflictSlug,
      conflictNow,
      excludeHostname,
      conflictOwnerSystem,
      conflictOwnerId,
      hostnameFamily
    )
  ) {
    return { meta: { changes: 0 } };
  }
  Object.assign(claim, {
    environment,
    normalized_slug: normalizedSlug,
    hostname_family: hostnameFamily,
    owner_system: ownerSystem,
    owner_id: ownerId,
    owner_ref: ownerRef,
    status,
    source,
    acquired_at: acquiredAt,
    lease_expires_at: leaseExpiresAt,
    released_at: null,
    reuse_hold_until: reuseHoldUntil,
    release_reason: null,
    updated_at: updatedAt,
  });
  return { meta: { changes: 1 } };
}

function insertCreateSiteHostnameClaim(state, args) {
  const [
    id,
    environment,
    hostname,
    normalizedSlug,
    hostnameFamily,
    ownerSystem,
    ownerId,
    ownerRef,
    status,
    source,
    acquiredAt,
    leaseExpiresAt,
    releasedAt,
    reuseHoldUntil,
    releaseReason,
    createdAt,
    updatedAt,
    conflictEnvironment,
    conflictSlug,
    conflictNow,
    excludeHostname,
    conflictOwnerSystem,
    conflictOwnerId,
  ] = args;
  if (state.claims.has(hostname)) throw new Error('unique constraint failed: hostname_claims.hostname');
  if (
    hasBlockingCreateSiteClaim(
      state,
      conflictEnvironment,
      conflictSlug,
      conflictNow,
      excludeHostname,
      conflictOwnerSystem,
      conflictOwnerId,
      hostnameFamily
    )
  ) {
    return { meta: { changes: 0 } };
  }
  state.claims.set(
    hostname,
    hostnameClaimRow({
      id,
      environment,
      hostname,
      normalizedSlug,
      hostnameFamily,
      ownerSystem,
      ownerId,
      ownerRef,
      status,
      source,
      acquiredAt,
      leaseExpiresAt,
      releasedAt,
      reuseHoldUntil,
      releaseReason,
      createdAt,
      updatedAt,
    })
  );
  return { meta: { changes: 1 } };
}

function insertCreateSiteSite(state, args) {
  const [
    id,
    slug,
    environment,
    ownerUserId,
    defaultVisibility,
    executionModeOverride,
    siteUuid,
    createdAt,
    updatedAt,
    deletedAt,
  ] = args;
  if (state.sites.has(id)) throw new Error('unique constraint failed: sites.id');
  state.sites.set(id, {
    id,
    slug,
    environment,
    owner_user_id: ownerUserId,
    default_visibility: defaultVisibility,
    execution_mode_override: executionModeOverride,
    site_uuid: siteUuid,
    created_at: createdAt,
    updated_at: updatedAt,
    deleted_at: deletedAt,
  });
  return { meta: { changes: 1 } };
}

function insertCreateSiteRoute(state, args) {
  const [
    id,
    hostname,
    siteId,
    environment,
    runtime,
    executionProvider,
    workerName,
    dispatchType,
    dispatchBindingName,
    slotId,
    activeVersionId,
    visibility,
    policyVersion,
    routeGeneration,
    routeStatus,
    cacheTier,
    createdAt,
    updatedAt,
  ] = args;
  if (state.routes.has(id)) throw new Error('unique constraint failed: site_routes.id');
  state.routes.set(id, {
    id,
    hostname,
    site_id: siteId,
    environment,
    runtime,
    execution_provider: executionProvider,
    worker_name: workerName,
    dispatch_type: dispatchType,
    dispatch_binding_name: dispatchBindingName,
    slot_id: slotId,
    active_version_id: activeVersionId,
    visibility,
    policy_version: policyVersion,
    route_generation: routeGeneration,
    route_status: routeStatus,
    cache_tier: cacheTier,
    created_at: createdAt,
    updated_at: updatedAt,
  });
  return { meta: { changes: 1 } };
}

function insertCreateSiteMember(state, args) {
  const [siteId, userId, role, createdBy, createdAt] = args;
  state.members.push({
    site_id: siteId,
    user_id: userId,
    role,
    created_by: createdBy,
    created_at: createdAt,
  });
  return { meta: { changes: 1 } };
}

function hasBlockingCreateSiteClaim(
  state,
  environment,
  normalizedSlug,
  now,
  excludeHostname,
  ownerSystem,
  ownerId,
  hostnameFamily
) {
  return [...state.claims.values()].some(
    (claim) =>
      claim.environment === environment &&
      claim.normalized_slug === normalizedSlug &&
      isBlockingCreateSiteClaim(claim, now) &&
      claim.hostname !== excludeHostname &&
      !(claim.owner_system === ownerSystem && claim.owner_id === ownerId) &&
      !hostnameClaimRowsCanLegacyCoexist(claim, {
        owner_system: ownerSystem,
        owner_id: ownerId,
        hostname_family: hostnameFamily,
      })
  );
}

function isBlockingCreateSiteClaim(claim, now) {
  if (['pending', 'active', 'conflicted'].includes(claim.status)) return true;
  if (claim.status !== 'held') return false;
  return !claim.reuse_hold_until || claim.reuse_hold_until > now;
}

function hostnameClaimRowsCanLegacyCoexist(existing, input) {
  return (
    existing.owner_id === input.owner_id &&
    existing.owner_system !== input.owner_system &&
    ['v1', 'v2'].includes(existing.owner_system) &&
    ['v1', 'v2'].includes(input.owner_system) &&
    existing.hostname_family !== input.hostname_family &&
    ['workers', 'pages'].includes(existing.hostname_family) &&
    ['workers', 'pages'].includes(input.hostname_family)
  );
}

function cloneCreateSiteD1State(state) {
  return {
    sites: new Map([...state.sites.entries()].map(([key, value]) => [key, { ...value }])),
    routes: new Map([...state.routes.entries()].map(([key, value]) => [key, { ...value }])),
    members: state.members.map((member) => ({ ...member })),
    claims: new Map([...state.claims.entries()].map(([key, value]) => [key, { ...value }])),
  };
}

function restoreCreateSiteD1State(state, snapshot) {
  state.sites = snapshot.sites;
  state.routes = snapshot.routes;
  state.members = snapshot.members;
  state.claims = snapshot.claims;
}

function hostnameClaimRow(input) {
  return {
    id: input.id || `claim_${input.ownerRef || input.ownerId}`,
    environment: input.environment,
    hostname: input.hostname,
    normalized_slug: input.normalizedSlug,
    hostname_family: input.hostnameFamily,
    owner_system: input.ownerSystem,
    owner_id: input.ownerId,
    owner_ref: input.ownerRef || null,
    status: input.status || 'active',
    source: input.source,
    acquired_at: input.acquiredAt || '2026-06-15T00:00:00.000Z',
    lease_expires_at: input.leaseExpiresAt || null,
    released_at: input.releasedAt || null,
    reuse_hold_until: input.reuseHoldUntil || null,
    release_reason: input.releaseReason || null,
    created_at: input.createdAt || input.acquiredAt || '2026-06-15T00:00:00.000Z',
    updated_at: input.updatedAt || input.acquiredAt || '2026-06-15T00:00:00.000Z',
  };
}

async function createSite(store) {
  return store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
}

function workerSlotRow(overrides = {}) {
  return {
    id: 'slot_001',
    environment: 'production',
    slot_number: 1,
    worker_name: 'pages-v2-production-slot-001',
    binding_name: 'SITE_SLOT_001',
    status: 'available',
    assigned_site_id: null,
    assigned_route_id: null,
    assigned_version_id: null,
    assigned_at: null,
    last_deployed_version_id: null,
    last_seen_at: null,
    health_status: 'ok',
    notes: null,
    created_at: '2026-06-15T00:00:00.000Z',
    updated_at: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

function fakeSlotDb(slots, { loseFirstUpdate = false } = {}) {
  let updateAttempts = 0;
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              assert.match(sql, /SELECT \* FROM worker_slots/);
              const [environment] = args;
              return {
                results: [...slots.values()]
                  .filter((slot) => slot.environment === environment && slot.status === 'available')
                  .sort((left, right) => left.slot_number - right.slot_number),
              };
            },
            async first() {
              assert.match(sql, /SELECT \* FROM worker_slots WHERE id = \?/);
              const [id] = args;
              return slots.get(id) || null;
            },
            async run() {
              assert.match(sql, /UPDATE worker_slots/);
              updateAttempts += 1;
              const [siteId, routeId, versionId, assignedAt, lastDeployedVersionId, updatedAt, id] = args;
              if (loseFirstUpdate && updateAttempts === 1) return { meta: { changes: 0 } };
              const slot = slots.get(id);
              if (!slot || slot.status !== 'available') return { meta: { changes: 0 } };
              Object.assign(slot, {
                status: 'assigned',
                assigned_site_id: siteId,
                assigned_route_id: routeId,
                assigned_version_id: versionId,
                assigned_at: assignedAt,
                last_deployed_version_id: lastDeployedVersionId,
                updated_at: updatedAt,
              });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function fakeUserDb() {
  const users = new Map();
  const db = {
    selectBeforeFirstUpsert: false,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.match(sql, /SELECT \* FROM users WHERE user_id = \?/);
              if (users.size === 0) db.selectBeforeFirstUpsert = true;
              return users.get(args[0]) || null;
            },
            async run() {
              assert.match(sql, /INSERT INTO users/);
              assert.match(sql, /ON CONFLICT\(user_id\) DO UPDATE/);
              assert.match(sql, /users\.employee_status = 'disabled'/);
              const [
                id,
                account,
                accountId,
                email,
                realname,
                employeenum,
                employeeStatus,
                sessionVersion,
                lastLoginAt,
                createdAt,
                updatedAt,
              ] = args;
              const existing = users.get(id) || null;
              if (!existing) {
                users.set(
                  id,
                  userRow({
                    id,
                    account,
                    accountId,
                    email,
                    realname,
                    employeenum,
                    employeeStatus,
                    sessionVersion,
                    lastLoginAt,
                    createdAt,
                    updatedAt,
                  })
                );
                return { meta: { changes: 1 } };
              }
              const effectiveStatus = resolveSsoEmployeeStatus(existing.employee_status, employeeStatus);
              const staleActiveOrUnknown = effectiveStatus === existing.employee_status && effectiveStatus !== employeeStatus;
              users.set(
                id,
                userRow({
                  id,
                  account: staleActiveOrUnknown ? existing.account : account || existing.account,
                  accountId: staleActiveOrUnknown ? existing.account_id : accountId || existing.account_id,
                  email: staleActiveOrUnknown ? existing.email : email,
                  realname: staleActiveOrUnknown ? existing.realname : realname || existing.realname,
                  employeenum: staleActiveOrUnknown ? existing.employeenum : employeenum || existing.employeenum,
                  employeeStatus: effectiveStatus,
                  sessionVersion: staleActiveOrUnknown
                    ? existing.session_version
                    : Math.max(sessionVersion, existing.session_version + (effectiveStatus === existing.employee_status ? 0 : 1)),
                  lastLoginAt: staleActiveOrUnknown ? existing.last_login_at : lastLoginAt,
                  createdAt: existing.created_at,
                  updatedAt: staleActiveOrUnknown ? existing.updated_at : updatedAt,
                })
              );
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return db;
}

function userRow({
  id,
  account,
  accountId,
  email,
  realname,
  employeenum,
  employeeStatus,
  sessionVersion,
  lastLoginAt,
  createdAt,
  updatedAt,
}) {
  return {
    user_id: id,
    account,
    account_id: accountId,
    email,
    realname,
    employeenum,
    employee_status: employeeStatus,
    session_version: sessionVersion,
    last_login_at: lastLoginAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function resolveSsoEmployeeStatus(existingStatus, incomingStatus) {
  if (existingStatus === 'left' && incomingStatus !== 'left') return existingStatus;
  if (existingStatus === 'disabled' && (incomingStatus === 'active' || incomingStatus === 'unknown')) {
    return existingStatus;
  }
  return incomingStatus;
}
