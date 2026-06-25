import assert from 'node:assert/strict';
import test from 'node:test';

import { D1PagesStore } from './store.js';
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
