import assert from 'node:assert/strict';
import test from 'node:test';

import { readRuntimeConfigErrorDiagnostic } from './runtime-config-diagnostics.js';
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
    exposure: 'internal',
    accessMode: 'acl',
    policyVersion: 1,
    routeGeneration: 0,
    runtimeConfigGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: 'sensitive',
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
});

test('D1 store filters audit events by environment', async () => {
  let capturedSql = '';
  let capturedArgs = [];
  const db = {
    prepare(sql) {
      capturedSql = sql;
      return {
        bind(...args) {
          capturedArgs = args;
          return {
            all: async () => ({
              results: [
                {
                  id: 'audit_prod',
                  environment: 'production',
                  event_type: 'site_secret.put',
                  actor_type: 'user',
                  decision: 'allow',
                  created_at: '2026-07-02T00:00:00.000Z',
                },
              ],
            }),
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-07-02T00:00:00.000Z' });

  const events = await store.listAuditEvents({ environment: 'production' });

  assert.match(capturedSql, /LEFT JOIN users actor_users ON actor_users\.user_id = audit_events\.actor_user_id/);
  assert.match(capturedSql, /WHERE audit_events\.environment = \?/);
  assert.deepEqual(capturedArgs, ['production']);
  assert.deepEqual(events, [
    {
      id: 'audit_prod',
      environment: 'production',
      traceId: null,
      eventType: 'site_secret.put',
      actorUserId: null,
      actorType: 'user',
      siteId: null,
      routeId: null,
      versionId: null,
      decision: 'allow',
      statusCode: null,
      ipHash: null,
      userAgentHash: null,
      metadata: null,
      createdAt: '2026-07-02T00:00:00.000Z',
      actor: {
        type: 'user',
        userId: null,
        displayName: null,
        email: null,
      },
    },
  ]);
});

test('D1 store admin and route lookups avoid unjoined team member aliases', async () => {
  const capturedSql = [];
  const db = {
    prepare(sql) {
      capturedSql.push(sql);
      return {
        bind() {
          return {
            all: async () => ({ results: [] }),
            first: async () => null,
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-07-02T00:00:00.000Z' });

  await store.listAdminSites({ environment: 'production' });
  await store.getSiteWithRoute('site_1', 'production');

  assert.equal(capturedSql.length, 2);
  assert.equal(capturedSql.some((sql) => /team_members\.role/.test(sql)), false);
});

test('D1 store console directory merges org and ACL sites for authenticated viewers', async () => {
  const db = fakeConsoleDirectoryDb({
    internalRows: [consoleDirectorySiteRow({ id: 'site_internal', slug: 'internal-demo', visibility: 'internal' })],
    accessibleRows: [
      consoleDirectorySiteRow({ id: 'site_acl', slug: 'acl-demo', visibility: 'acl' }),
      consoleDirectorySiteRow({ id: 'site_org', slug: 'org-demo', visibility: 'org' }),
    ],
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const sites = await store.listConsoleDirectorySites({
    environment: 'production',
    viewerUserId: 'usr_viewer',
  });

  assert.deepEqual(
    sites.map((site) => [site.id, site.slug, site.route.visibility, site.ownerDisplayName]),
    [
      ['site_acl', 'acl-demo', 'acl', 'Owner Name'],
      ['site_internal', 'internal-demo', 'internal', 'Owner Name'],
      ['site_org', 'org-demo', 'org', 'Owner Name'],
    ]
  );
  const internalCall = db.calls.find((call) =>
    call.sql.includes("COALESCE(site_routes.visibility, sites.default_visibility) = 'internal'")
  );
  assert.ok(internalCall);
  assertConsoleDirectoryRouteJoin(internalCall.sql);
  const accessCall = db.calls.find((call) => call.sql.includes('JOIN users AS viewer_users'));
  assert.ok(accessCall);
  assert.deepEqual(accessCall.args, ['usr_viewer', 'production']);
  assertConsoleDirectoryRouteJoin(accessCall.sql);
  assert.match(accessCall.sql, /site_acl_entries\.subject_type = 'email'/);
  assert.match(accessCall.sql, /trim\(site_acl_entries\.subject_value\) <> ''/);
  assert.match(accessCall.sql, /trim\(COALESCE\(viewer_users\.email, ''\)\) <> ''/);
  assert.match(accessCall.sql, /site_acl_entries\.subject_type = 'department'/);
});

test('D1 store admin list queries are bounded and site detail can be fetched by id', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const statement = {
        first: async () => null,
        all: async () => ({ results: [] }),
        bind(...args) {
          call.args = args;
          return statement;
        },
      };
      return statement;
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-07-02T00:00:00.000Z' });

  await store.listAdminSites({ environment: 'production' });
  await store.listAdminSiteDeployments({ environment: 'production', siteId: 'site_1' });
  await store.getAdminDashboard({ environment: 'production' });
  await store.listAdminTeams({ environment: 'production' });
  await store.getAdminSiteById('site_1', 'production');

  const [sites, deployments] = calls;
  assert.match(sites.sql, /LIMIT \?/);
  assert.match(
    sites.sql,
    /LEFT JOIN site_versions\s+ON site_versions\.id = site_routes\.active_version_id\s+AND site_versions\.site_id = sites\.id/
  );
  assert.match(sites.sql, /site_versions\.deployment_shape AS active_version_deployment_shape/);
  assert.deepEqual(sites.args, ['production', 200]);
  assert.match(deployments.sql, /LIMIT \?/);
  assert.deepEqual(deployments.args, ['production', 'site_1', 100]);
  assert.match(deployments.sql, /sites\.id AS joined_site_id/);
  assert.match(deployments.sql, /LEFT JOIN users AS actor_users/);
  assert.match(deployments.sql, /actor_users\.email AS actor_user_email/);
  assert.match(deployments.sql, /actor_users\.realname AS actor_user_realname/);
  const dashboardDeployments = calls.find(
    (call) => call.sql.includes('SELECT deployments.*') && call.sql.includes('status = \'failed\'')
  );
  assert.ok(dashboardDeployments);
  assert.match(dashboardDeployments.sql, /sites\.id AS joined_site_id/);
  assert.match(dashboardDeployments.sql, /LEFT JOIN users AS actor_users/);
  assert.match(dashboardDeployments.sql, /actor_users\.email AS actor_user_email/);
  assert.match(dashboardDeployments.sql, /actor_users\.realname AS actor_user_realname/);
  const teams = calls.find((call) => call.sql.includes('SELECT * FROM teams'));
  const siteDetail = calls.find((call) => call.sql.includes('WHERE sites.id = ? AND sites.environment ='));
  assert.match(teams.sql, /LIMIT \?/);
  assert.deepEqual(teams.args, ['production', 200]);
  assert.match(siteDetail.sql, /WHERE sites\.id = \? AND sites\.environment = \?/);
  assert.match(
    siteDetail.sql,
    /LEFT JOIN site_versions\s+ON site_versions\.id = site_routes\.active_version_id\s+AND site_versions\.site_id = sites\.id/
  );
  assert.match(siteDetail.sql, /site_versions\.deployment_shape AS active_version_deployment_shape/);
  assert.doesNotMatch(siteDetail.sql, /ORDER BY sites\.updated_at DESC/);
  assert.deepEqual(siteDetail.args, ['site_1', 'production']);
});

test('D1 admin site list and detail map the active deployment shape', async () => {
  const row = {
    id: 'site_1',
    slug: 'site-1',
    environment: 'production',
    owner_type: 'user',
    owner_id: 'usr_1',
    owner_user_id: 'usr_1',
    default_visibility: 'internal',
    site_uuid: 'uuid_site_1',
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    route_id: 'route_1',
    route_hostname: 'site-1.workers.xd.team',
    route_runtime: 'wfp',
    route_execution_provider: 'wfp',
    route_dispatch_type: 'dispatch-namespace',
    route_active_version_id: 'ver_1',
    route_visibility: 'internal',
    route_policy_version: 1,
    route_route_generation: 1,
    route_runtime_config_generation: 0,
    route_route_status: 'active',
    route_cache_tier: 'fast',
    route_created_at: '2026-07-02T00:00:00.000Z',
    route_updated_at: '2026-07-02T00:00:00.000Z',
    active_version_deployment_shape: 'worker-with-assets',
    owner_user_email: 'alice@example.com',
    owner_user_realname: 'Alice',
  };
  const db = {
    prepare() {
      return {
        bind() {
          return {
            all: async () => ({ results: [row] }),
            first: async () => row,
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-07-02T00:00:00.000Z' });

  const sites = await store.listAdminSites({ environment: 'production' });
  const detail = await store.getAdminSiteById('site_1', 'production');

  assert.equal(sites[0].deploymentShape, 'worker-with-assets');
  assert.equal(detail.deploymentShape, 'worker-with-assets');
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

test('hostname claim rejects same-owner slug conflicts when hostname differs', async () => {
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

  assert.equal(v1.ok, true);
  assert.equal(v2.ok, false);
  assert.equal(v2.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(v2.claim.ownerSystem, 'v1');
  assert.equal((await store.getHostnameClaim('portal.workers.xd.team')).ownerSystem, 'v1');
  assert.equal(await store.getHostnameClaim('portal.pages.xd.team'), null);
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

test('test store creates users with identity metadata and enforces identity uniqueness', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

  const ssoUser = await store.createUser({
    userId: 'usr_sso',
    email: 'sso@example.com',
  });
  const xdmakerUser = await store.createUser({
    userId: 'usr_xdmaker',
    email: 'maker@example.com',
    feishuOpenId: 'ou_maker',
    createdSource: 'xdmaker',
  });

  assert.equal(ssoUser.feishuOpenId, null);
  assert.equal(ssoUser.createdSource, 'xd_sso');
  assert.equal(xdmakerUser.feishuOpenId, 'ou_maker');
  assert.equal(xdmakerUser.createdSource, 'xdmaker');
  await assert.rejects(
    () => store.createUser({ userId: 'usr_duplicate_email', email: 'MAKER@EXAMPLE.COM' }),
    /USER_EMAIL_CONFLICT/
  );
  await assert.rejects(
    () => store.createUser({ userId: 'usr_duplicate_feishu', email: 'other@example.com', feishuOpenId: 'ou_maker' }),
    /USER_FEISHU_OPEN_ID_CONFLICT/
  );
});

test('normalizes user emails before storing them and rejects whitespace duplicates', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

  const user = await store.createUser({
    userId: 'usr_normalized',
    email: '  User@Example.COM  ',
  });

  assert.equal(user.email, 'user@example.com');
  assert.equal((await store.getUser('usr_normalized')).email, 'user@example.com');
  assert.equal((await store.getUserByEmail('USER@example.com')).id, 'usr_normalized');
  await assert.rejects(
    () => store.createUser({ userId: 'usr_whitespace_duplicate', email: 'user@example.com' }),
    /USER_EMAIL_CONFLICT/
  );
});

for (const [storeName, createStore] of userIdentityStoreCases()) {
  test(`${storeName} looks up normalized email and binds Feishu identity without overwriting conflicts`, async () => {
    const store = createStore();
    const user = await store.createUser({
      userId: 'usr_maker',
      email: 'Maker@Example.com',
      createdSource: 'xdmaker',
    });
    await store.createUser({ userId: 'usr_other', email: 'other@example.com' });

    assert.equal(user.createdSource, 'xdmaker');
    assert.equal((await store.getUserByEmail('  MAKER@example.COM  ')).id, 'usr_maker');
    assert.equal(await store.getUserByEmail('missing@example.com'), null);
    assert.equal(await store.getUserByFeishuOpenId(null), null);
    assert.equal(await store.getUserByFeishuOpenId(''), null);
    assert.equal(await store.bindUserFeishuOpenId('usr_maker', null), false);
    assert.equal(await store.bindUserFeishuOpenId('usr_maker', ''), false);
    assert.equal((await store.getUser('usr_maker')).feishuOpenId, null);
    assert.equal(await store.bindUserFeishuOpenId('usr_maker', 'ou_maker'), true);
    assert.equal((await store.getUserByFeishuOpenId('ou_maker')).id, 'usr_maker');
    assert.equal(await store.bindUserFeishuOpenId('usr_maker', 'ou_maker'), true);
    assert.equal(await store.bindUserFeishuOpenId('usr_maker', 'ou_changed'), false);
    assert.equal(await store.bindUserFeishuOpenId('usr_other', 'ou_maker'), false);
    assert.equal(await store.bindUserFeishuOpenId('usr_missing', 'ou_missing'), false);
  });

  test(`${storeName} reuses XDMaker identity by normalized email and preserves its source`, async () => {
    const store = createStore();
    await store.createUser({
      userId: 'usr_platform',
      email: 'maker@example.com',
      feishuOpenId: 'ou_maker',
      createdSource: 'xdmaker',
    });

    const user = await store.upsertUserFromSso({
      userId: 'usr_sso',
      email: 'MAKER@example.com',
      realname: 'Maker User',
      account: 'maker.account',
      accountId: 'acct_maker',
      employeenum: 'maker',
      employeeStatus: 'active',
      sessionVersion: 2,
      lastLoginAt: '2026-06-15T00:01:00.000Z',
      updatedAt: '2026-06-15T00:01:00.000Z',
    });

    assert.equal(user.id, 'usr_platform');
    assert.equal(user.createdSource, 'xdmaker');
    assert.equal(user.feishuOpenId, 'ou_maker');
    assert.equal(user.accountId, 'acct_maker');
    assert.equal(user.employeeStatus, 'active');
    assert.equal(await store.getUser('usr_sso'), null);
  });

  test(`${storeName} rejects conflicting user id and email identities`, async () => {
    const store = createStore();
    await store.createUser({ userId: 'usr_sso', email: 'sso@example.com' });
    await store.createUser({ userId: 'usr_platform', email: 'maker@example.com', createdSource: 'xdmaker' });

    await assert.rejects(
      () => store.upsertUserFromSso({ userId: 'usr_sso', email: 'MAKER@example.com', employeeStatus: 'active' }),
      (error) => {
        assert.equal(error.code, 'USER_IDENTITY_CONFLICT');
        assert.equal(error.message, 'USER_IDENTITY_CONFLICT');
        return true;
      }
    );
  });

  test(`${storeName} does not reactivate disabled or left XDMaker users matched by email`, async () => {
    for (const employeeStatus of ['disabled', 'left']) {
      const store = createStore();
      await store.createUser({
        userId: `usr_platform_${employeeStatus}`,
        email: `${employeeStatus}@example.com`,
        realname: 'Current Name',
        employeeStatus,
        sessionVersion: 7,
        lastLoginAt: '2026-06-15T00:00:00.000Z',
        feishuOpenId: `ou_${employeeStatus}`,
        createdSource: 'xdmaker',
      });

      const staleActive = await store.upsertUserFromSso({
        userId: `usr_sso_${employeeStatus}`,
        email: `${employeeStatus.toUpperCase()}@example.com`,
        realname: 'Stale Name',
        employeeStatus: 'active',
        sessionVersion: 1,
        lastLoginAt: '2026-06-15T00:02:00.000Z',
        updatedAt: '2026-06-15T00:02:00.000Z',
      });

      assert.equal(staleActive.id, `usr_platform_${employeeStatus}`);
      assert.equal(staleActive.employeeStatus, employeeStatus);
      assert.equal(staleActive.realname, 'Current Name');
      assert.equal(staleActive.sessionVersion, 7);
      assert.equal(staleActive.lastLoginAt, '2026-06-15T00:00:00.000Z');
      assert.equal(staleActive.createdSource, 'xdmaker');
      assert.equal(staleActive.feishuOpenId, `ou_${employeeStatus}`);
    }
  });
}

test('upsertUserFromSso creates users and bumps session version on status changes', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

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
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

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
  assert.deepEqual(version.varNamesJson, null);
  assert.deepEqual(version.secretNamesJson, null);
  assert.deepEqual(version.runtimeConfigSnapshotJson, null);
  assert.equal(version.artifactAvailability, 'active');
});

test('D1 store encrypts site secrets at rest and decrypts enabled secrets for deploy snapshots', async () => {
  const rows = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeSiteSecretsDb(rows, auditRows, { routes });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'super-secret-value',
    actorId: 'usr_1',
  });

  const row = liveSecretRow(rows, 'production', 'site_1', 'API_TOKEN');
  assert.notEqual(row.encrypted_value, 'super-secret-value');
  assert.match(row.encrypted_value, /^v1:/);
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), [
    {
      id: 'sec_1',
      environment: 'production',
      siteId: 'site_1',
      name: 'API_TOKEN',
      value: 'super-secret-value',
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    },
  ]);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);

  await store.deleteSiteSecret('production', 'site_1', 'API_TOKEN', { deletedAt: '2026-06-15T00:01:00.000Z' });
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), []);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 2);

  await store.recordAuditEvent({
    id: 'aud_1',
    environment: 'production',
    eventType: 'site_secret.put',
    actorUserId: 'usr_1',
    actorType: 'user',
    siteId: 'site_1',
    decision: 'allow',
    statusCode: 200,
    metadata: { revision: 1 },
    createdAt: '2026-06-15T00:00:00.000Z',
  });

  assert.deepEqual(auditRows, [
      {
        id: 'aud_1',
        environment: 'production',
        trace_id: null,
      event_type: 'site_secret.put',
      actor_user_id: 'usr_1',
      actor_type: 'user',
      site_id: 'site_1',
      route_id: null,
      version_id: null,
      decision: 'allow',
      status_code: 200,
      ip_hash: null,
      user_agent_hash: null,
      metadata_json: JSON.stringify({ revision: 1 }),
      created_at: '2026-06-15T00:00:00.000Z',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(auditRows), /super-secret-value/);
});

test('D1 store replaces site vars as site-level runtime config and bumps generation only on changes', async () => {
  const rows = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeRuntimeConfigDb({ siteVars: rows, auditRows, routes });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  const first = await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: {
      API_BASE: 'https://api.example.com',
      FEATURE_FLAG: 'on',
    },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
    createId: (name) => `var_${name.toLowerCase()}`,
  });

  assert.deepEqual(first, [
    {
      id: 'var_api_base',
      environment: 'production',
      siteId: 'site_1',
      name: 'API_BASE',
      value: 'https://api.example.com',
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    },
    {
      id: 'var_feature_flag',
      environment: 'production',
      siteId: 'site_1',
      name: 'FEATURE_FLAG',
      value: 'on',
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    },
  ]);
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), first);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);

  const same = await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: {
      FEATURE_FLAG: 'on',
      API_BASE: 'https://api.example.com',
    },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:01:00.000Z',
    createId: (name) => `var_${name.toLowerCase()}`,
  });
  assert.deepEqual(same, first);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);

  const replaced = await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: {
      FEATURE_FLAG: 'off',
    },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:02:00.000Z',
    createId: (name) => `var_${name.toLowerCase()}`,
  });

  assert.deepEqual(replaced, [
    {
      id: 'var_feature_flag',
      environment: 'production',
      siteId: 'site_1',
      name: 'FEATURE_FLAG',
      value: 'off',
      revision: 2,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:02:00.000Z',
      deletedAt: null,
    },
  ]);
  assert.equal(liveVarRow(rows, 'production', 'site_1', 'API_BASE'), undefined);
  assert.equal(varRowById(rows, 'var_api_base').deleted_at, '2026-06-15T00:02:00.000Z');
  assert.equal(routes.get('production:site_1').runtime_config_generation, 2);
});

test('D1 store atomically puts a single site var and returns the committed snapshot', async () => {
  const rows = new Map();
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars: rows, routes }), {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  const result = await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
    createId: () => 'var_api_base',
  });

  assert.equal(result.record.name, 'API_BASE');
  assert.equal(result.record.revision, 1);
  assert.equal(result.generation, 1);
  assert.equal(result.changed, true);
  assert.deepEqual(
    result.vars.map(({ name, value }) => ({ name, value })),
    [{ name: 'API_BASE', value: 'https://api.example.com' }]
  );
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('D1 site var mutation marks unexpected batch failures without exposing the error', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const baseDb = fakeRuntimeConfigDb({ routes });
  const failure = new Error('D1_ERROR: SENSITIVE_SQL SENSITIVE_VALUE');
  failure.cause = new Error('SENSITIVE_CAUSE');
  const store = new D1PagesStore(
    {
      ...baseDb,
      async batch() {
        throw failure;
      },
    },
    {
      now: () => '2026-06-15T00:00:00.000Z',
      secretEncryptionKey: 'test-encryption-key',
    }
  );

  await assert.rejects(
    store.mutateSiteVar({
      environment: 'production',
      siteId: 'site_1',
      operation: 'put',
      name: 'API_BASE',
      value: 'https://api.example.com',
      actorId: 'usr_1',
      createId: () => 'var_api_base',
    }),
    (error) => {
      assert.equal(error, failure);
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'mutation_batch',
        reason: 'store_operation_failed',
      });
      return true;
    }
  );
});

test('D1 site var mutation classifies lock acquisition schema failures', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const baseDb = fakeRuntimeConfigDb({ routes });
  const failure = new Error('D1_ERROR: no such column: runtime_config_lock_expires_at SENSITIVE_VALUE');
  const store = new D1PagesStore(
    {
      ...baseDb,
      prepare(sql) {
        const statement = baseDb.prepare(sql);
        if (!/SET runtime_config_lock_id = \?, runtime_config_lock_expires_at = \?/.test(sql)) return statement;
        return {
          bind(...args) {
            return {
              ...statement.bind(...args),
              async run() {
                throw failure;
              },
            };
          },
        };
      },
    },
    {
      now: () => '2026-06-15T00:00:00.000Z',
      secretEncryptionKey: 'test-encryption-key',
    }
  );

  await assert.rejects(
    store.mutateSiteVar({
      environment: 'production',
      siteId: 'site_1',
      operation: 'put',
      name: 'API_BASE',
      value: 'https://api.example.com',
      actorId: 'usr_1',
      createId: () => 'var_api_base',
    }),
    (error) => {
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'lock_acquire',
        reason: 'schema_missing',
      });
      return true;
    }
  );
});

test('D1 site var put marks synchronous statement construction failures', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const failure = new Error('D1_TYPE_ERROR: SENSITIVE_VAR_VALUE');
  const store = new D1PagesStore(fakeRuntimeConfigDb({ routes }), {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  store.siteVarInsertStatement = () => {
    throw failure;
  };

  await assert.rejects(
    store.mutateSiteVar({
      environment: 'production',
      siteId: 'site_1',
      operation: 'put',
      name: 'FEATURE_FLAG',
      value: 'on',
      actorId: 'usr_1',
    }),
    (error) => {
      assert.equal(error, failure);
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'statement_build',
        reason: 'store_operation_failed',
      });
      return true;
    }
  );
});

test('D1 site var delete marks synchronous statement construction failures', async () => {
  const siteVars = new Map([
    [
      'production:site_1:FEATURE_FLAG:var_1',
      {
        id: 'var_1',
        environment: 'production',
        site_id: 'site_1',
        name: 'FEATURE_FLAG',
        value: 'on',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const routes = new Map([['production:site_1', { runtime_config_generation: 1, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const failure = new Error('D1_TYPE_ERROR: SENSITIVE_VAR_VALUE');
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  store.siteVarDeleteStatement = () => {
    throw failure;
  };

  await assert.rejects(
    store.mutateSiteVar({
      environment: 'production',
      siteId: 'site_1',
      operation: 'delete',
      name: 'FEATURE_FLAG',
      actorId: 'usr_1',
    }),
    (error) => {
      assert.equal(error, failure);
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'statement_build',
        reason: 'store_operation_failed',
      });
      return true;
    }
  );
});

test('D1 audited site secret mutation marks unexpected batch failures', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const baseDb = fakeRuntimeConfigDb({ routes });
  const failure = new Error('D1_ERROR: SENSITIVE_SECRET SENSITIVE_SQL');
  const store = new D1PagesStore(
    {
      ...baseDb,
      async batch() {
        throw failure;
      },
    },
    {
      now: () => '2026-06-15T00:00:00.000Z',
      secretEncryptionKey: 'test-encryption-key',
    }
  );

  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_1',
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_TOKEN',
      value: 'super-secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    (error) => {
      assert.equal(error, failure);
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'mutation_batch',
        reason: 'store_operation_failed',
      });
      return true;
    }
  );
});

test('D1 audited site secret put marks synchronous statement construction failures', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const failure = new Error('D1_TYPE_ERROR: SENSITIVE_SECRET_VALUE');
  const store = new D1PagesStore(fakeRuntimeConfigDb({ routes }), {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  store.siteSecretInsertStatement = () => {
    throw failure;
  };

  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_1',
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_TOKEN',
      value: 'super-secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    (error) => {
      assert.equal(error, failure);
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'statement_build',
        reason: 'store_operation_failed',
      });
      return true;
    }
  );
});

test('D1 audited site secret delete marks synchronous statement construction failures', async () => {
  const siteSecrets = new Map([
    [
      'production:site_1:API_TOKEN',
      {
        id: 'sec_1',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_TOKEN',
        encrypted_value: 'encrypted-value',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const routes = new Map([['production:site_1', { runtime_config_generation: 1, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const failure = new Error('D1_TYPE_ERROR: SENSITIVE_SECRET_VALUE');
  const baseDb = fakeRuntimeConfigDb({ siteSecrets, routes });
  const store = new D1PagesStore(
    {
      ...baseDb,
      prepare(sql) {
        if (/UPDATE site_secrets\s+SET deleted_at = \?, updated_at = \?/.test(sql)) throw failure;
        return baseDb.prepare(sql);
      },
    },
    {
      now: () => '2026-06-15T00:01:00.000Z',
      secretEncryptionKey: 'test-encryption-key',
    }
  );

  await assert.rejects(
    store.deleteSiteSecretWithAudit({
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_TOKEN',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    (error) => {
      assert.equal(error, failure);
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'statement_build',
        reason: 'store_operation_failed',
      });
      return true;
    }
  );
});

test('D1 audited site secret mutation marks pre-lock encryption failures as unknown stage', async () => {
  const store = new D1PagesStore(fakeRuntimeConfigDb(), {
    now: () => '2026-06-15T00:00:00.000Z',
  });

  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_1',
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_TOKEN',
      value: 'super-secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    (error) => {
      assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
        stage: 'unknown',
        reason: 'store_operation_failed',
      });
      return true;
    }
  );
});

test('D1 store reports the dedicated var limit error for the 65th var', async () => {
  const siteVars = new Map(
    Array.from({ length: 64 }, (_, index) => {
      const name = `VAR_${String(index).padStart(2, '0')}`;
      const id = `var_${index}`;
      return [
        `production:site_1:${name}:${id}`,
        {
          id,
          environment: 'production',
          site_id: 'site_1',
          name,
          value: 'on',
          revision: 1,
          created_by: 'usr_1',
          created_at: '2026-06-15T00:00:00.000Z',
          updated_at: '2026-06-15T00:00:00.000Z',
          deleted_at: null,
        },
      ];
    })
  );
  const routes = new Map([['production:site_1', { runtime_config_generation: 64 }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, routes }), {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    store.mutateSiteVar({
      environment: 'production',
      siteId: 'site_1',
      operation: 'put',
      name: 'VAR_64',
      value: 'on',
      actorId: 'usr_1',
    }),
    /RUNTIME_VARS_LIMIT_EXCEEDED/
  );
});

test('D1 runtime config lock remains held through a provider callback and releases afterward', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 2, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  const result = await store.withRuntimeConfigLock('production', 'site_1', async (routeState) => {
    assert.equal(routeState.runtimeConfigGeneration, 2);
    assert.match(routes.get('production:site_1').runtime_config_lock_id, /^runtime_lock_/);
    await assert.rejects(
      store.mutateSiteVar({
        environment: 'production',
        siteId: 'site_1',
        operation: 'put',
        name: 'API_BASE',
        value: 'https://api.example.com',
        actorId: 'usr_1',
      }),
      /SITE_VAR_REVISION_CONFLICT/
    );
    return 'synced';
  });

  assert.equal(result, 'synced');
  assert.equal(routes.get('production:site_1').runtime_config_generation, 2);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('D1 runtime config lock reclaims an expired lease and fences the old holder', async () => {
  const siteVars = new Map();
  const routes = new Map([
    [
      'production:site_1',
      {
        runtime_config_generation: 2,
        runtime_config_lock_id: 'runtime_lock_old',
        runtime_config_lock_expires_at: '2026-06-15T00:00:30.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  ]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await store.withRuntimeConfigLock(
    'production',
    'site_1',
    async () => {
      assert.equal(routes.get('production:site_1').runtime_config_lock_id, 'runtime_lock_new');
      assert.equal(
        routes.get('production:site_1').runtime_config_lock_expires_at,
        '2026-06-15T00:02:00.000Z'
      );
      const oldRelease = await store
        .releaseRuntimeConfigLockStatement('production', 'site_1', 'runtime_lock_old', '2026-06-15T00:01:00.000Z')
        .run();
      assert.equal(oldRelease.meta.changes, 0);
      const oldWrite = await store
        .siteVarInsertStatement({
          id: 'var_old',
          environment: 'production',
          siteId: 'site_1',
          name: 'OLD_WRITE',
          value: 'blocked',
          revision: 1,
          createdBy: 'usr_1',
          createdAt: '2026-06-15T00:01:00.000Z',
          updatedAt: '2026-06-15T00:01:00.000Z',
          lockId: 'runtime_lock_old',
        })
        .run();
      assert.equal(oldWrite.meta.changes, 0);
    },
    { lockId: 'runtime_lock_new' }
  );

  assert.equal(siteVars.size, 0);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
  assert.equal(routes.get('production:site_1').runtime_config_lock_expires_at, null);
});

test('D1 runtime config lock does not reclaim an unexpired lease', async () => {
  const routes = new Map([
    [
      'production:site_1',
      {
        runtime_config_generation: 2,
        runtime_config_lock_id: 'runtime_lock_active',
        runtime_config_lock_expires_at: '2026-06-15T00:01:30.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  ]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    store.withRuntimeConfigLock('production', 'site_1', async () => {}, { lockId: 'runtime_lock_new' }),
    /RUNTIME_CONFIG_LOCKED/
  );
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, 'runtime_lock_active');
  assert.equal(routes.get('production:site_1').runtime_config_lock_expires_at, '2026-06-15T00:01:30.000Z');
});

test('D1 runtime config lock aborts provider work before the lease can expire', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 2, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    store.withRuntimeConfigLock(
      'production',
      'site_1',
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      { providerTimeoutMs: 5 }
    ),
    /RUNTIME_CONFIG_PROVIDER_TIMEOUT/
  );
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
  assert.equal(routes.get('production:site_1').runtime_config_lock_expires_at, null);
});

test('D1 runtime config lock aborts provider work when lease renewal loses fencing', async () => {
  const routes = new Map([['production:site_1', { runtime_config_generation: 2, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(
    fakeRuntimeConfigDb({
      routes,
      hooks: { beforeRuntimeConfigRenew: () => ({ changes: 0 }) },
    }),
    {
      now: () => '2026-06-15T00:01:00.000Z',
      secretEncryptionKey: 'test-encryption-key',
    }
  );

  await assert.rejects(
    store.withRuntimeConfigLock(
      'production',
      'site_1',
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      { providerTimeoutMs: 100, renewIntervalMs: 5 }
    ),
    /RUNTIME_CONFIG_LOCKED/
  );
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
  assert.equal(routes.get('production:site_1').runtime_config_lock_expires_at, null);
});

test('D1 concurrent different-name var put fails fast and preserves both bindings after retry', async () => {
  const siteVars = new Map([
    [
      'production:site_1:API_BASE:var_api_base',
      {
        id: 'var_api_base',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_BASE',
        value: 'https://api.example.com',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const routes = new Map([
    [
      'production:site_1',
      {
        runtime_config_generation: 1,
        runtime_config_lock_id: 'runtime_lock_first_put',
        runtime_config_lock_expires_at: '2026-06-15T00:01:30.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  ]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  const input = {
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'FEATURE_FLAG',
    value: 'on',
    actorId: 'usr_1',
    createId: () => 'var_feature_flag',
  };

  await assert.rejects(store.mutateSiteVar(input), /SITE_VAR_REVISION_CONFLICT/);
  assert.equal(siteVars.size, 1);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);

  routes.get('production:site_1').runtime_config_lock_id = null;
  const retried = await store.mutateSiteVar(input);

  assert.equal(retried.generation, 2);
  assert.deepEqual(
    retried.vars.map(({ name, value }) => ({ name, value })),
    [
      { name: 'API_BASE', value: 'https://api.example.com' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ]
  );
  assert.equal(routes.get('production:site_1').runtime_config_generation, 2);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('D1 var and secret race fails fast and preserves both bindings after retry', async () => {
  const siteVars = new Map([
    [
      'production:site_1:API_BASE:var_api_base',
      {
        id: 'var_api_base',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_BASE',
        value: 'https://api.example.com',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const siteSecrets = new Map();
  const auditRows = [];
  const routes = new Map([
    [
      'production:site_1',
      {
        runtime_config_generation: 1,
        runtime_config_lock_id: 'runtime_lock_var_put',
        runtime_config_lock_expires_at: '2026-06-15T00:01:30.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  ]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, siteSecrets, auditRows, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  const input = {
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    value: 'secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  };

  await assert.rejects(store.putSiteSecretWithAudit(input), /SITE_SECRET_REVISION_CONFLICT/);
  assert.equal(siteSecrets.size, 0);
  assert.deepEqual(auditRows, []);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);

  routes.get('production:site_1').runtime_config_lock_id = null;
  await store.putSiteSecretWithAudit(input);

  assert.equal(liveVarRow(siteVars, 'production', 'site_1', 'API_BASE').value, 'https://api.example.com');
  assert.equal(liveSecretRow(siteSecrets, 'production', 'site_1', 'API_TOKEN').revision, 1);
  assert.equal(auditRows.length, 1);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 2);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('D1 store updates one site var without replacing the other vars', async () => {
  const rows = new Map([
    [
      'production:site_1:API_BASE:var_api_base',
      {
        id: 'var_api_base',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_BASE',
        value: 'https://api.example.com/v1',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
    [
      'production:site_1:FEATURE_FLAG:var_feature_flag',
      {
        id: 'var_feature_flag',
        environment: 'production',
        site_id: 'site_1',
        name: 'FEATURE_FLAG',
        value: 'on',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const routes = new Map([['production:site_1', { runtime_config_generation: 4, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars: rows, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  const result = await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com/v2',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:01:00.000Z',
    createId: () => 'unused',
  });

  assert.equal(result.record.id, 'var_api_base');
  assert.equal(result.record.revision, 2);
  assert.equal(result.generation, 5);
  assert.deepEqual(
    result.vars.map(({ name, value }) => ({ name, value })),
    [
      { name: 'API_BASE', value: 'https://api.example.com/v2' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ]
  );
});

test('D1 store treats an unchanged single site var put as a no-op', async () => {
  const rows = new Map();
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars: rows, routes }), {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { FEATURE_FLAG: 'on' },
    actorId: 'usr_1',
    createId: () => 'var_feature_flag',
  });

  const result = await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'FEATURE_FLAG',
    value: 'on',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:01:00.000Z',
    createId: () => 'unused',
  });

  assert.equal(result.changed, false);
  assert.equal(result.record.revision, 1);
  assert.equal(result.generation, 1);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('D1 store deletes one site var without replacing the other vars', async () => {
  const rows = new Map();
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars: rows, routes }), {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { API_BASE: 'https://api.example.com', FEATURE_FLAG: 'on' },
    actorId: 'usr_1',
    createId: (name) => `var_${name.toLowerCase()}`,
  });

  const result = await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'delete',
    name: 'API_BASE',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });

  assert.equal(result.changed, true);
  assert.equal(result.record.name, 'API_BASE');
  assert.equal(result.record.revision, 1);
  assert.equal(result.generation, 2);
  assert.deepEqual(
    result.vars.map(({ name, value }) => ({ name, value })),
    [{ name: 'FEATURE_FLAG', value: 'on' }]
  );
  assert.equal(varRowById(rows, 'var_api_base').deleted_at, '2026-06-15T00:01:00.000Z');
});

test('test store implements the atomic single site var mutation contract', async () => {
  const store = createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });

  const apiBase = await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com',
    actorId: 'usr_1',
    createId: () => 'var_api_base',
  });
  const featureFlag = await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'FEATURE_FLAG',
    value: 'on',
    actorId: 'usr_1',
    createId: () => 'var_feature_flag',
  });

  assert.equal(apiBase.generation, 1);
  assert.equal(featureFlag.generation, 2);
  assert.deepEqual(
    featureFlag.vars.map(({ name, value }) => ({ name, value })),
    [
      { name: 'API_BASE', value: 'https://api.example.com' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ]
  );
});

test('test store serializes concurrent single site var mutations without losing updates', async () => {
  const store = createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });

  await Promise.all([
    store.mutateSiteVar({
      environment: 'production',
      siteId: 'site_1',
      operation: 'put',
      name: 'API_BASE',
      value: 'https://api.example.com',
      actorId: 'usr_1',
      createId: () => 'var_api_base',
    }),
    store.mutateSiteVar({
      environment: 'production',
      siteId: 'site_1',
      operation: 'put',
      name: 'FEATURE_FLAG',
      value: 'on',
      actorId: 'usr_1',
      createId: () => 'var_feature_flag',
    }),
  ]);

  assert.deepEqual(
    (await store.listEnabledSiteVars('production', 'site_1')).map(({ name, value }) => ({ name, value })),
    [
      { name: 'API_BASE', value: 'https://api.example.com' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ]
  );
});

test('D1 store does not reuse site var revisions after delete and recreate', async () => {
  const rows = new Map();
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeRuntimeConfigDb({ siteVars: rows, routes });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { API_BASE: 'https://api.example.com' },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
    createId: () => 'var_api_base_1',
  });
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: {},
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:01:00.000Z',
    createId: () => 'unused',
  });
  const recreated = await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { API_BASE: 'https://api.example.com' },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:02:00.000Z',
    createId: () => 'var_api_base_2',
  });

  assert.equal(recreated[0].id, 'var_api_base_2');
  assert.equal(recreated[0].revision, 2);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 3);
});

test('D1 store fails site var replacement without partial writes when another replacement holds runtime lock', async () => {
  const rows = new Map([
    [
      'production:site_1:API_BASE:var_api_base',
      {
        id: 'var_api_base',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_BASE',
        value: 'https://api.example.com/v1',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
    [
      'production:site_1:FEATURE_FLAG:var_feature_flag',
      {
        id: 'var_feature_flag',
        environment: 'production',
        site_id: 'site_1',
        name: 'FEATURE_FLAG',
        value: 'on',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const routes = new Map([
    [
      'production:site_1',
      {
        runtime_config_generation: 0,
        runtime_config_lock_id: 'runtime_lock_active',
        runtime_config_lock_expires_at: '2026-06-15T00:01:30.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  ]);
  const db = fakeRuntimeConfigDb({
    siteVars: rows,
    routes,
  });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    () =>
      store.replaceSiteVars({
        environment: 'production',
        siteId: 'site_1',
        vars: {
          API_BASE: 'https://api.example.com/v2',
          FEATURE_FLAG: 'maybe',
        },
        actorId: 'usr_1',
        updatedAt: '2026-06-15T00:01:00.000Z',
        createId: (name) => `var_${name.toLowerCase()}_new`,
      }),
    /SITE_VAR_REVISION_CONFLICT/
  );

  assert.equal(liveVarRow(rows, 'production', 'site_1', 'API_BASE').value, 'https://api.example.com/v1');
  assert.equal(liveVarRow(rows, 'production', 'site_1', 'FEATURE_FLAG').value, 'on');
  assert.equal(routes.get('production:site_1').runtime_config_generation, 0);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, 'runtime_lock_active');
});

test('D1 store rolls back site var replacement when a later guarded write fails', async () => {
  const rows = new Map([
    [
      'production:site_1:API_BASE:var_api_base',
      {
        id: 'var_api_base',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_BASE',
        value: 'https://api.example.com/v1',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
    [
      'production:site_1:FEATURE_FLAG:var_feature_flag',
      {
        id: 'var_feature_flag',
        environment: 'production',
        site_id: 'site_1',
        name: 'FEATURE_FLAG',
        value: 'on',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  let varWrites = 0;
  const db = fakeRuntimeConfigDb({
    siteVars: rows,
    routes,
    hooks: {
      beforeSiteVarWrite: () => {
        varWrites += 1;
        return varWrites === 2 ? { changes: 0 } : null;
      },
    },
  });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    () =>
      store.replaceSiteVars({
        environment: 'production',
        siteId: 'site_1',
        vars: {
          API_BASE: 'https://api.example.com/v2',
          FEATURE_FLAG: 'maybe',
        },
        actorId: 'usr_1',
        updatedAt: '2026-06-15T00:01:00.000Z',
        createId: (name) => `var_${name.toLowerCase()}_new`,
      }),
    /SITE_VAR_REVISION_CONFLICT/
  );

  assert.equal(liveVarRow(rows, 'production', 'site_1', 'API_BASE').value, 'https://api.example.com/v1');
  assert.equal(liveVarRow(rows, 'production', 'site_1', 'FEATURE_FLAG').value, 'on');
  assert.equal(routes.get('production:site_1').runtime_config_generation, 0);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('D1 store sends prepared statements to batch when replacing site vars', async () => {
  const rows = new Map([
    [
      'production:site_1:API_BASE:var_api_base',
      {
        id: 'var_api_base',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_BASE',
        value: 'https://api.example.com/v1',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const batchStatements = [];
  const db = fakeRuntimeConfigDb({
    siteVars: rows,
    routes,
    hooks: {
      afterRuntimeConfigBatch: ({ statements }) => {
        batchStatements.push(...statements);
      },
    },
  });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { API_BASE: 'https://api.example.com/v2' },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:01:00.000Z',
    createId: (name) => `var_${name.toLowerCase()}_new`,
  });

  assert.ok(batchStatements.length >= 2);
  const hasPreparedStatement = batchStatements.some((statement) => typeof statement.bind === 'function');
  const hasRunOnlyWrapper = batchStatements.some(
    (statement) => typeof statement.run === 'function' && typeof statement.bind !== 'function'
  );
  assert.equal(hasPreparedStatement, true);
  assert.equal(hasRunOnlyWrapper, false);
});

test('test store rejects a site secret that conflicts with an existing runtime var', async () => {
  const store = createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com',
    actorId: 'usr_1',
    createId: () => 'var_api_base',
  });

  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_1',
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_BASE',
      value: 'secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    /RUNTIME_BINDING_NAME_CONFLICT/
  );
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), []);
  assert.deepEqual(await store.listAuditEvents({ environment: 'production' }), []);
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).runtimeConfigGeneration, 1);
});

test('D1 store rejects a site secret that conflicts with an existing runtime var without partial writes', async () => {
  const siteVars = new Map([
    [
      'production:site_1:API_BASE:var_api_base',
      {
        id: 'var_api_base',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_BASE',
        value: 'https://api.example.com',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const siteSecrets = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 1, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, siteSecrets, auditRows, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_1',
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_BASE',
      value: 'secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    /RUNTIME_BINDING_NAME_CONFLICT/
  );
  assert.equal(siteSecrets.size, 0);
  assert.deepEqual(auditRows, []);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('test store rejects a site secret when vars and secrets would exceed the shared binding quota', async () => {
  const store = createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  for (let index = 0; index < 64; index += 1) {
    const name = `VAR_${String(index).padStart(2, '0')}`;
    store.siteVars.set(`production:site_1:${name}`, {
      id: `var_${index}`,
      environment: 'production',
      siteId: 'site_1',
      name,
      value: String(index),
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    });
  }

  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_1',
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'DEPLOY_KEY',
      value: 'secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    /RUNTIME_BINDINGS_LIMIT_EXCEEDED/
  );
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), []);
  assert.deepEqual(await store.listAuditEvents({ environment: 'production' }), []);
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).runtimeConfigGeneration, 0);
});

test('D1 store rejects a site secret when vars and secrets would exceed the shared binding quota', async () => {
  const siteVars = new Map();
  for (let index = 0; index < 64; index += 1) {
    const name = `VAR_${String(index).padStart(2, '0')}`;
    siteVars.set(`production:site_1:${name}:var_${index}`, {
      id: `var_${index}`,
      environment: 'production',
      site_id: 'site_1',
      name,
      value: String(index),
      revision: 1,
      created_by: 'usr_1',
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:00.000Z',
      deleted_at: null,
    });
  }
  const siteSecrets = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 64, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, siteSecrets, auditRows, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_1',
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'DEPLOY_KEY',
      value: 'secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    /RUNTIME_BINDINGS_LIMIT_EXCEEDED/
  );
  assert.equal(siteSecrets.size, 0);
  assert.deepEqual(auditRows, []);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 64);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('D1 store writes site secrets and audit events in one batch', async () => {
  const rows = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeSiteSecretsDb(rows, auditRows, { routes });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  const secret = await store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    value: 'super-secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });

  assert.equal(secret.revision, 1);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
  assert.equal(liveSecretRow(rows, 'production', 'site_1', 'API_TOKEN').encrypted_value.includes('super-secret-value'), false);
  assert.deepEqual(auditRows.map((row) => ({
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    siteId: row.site_id,
    routeId: row.route_id,
    metadata: JSON.parse(row.metadata_json),
  })), [
    {
      eventType: 'site_secret.put',
      actorUserId: 'usr_1',
      siteId: 'site_1',
      routeId: 'route_1',
      metadata: { siteSlug: 'guide', revision: 1 },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(auditRows), /API_TOKEN/);
  assert.doesNotMatch(JSON.stringify(auditRows), /super-secret-value/);
});

test('D1 store increments site secret revisions on updates atomically with audit', async () => {
  const rows = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeSiteSecretsDb(rows, auditRows, { routes });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });
  const updated = await store.putSiteSecretWithAudit({
    id: 'sec_ignored',
    auditId: 'aud_2',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    value: 'second-secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });

  assert.equal(updated.id, 'sec_1');
  assert.equal(updated.revision, 2);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 2);
  assert.equal(liveSecretRow(rows, 'production', 'site_1', 'API_TOKEN').revision, 2);
  assert.deepEqual(auditRows.map((row) => JSON.parse(row.metadata_json)), [
    { siteSlug: 'guide', revision: 1 },
    { siteSlug: 'guide', revision: 2 },
  ]);
});

test('D1 store does not reuse site secret revisions after delete and recreate', async () => {
  const rows = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeSiteSecretsDb(rows, auditRows, { routes });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });
  await store.deleteSiteSecretWithAudit({
    auditId: 'aud_2',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
    deletedAt: '2026-06-15T00:01:00.000Z',
  });
  const recreated = await store.putSiteSecretWithAudit({
    id: 'sec_2',
    auditId: 'aud_3',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    value: 'second-secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
    updatedAt: '2026-06-15T00:02:00.000Z',
  });

  assert.equal(recreated.id, 'sec_2');
  assert.equal(recreated.revision, 2);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 3);
  assert.deepEqual(auditRows.map((row) => JSON.parse(row.metadata_json)), [
    { siteSlug: 'guide', revision: 1 },
    { siteSlug: 'guide', revision: 1 },
    { siteSlug: 'guide', revision: 2 },
  ]);
});

test('D1 store fails closed when a concurrent site secret update wins the revision race', async () => {
  const rows = new Map();
  const auditRows = [];
  let raceAfterRead = false;
  let raced = false;
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeSiteSecretsDb(rows, auditRows, {
    routes,
    afterSiteSecretFirst: () => {
      if (!raceAfterRead || raced) return;
      raced = true;
      liveSecretRow(rows, 'production', 'site_1', 'API_TOKEN').revision = 2;
    },
  });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  await store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });

  raceAfterRead = true;
  await assert.rejects(
    store.putSiteSecretWithAudit({
      id: 'sec_ignored',
      auditId: 'aud_2',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_TOKEN',
      value: 'stale-secret-value',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    }),
    /SITE_SECRET_REVISION_CONFLICT/
  );

  assert.equal(liveSecretRow(rows, 'production', 'site_1', 'API_TOKEN').revision, 2);
  assert.deepEqual(auditRows.map((row) => row.id), ['aud_1']);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
});

test('D1 store deletes site secrets without decrypting existing ciphertext', async () => {
  const rows = new Map();
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeSiteSecretsDb(rows, auditRows, { routes });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  rows.set('production:site_1:API_TOKEN', {
    id: 'sec_1',
    environment: 'production',
    site_id: 'site_1',
    name: 'API_TOKEN',
    encrypted_value: 'not-a-valid-ciphertext',
    revision: 3,
    created_by: 'usr_1',
    created_at: '2026-06-15T00:00:00.000Z',
    updated_at: '2026-06-15T00:00:00.000Z',
    deleted_at: null,
  });

  const secret = await store.deleteSiteSecretWithAudit({
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
    deletedAt: '2026-06-15T00:01:00.000Z',
  });

  assert.deepEqual(secret, {
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    revision: 3,
    createdBy: 'usr_1',
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:01:00.000Z',
    deletedAt: '2026-06-15T00:01:00.000Z',
  });
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
  assert.equal(secretRowById(rows, 'sec_1').deleted_at, '2026-06-15T00:01:00.000Z');
  assert.deepEqual(auditRows.map((row) => JSON.parse(row.metadata_json)), [{ siteSlug: 'guide', revision: 3 }]);
  assert.doesNotMatch(JSON.stringify(auditRows), /API_TOKEN|not-a-valid-ciphertext/);
});

test('D1 store refuses audited site secret deletion while another runtime mutation holds the lock', async () => {
  const rows = new Map([
    [
      'production:site_1:API_TOKEN',
      {
        id: 'sec_1',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_TOKEN',
        encrypted_value: 'encrypted-value',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const auditRows = [];
  const routes = new Map([
    [
      'production:site_1',
      {
        runtime_config_generation: 1,
        runtime_config_lock_id: 'runtime_lock_active',
        runtime_config_lock_expires_at: '2026-06-15T00:01:30.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  ]);
  const store = new D1PagesStore(fakeSiteSecretsDb(rows, auditRows, { routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  await assert.rejects(
    store.deleteSiteSecretWithAudit({
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_TOKEN',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
      deletedAt: '2026-06-15T00:01:00.000Z',
    }),
    /SITE_SECRET_REVISION_CONFLICT/
  );
  assert.equal(secretRowById(rows, 'sec_1').deleted_at, null);
  assert.deepEqual(auditRows, []);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, 'runtime_lock_active');
});

test('D1 store can delete a site secret from an over-limit conflicting historical binding state', async () => {
  const siteVars = new Map();
  for (let index = 0; index < 64; index += 1) {
    const name = index === 0 ? 'API_TOKEN' : `VAR_${String(index).padStart(2, '0')}`;
    siteVars.set(`production:site_1:${name}:var_${index}`, {
      id: `var_${index}`,
      environment: 'production',
      site_id: 'site_1',
      name,
      value: String(index),
      revision: 1,
      created_by: 'usr_1',
      created_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:00.000Z',
      deleted_at: null,
    });
  }
  const siteSecrets = new Map([
    [
      'production:site_1:API_TOKEN',
      {
        id: 'sec_1',
        environment: 'production',
        site_id: 'site_1',
        name: 'API_TOKEN',
        encrypted_value: 'not-a-valid-ciphertext',
        revision: 1,
        created_by: 'usr_1',
        created_at: '2026-06-15T00:00:00.000Z',
        updated_at: '2026-06-15T00:00:00.000Z',
        deleted_at: null,
      },
    ],
  ]);
  const auditRows = [];
  const routes = new Map([['production:site_1', { runtime_config_generation: 65, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const store = new D1PagesStore(fakeRuntimeConfigDb({ siteVars, siteSecrets, auditRows, routes }), {
    now: () => '2026-06-15T00:01:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });

  const deleted = await store.deleteSiteSecretWithAudit({
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_TOKEN',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
    deletedAt: '2026-06-15T00:01:00.000Z',
  });

  assert.equal(deleted.name, 'API_TOKEN');
  assert.equal(secretRowById(siteSecrets, 'sec_1').deleted_at, '2026-06-15T00:01:00.000Z');
  assert.deepEqual(auditRows.map((row) => row.id), ['aud_1']);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 66);
  assert.equal(routes.get('production:site_1').runtime_config_lock_id, null);
});

test('test store serializes audited site secret deletion with other runtime mutations', async () => {
  const store = createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'secret-value',
    actorId: 'usr_1',
  });
  let releaseLock;
  const held = store.withRuntimeConfigQueue(
    'production',
    'site_1',
    () => new Promise((resolve) => {
      releaseLock = resolve;
    })
  );
  await Promise.resolve();
  let deletionFinished = false;
  const deletion = store
    .deleteSiteSecretWithAudit({
      auditId: 'aud_1',
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'guide',
      name: 'API_TOKEN',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    })
    .then(() => {
      deletionFinished = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(deletionFinished, false);
  releaseLock();
  await held;
  await deletion;
  assert.equal(deletionFinished, true);
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), []);
});

test('D1 store deleteSiteSecret fails closed without deleting when revision changed after read', async () => {
  const rows = new Map();
  const auditRows = [];
  let raceAfterRead = false;
  let raced = false;
  const routes = new Map([['production:site_1', { runtime_config_generation: 0, updated_at: '2026-06-15T00:00:00.000Z' }]]);
  const db = fakeSiteSecretsDb(rows, auditRows, {
    routes,
    afterSiteSecretFirst: () => {
      if (!raceAfterRead || raced) return;
      raced = true;
      liveSecretRow(rows, 'production', 'site_1', 'API_TOKEN').revision = 2;
    },
  });
  const store = new D1PagesStore(db, {
    now: () => '2026-06-15T00:00:00.000Z',
    secretEncryptionKey: 'test-encryption-key',
  });
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
  });

  raceAfterRead = true;
  await assert.rejects(
    () =>
      store.deleteSiteSecret('production', 'site_1', 'API_TOKEN', {
        deletedAt: '2026-06-15T00:01:00.000Z',
      }),
    /SITE_SECRET_REVISION_CONFLICT/
  );

  const live = liveSecretRow(rows, 'production', 'site_1', 'API_TOKEN');
  assert.equal(live.revision, 2);
  assert.equal(live.deleted_at, null);
  assert.equal(routes.get('production:site_1').runtime_config_generation, 1);
});

test('D1 store fails closed when writing secrets without an encryption key', async () => {
  const store = new D1PagesStore(fakeSiteSecretsDb(new Map()), {
    now: () => '2026-06-15T00:00:00.000Z',
  });

  await assert.rejects(
    () =>
      store.putSiteSecret({
        id: 'sec_1',
        environment: 'production',
        siteId: 'site_1',
        name: 'API_TOKEN',
        value: 'super-secret-value',
        actorId: 'usr_1',
      }),
    /SITE_SECRET_ENCRYPTION_KEY_REQUIRED/
  );
});

test('D1 store authorizes site-scoped access keys without member rows', async () => {
  const db = fakeSiteReadDb({
    sites: [
      siteRow({
        id: 'site_1',
        slug: 'docs',
        environment: 'production',
        ownerUserId: 'usr_owner',
      }),
      siteRow({
        id: 'site_2',
        slug: 'other',
        environment: 'production',
        ownerUserId: 'usr_owner',
      }),
    ],
    routes: [
      routeRow({
        id: 'route_1',
        siteId: 'site_1',
        hostname: 'docs.pages.xd.team',
        environment: 'production',
      }),
    ],
    members: [],
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });
  const actor = { type: 'access_key', siteId: 'site_1' };

  const site = await store.getSiteForUser('site_1', 'usr_owner', actor, 'production');
  const sites = await store.listSitesForUser('usr_owner', actor, 'production');

  assert.equal(site.id, 'site_1');
  assert.equal(site.route.id, 'route_1');
  assert.deepEqual(sites.map((item) => item.id), ['site_1']);
  assert.equal(await store.getSiteForUser('site_2', 'usr_owner', actor, 'production'), null);
  assert.deepEqual(await store.listSitesForUser('usr_owner', { type: 'user' }, 'production'), []);
});

test('team-owned sites require active team membership instead of stale site member fallback', async () => {
  const store = createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
  });
  await store.createSite({
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_publisher',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });
  await store.removeTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    actorUserId: 'usr_admin',
  });

  const site = await store.getSiteForUser(
    'site_team',
    'usr_publisher',
    { type: 'user', userId: 'usr_publisher' },
    'production'
  );

  assert.equal(site, null);
});

test('D1 transferSiteOwner updates owner fields and removes stale personal members', async () => {
  const db = fakeTransferSiteOwnerDb({
    site: siteRow({
      id: 'site_team',
      slug: 'team-guide',
      ownerType: 'team',
      ownerId: 'team_1',
      ownerUserId: 'usr_creator',
      environment: 'production',
    }),
    members: [
      {
        site_id: 'site_team',
        user_id: 'usr_creator',
        role: 'owner',
        created_by: 'usr_creator',
        created_at: '2026-06-15T00:00:00.000Z',
      },
      {
        site_id: 'site_team',
        user_id: 'usr_1',
        role: 'viewer',
        created_by: 'usr_creator',
        created_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  });
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const site = await store.transferSiteOwner(
    'site_team',
    {
      ownerType: 'user',
      ownerId: 'usr_1',
      ownerUserId: 'usr_1',
      updatedAt: '2026-06-15T00:01:00.000Z',
    },
    'production'
  );

  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_1');
  assert.equal(site.ownerUserId, 'usr_1');
  assert.deepEqual(db.state.members, [
    {
      site_id: 'site_team',
      user_id: 'usr_1',
      role: 'owner',
      created_by: 'usr_creator',
      created_at: '2026-06-15T00:00:00.000Z',
    },
  ]);
});

test('D1 getSiteForUser decorates team role and limits site member fallback to user-owned sites', async () => {
  const capturedSql = [];
  const db = {
    prepare(sql) {
      capturedSql.push(sql);
      return {
        bind() {
          return {
            first: async () => null,
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  await store.getSiteForUser('site_team', 'usr_publisher', { type: 'user', userId: 'usr_publisher' }, 'production');

  const sql = capturedSql.join('\n');
  assert.match(sql, /team_members\.role AS management_role/);
  assert.match(sql, /site_members\.user_id IS NOT NULL\s+AND COALESCE\(sites\.owner_type, 'user'\) = 'user'/);
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

test('conditional route restore ignores runtime config generation but preserves the latest value', async () => {
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

  await store.bumpRuntimeConfigGeneration('production', 'site_1', '2026-06-15T00:01:30.000Z');
  const restored = await store.restoreSiteRouteIfCurrent('site_1', previousRoute, failedRoute, 'production');

  assert.equal(restored.activeVersionId, previousRoute.activeVersionId);
  assert.equal(restored.workerName, previousRoute.workerName);
  assert.equal(restored.routeGeneration, failedRoute.routeGeneration + 1);
  assert.equal(restored.runtimeConfigGeneration, failedRoute.runtimeConfigGeneration + 1);
  assert.equal(restored.updatedAt, '2026-06-15T00:01:30.000Z');
  assert.equal((await store.getRouteBySiteId('site_1')).runtimeConfigGeneration, failedRoute.runtimeConfigGeneration + 1);
});

test('conditional route restore advances route generation as a new route commit', async () => {
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
  await store.updateSiteVisibility('site_1', { visibility: 'owner', updatedAt: '2026-06-15T00:01:30.000Z' }, 'production');

  const restored = await store.restoreSiteRouteIfCurrent('site_1', previousRoute, failedRoute, 'production');

  assert.equal(restored.activeVersionId, previousRoute.activeVersionId);
  assert.equal(restored.workerName, previousRoute.workerName);
  assert.equal(restored.routeGeneration, failedRoute.routeGeneration + 1);
  assert.equal(restored.visibility, 'owner');
  assert.equal(restored.policyVersion, failedRoute.policyVersion + 1);
  assert.equal(restored.cacheTier, 'sensitive');
});

test('D1 restoreSiteDeleteIfCurrent restores site, route, and hostname claim state', async () => {
  const sites = [
    siteRow({
      id: 'site_1',
      slug: 'docs',
      ownerUserId: 'usr_1',
      defaultVisibility: 'org',
      siteUuid: 'uuid_1',
    }),
  ];
  const routes = [
    routeRow({
      id: 'route_1',
      siteId: 'site_1',
      hostname: 'docs.pages.xd.team',
      runtime: 'worker',
      workerName: 'pages-v2-docs-ver-1',
      dispatchType: 'dispatch-namespace',
      activeVersionId: 'ver_1',
      routeGeneration: 1,
      routeStatus: 'active',
    }),
  ];
  const claims = [
    hostnameClaimRow({
      environment: 'production',
      hostname: 'docs.pages.xd.team',
      normalizedSlug: 'docs',
      hostnameFamily: 'pages',
      ownerSystem: 'v2',
      ownerId: 'site_1',
      ownerRef: 'route_1',
      source: 'v2_create',
      status: 'active',
    }),
  ];
  const store = new D1PagesStore(fakeSiteDeleteRestoreDb({ sites, routes, claims }));
  const previousSite = await store.getSite('site_1');
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');
  const previousHostnameClaim = await store.getHostnameClaim('docs.pages.xd.team');

  sites[0].deleted_at = '2026-06-15T00:02:00.000Z';
  sites[0].updated_at = '2026-06-15T00:02:00.000Z';
  Object.assign(routes[0], {
    runtime: 'disabled',
    worker_name: null,
    dispatch_type: null,
    dispatch_binding_name: null,
    slot_id: null,
    active_version_id: null,
    route_generation: 2,
    route_status: 'deleted',
    updated_at: '2026-06-15T00:02:00.000Z',
  });
  Object.assign(claims[0], {
    status: 'held',
    released_at: '2026-06-15T00:02:00.000Z',
    reuse_hold_until: '2026-06-15T00:07:00.000Z',
    release_reason: 'site_deleted',
    updated_at: '2026-06-15T00:02:00.000Z',
  });
  const expectedRoute = await store.getRouteBySiteId('site_1', 'production');

  const restored = await store.restoreSiteDeleteIfCurrent(
    'site_1',
    previousSite,
    previousRoute,
    previousHostnameClaim,
    expectedRoute,
    'production'
  );

  assert.equal(sites[0].deleted_at, null);
  assert.equal(sites[0].updated_at, '2026-06-15T00:00:00.000Z');
  assert.equal(restored.activeVersionId, 'ver_1');
  assert.equal(restored.workerName, 'pages-v2-docs-ver-1');
  assert.equal(restored.routeStatus, 'active');
  assert.equal(restored.routeGeneration, 3);
  assert.equal(claims[0].status, 'active');
  assert.equal(claims[0].released_at, null);
  assert.equal(claims[0].reuse_hold_until, null);
  assert.equal(claims[0].release_reason, null);
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

test('deployment records persist failure stage and diagnostics', async () => {
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

  await store.updateDeployment('dep_1', {
    status: 'failed',
    errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
    errorMessage: 'Deployment upload failed.',
    failureStage: 'upload_worker',
    failureDiagnostics: {
      schemaVersion: 1,
      stage: 'upload_worker',
      retryable: true,
      cause: { code: 'DEPLOYMENT_UPLOAD_FAILED' },
    },
    completedAt: '2026-06-15T00:00:00.000Z',
  });

  assert.deepEqual(await store.getDeployment('dep_1'), {
    id: 'dep_1',
    environment: 'production',
    siteId: 'site_1',
    versionId: null,
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    operation: 'deploy',
    visibility: 'org',
    status: 'failed',
    idempotencyKey: 'idem_1',
    idempotencyScope: 'production:usr_1:site_1:deploy',
    requestHash: 'hash_a',
    terminalResponseJson: null,
    previousVersionId: null,
    errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
    errorMessage: 'Deployment upload failed.',
    failureStage: 'upload_worker',
    failureDiagnostics: {
      schemaVersion: 1,
      stage: 'upload_worker',
      retryable: true,
      cause: { code: 'DEPLOYMENT_UPLOAD_FAILED' },
    },
    createdAt: '2026-06-15T00:00:00.000Z',
    completedAt: '2026-06-15T00:00:00.000Z',
  });
});

test('cleanup task lifecycle tracks WFP resource deletion attempts', async () => {
  const store = createSeededStore();
  await createSite(store);
  await store.createSiteVersion({
    id: 'ver_old',
    siteId: 'site_1',
    deploymentId: 'dep_old',
    workerName: 'pages-v2-docs-ver-old',
    runtime: 'worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-docs-ver-old',
    contentHash: 'sha256:old',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_1',
  });

  await store.createDeploymentResourceCleanupTask({
    id: 'cln_1',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-docs-ver-old',
    siteId: 'site_1',
    versionId: 'ver_old',
    deploymentId: 'dep_new',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-06-15T00:05:00.000Z',
  });
  await store.markDeploymentResourceCleanupRunning({
    id: 'cln_1',
    environment: 'production',
    lockedUntil: '2026-06-15T00:01:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  await store.finishDeploymentResourceCleanupTask({
    id: 'cln_1',
    environment: 'production',
    status: 'succeeded',
    updatedAt: '2026-06-15T00:00:10.000Z',
  });
  await store.markSiteVersionArtifactAvailability({
    id: 'ver_old',
    environment: 'production',
    artifactAvailability: 'retired',
  });

  assert.deepEqual(await store.listDeploymentResourceCleanupTasks({ environment: 'production' }), [
    {
      id: 'cln_1',
      environment: 'production',
      resourceType: 'wfp_user_worker',
      resourceRef: 'pages-v2-docs-ver-old',
      siteId: 'site_1',
      versionId: 'ver_old',
      deploymentId: 'dep_new',
      cleanupReason: 'blue_green_previous_worker',
      status: 'succeeded',
      cleanupAfter: '2026-06-15T00:05:00.000Z',
      attemptCount: 1,
      lastErrorCode: null,
      lastErrorMessage: null,
      lockedUntil: null,
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:10.000Z',
    },
  ]);
  assert.equal((await store.getSiteVersion('ver_old')).artifactAvailability, 'retired');
});

test('D1 admin dashboard returns lightweight cleanup backlog aggregates', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        bind() {
          statements.push(sql);
          return statement;
        },
        async first() {
          if (sql.includes("status = 'pending'") && sql.includes('COUNT(*)')) return { count: 2 };
          if (sql.includes("status = 'failed'") && sql.includes('deployment_resource_cleanup_tasks')) {
            return { count: 1 };
          }
          if (sql.includes('MIN(cleanup_after)')) return { oldest_pending_at: '2026-06-15T00:00:00.000Z' };
          return { count: 0 };
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  };
  const store = new D1PagesStore(db);

  const dashboard = await store.getAdminDashboard({ environment: 'production' });

  assert.deepEqual(dashboard.resourceCleanup, {
    pendingTasks: 2,
    failedTasks: 1,
    oldestPendingAt: '2026-06-15T00:00:00.000Z',
  });
  assert.equal(statements.filter((sql) => sql.includes('deployment_resource_cleanup_tasks')).length, 3);
});

test('D1 store exposes environment-scoped resource governance references and active slugs', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            async all() {
              if (sql.includes('FROM site_routes')) {
                return {
                  results: [
                    {
                      worker_name: 'pages-v2-active',
                      site_id: 'site_active',
                      active_version_id: 'ver_active',
                      execution_provider: 'wfp',
                      dispatch_type: 'dispatch-namespace',
                    },
                  ],
                };
              }
              if (sql.includes('FROM site_versions')) {
                return {
                  results: [
                    {
                      id: 'ver_old',
                      worker_name: 'pages-v2-old',
                      site_id: 'site_docs',
                      site_slug: 'docs',
                      site_deleted_at: null,
                      artifact_availability: 'retired',
                      execution_provider: 'wfp',
                      dispatch_type: 'dispatch-namespace',
                      created_at: '2026-07-01T00:00:00.000Z',
                    },
                  ],
                };
              }
              if (sql.includes('FROM deployment_resource_cleanup_tasks')) {
                return {
                  results: [
                    {
                      id: 'cln_old',
                      resource_ref: 'pages-v2-old',
                      status: 'failed',
                    },
                  ],
                };
              }
              if (sql.includes('SELECT id, slug FROM sites')) {
                return { results: [{ id: 'site_docs', slug: 'docs' }] };
              }
              throw new Error(`unexpected SQL: ${sql}`);
            },
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db);

  assert.deepEqual(await store.listWorkerOrphanScanReferences({ environment: 'production' }), {
    activeRoutes: [
      {
        workerName: 'pages-v2-active',
        siteId: 'site_active',
        versionId: 'ver_active',
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
      },
    ],
    versions: [
      {
        id: 'ver_old',
        workerName: 'pages-v2-old',
        siteId: 'site_docs',
        siteSlug: 'docs',
        siteDeletedAt: null,
        artifactAvailability: 'retired',
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
    cleanupTasks: [{ id: 'cln_old', resourceRef: 'pages-v2-old', status: 'failed' }],
  });
  assert.deepEqual(await store.listActiveSiteSlugs({ environment: 'production' }), [{ id: 'site_docs', slug: 'docs' }]);
  assert.equal(calls.length, 4);
  assert.equal(
    calls.every((call) => call.args[0] === 'production'),
    true
  );
  assert.match(calls[0].sql, /route_status = 'active'/);
  assert.match(calls[1].sql, /LEFT JOIN sites/);
  assert.match(calls[2].sql, /status IN \('pending', 'failed', 'running'\)/);
  assert.match(calls[3].sql, /deleted_at IS NULL/);
});

test('D1 store lists cleanup references with site_id-indexed route and version queries', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            async all() {
              if (sql.includes('FROM site_routes')) {
                return {
                  results: [
                    {
                      worker_name: 'pages-v2-active',
                      site_id: 'site_docs',
                      active_version_id: 'ver_active',
                      execution_provider: 'wfp',
                      dispatch_type: 'dispatch-namespace',
                    },
                  ],
                };
              }
              return {
                results: [
                  {
                    id: 'ver_old',
                    worker_name: 'pages-v2-old',
                    site_id: 'site_docs',
                    artifact_availability: 'active',
                    execution_provider: 'wfp',
                    dispatch_type: 'dispatch-namespace',
                  },
                ],
              };
            },
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db);

  assert.deepEqual(
    await store.listSiteWfpCleanupReferences({ siteId: 'site_docs', environment: 'production' }),
    {
      activeRoutes: [
        {
          workerName: 'pages-v2-active',
          siteId: 'site_docs',
          versionId: 'ver_active',
          executionProvider: 'wfp',
          dispatchType: 'dispatch-namespace',
        },
      ],
      versions: [
        {
          id: 'ver_old',
          workerName: 'pages-v2-old',
          siteId: 'site_docs',
          artifactAvailability: 'active',
          executionProvider: 'wfp',
          dispatchType: 'dispatch-namespace',
        },
      ],
    }
  );
  assert.deepEqual(calls.map((call) => call.args), [
    ['site_docs', 'production'],
    ['site_docs', 'production'],
  ]);
  assert.match(calls[0].sql, /WHERE site_id = \? AND environment = \?/);
  assert.match(calls[1].sql, /WHERE site_versions\.site_id = \? AND sites\.environment = \?/);
  assert.match(calls[1].sql, /artifact_availability = 'active'/);
});

test('D1 store lists Worker ownership references with Worker-indexed queries', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            async all() {
              if (sql.includes('FROM site_routes')) {
                return {
                  results: [
                    {
                      worker_name: 'pages-v2-owned',
                      site_id: 'site_owned',
                      environment: 'production',
                      active_version_id: 'ver_owned',
                      execution_provider: 'wfp',
                      dispatch_type: 'dispatch-namespace',
                    },
                  ],
                };
              }
              return {
                results: [
                  {
                    id: 'ver_owned',
                    worker_name: 'pages-v2-owned',
                    site_id: 'site_owned',
                    ownership_environment: 'production',
                    execution_provider: 'wfp',
                    dispatch_type: 'dispatch-namespace',
                  },
                ],
              };
            },
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db);

  assert.deepEqual(
    await store.listWorkerCleanupOwnershipReferences({
      workerName: 'pages-v2-owned',
      environment: 'production',
    }),
    {
      routes: [
        {
          workerName: 'pages-v2-owned',
          siteId: 'site_owned',
          versionId: 'ver_owned',
          ownershipEnvironment: 'production',
          executionProvider: 'wfp',
          dispatchType: 'dispatch-namespace',
        },
      ],
      versions: [
        {
          id: 'ver_owned',
          workerName: 'pages-v2-owned',
          siteId: 'site_owned',
          ownershipEnvironment: 'production',
          executionProvider: 'wfp',
          dispatchType: 'dispatch-namespace',
        },
      ],
    }
  );
  assert.deepEqual(calls.map((call) => call.args), [
    ['pages-v2-owned'],
    ['pages-v2-owned'],
  ]);
  assert.match(calls[0].sql, /WHERE worker_name = \?/);
  assert.match(calls[1].sql, /LEFT JOIN sites ON sites\.id = site_versions\.site_id/);
  assert.match(calls[1].sql, /WHERE site_versions\.worker_name = \?/);
});

test('D1 store cleanup running lock returns null when CAS loses a race', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => ({
              id: 'cln_1',
              environment: 'production',
              resource_type: 'wfp_user_worker',
              resource_ref: 'pages-v2-docs-ver-old',
              cleanup_reason: 'blue_green_previous_worker',
              status: 'running',
              cleanup_after: '2026-06-15T00:05:00.000Z',
              attempt_count: 1,
              created_at: '2026-06-15T00:00:00.000Z',
              updated_at: '2026-06-15T00:00:00.000Z',
            }),
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const locked = await store.markDeploymentResourceCleanupRunning({
    id: 'cln_1',
    environment: 'production',
    lockedUntil: '2026-06-15T00:05:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });

  assert.equal(locked, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE deployment_resource_cleanup_tasks/);
});

test('D1 store cleanup running lock can recover an expired running task', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            run: async () => ({ meta: { changes: 1 } }),
            first: async () => ({
              id: 'cln_1',
              environment: 'production',
              resource_type: 'wfp_user_worker',
              resource_ref: 'pages-v2-docs-ver-old',
              cleanup_reason: 'blue_green_previous_worker',
              status: 'running',
              cleanup_after: '2026-06-15T00:05:00.000Z',
              attempt_count: 2,
              locked_until: '2026-06-15T00:05:00.000Z',
              created_at: '2026-06-15T00:00:00.000Z',
              updated_at: '2026-06-15T00:00:00.000Z',
            }),
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const locked = await store.markDeploymentResourceCleanupRunning({
    id: 'cln_1',
    environment: 'production',
    lockedUntil: '2026-06-15T00:05:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });

  assert.equal(locked.status, 'running');
  assert.equal(locked.attemptCount, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /status = 'running' AND locked_until <= \?/);
  assert.deepEqual(calls[0].args, [
    '2026-06-15T00:05:00.000Z',
    '2026-06-15T00:00:00.000Z',
    'cln_1',
    'production',
    '2026-06-15T00:00:00.000Z',
  ]);
});

test('D1 store route activation can require an active version artifact in the CAS', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
          };
        },
      };
    },
  };
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const route = await store.activateSiteVersion(
    'site_1',
    {
      activeVersionId: 'ver_1',
      workerName: 'pages-v2-docs-ver-1',
      runtime: 'worker',
      executionProvider: 'wfp',
      dispatchType: 'dispatch-namespace',
      visibility: 'org',
      requiredArtifactAvailability: 'active',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
    'production',
    {
      activeVersionId: 'ver_2',
      routeGeneration: 2,
      policyVersion: 1,
      runtimeConfigGeneration: 0,
    }
  );

  assert.equal(route, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /EXISTS \(\s*SELECT 1 FROM site_versions/s);
  assert.match(calls[0].sql, /site_versions\.artifact_availability = \?/);
  assert.deepEqual(calls[0].args.slice(-2), ['ver_1', 'active']);
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

test('D1 store lists and retires admin normal workers with active route protection', async () => {
  const slots = new Map([
    ['slot_production_001', workerSlotRow({ id: 'slot_production_001', slot_number: 1 })],
    [
      'slot_production_003',
      workerSlotRow({
        id: 'slot_production_003',
        slot_number: 3,
        worker_name: 'pages-v2-production-slot-003',
        binding_name: 'SITE_SLOT_003',
        status: 'assigned',
        assigned_site_id: 'site_orphaned',
        assigned_route_id: 'route_orphaned',
        assigned_version_id: 'ver_orphaned',
      }),
    ],
    [
      'slot_production_007',
      workerSlotRow({
        id: 'slot_production_007',
        slot_number: 7,
        worker_name: 'pages-v2-production-slot-007',
        binding_name: 'SITE_SLOT_007',
        status: 'assigned',
        assigned_site_id: 'site_active',
        assigned_route_id: 'route_active',
        assigned_version_id: 'ver_active',
      }),
    ],
  ]);
  const db = fakeAdminNormalWorkerDb(slots, [
    {
      id: 'route_active',
      environment: 'production',
      route_status: 'active',
      site_id: 'site_active',
      slot_id: 'slot_production_007',
      active_version_id: 'ver_active',
      hostname: 'active.pages.xd.team',
    },
    {
      id: 'route_duplicate',
      environment: 'production',
      route_status: 'active',
      site_id: 'site_duplicate',
      slot_id: null,
      active_version_id: 'ver_active',
      hostname: 'duplicate.pages.xd.team',
    },
  ]);
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const listed = await store.listAdminNormalWorkers({ environment: 'production' });
  const retired = await store.retireIdleNormalWorker({
    id: 'slot_production_001',
    environment: 'production',
    actorUserId: 'usr_root',
    reason: 'legacy drain',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });
  const orphanedAssignedRetire = await store.retireIdleNormalWorker({
    id: 'slot_production_003',
    environment: 'production',
    actorUserId: 'usr_root',
    reason: 'legacy drain',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });
  const activeRetire = await store.retireIdleNormalWorker({
    id: 'slot_production_007',
    environment: 'production',
    actorUserId: 'usr_root',
    reason: 'legacy drain',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });
  const activePending = await store.markNormalWorkerDeletePending({
    id: 'slot_production_007',
    environment: 'production',
    actorUserId: 'usr_root',
    reason: 'legacy drain',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });

  assert.equal(listed[0].activeRoute, null);
  assert.equal(listed[1].activeRoute, null);
  assert.equal(listed.length, 3);
  assert.deepEqual(listed[2].activeRoute, {
    siteId: 'site_active',
    routeId: 'route_active',
    activeVersionId: 'ver_active',
    hostname: 'active.pages.xd.team',
  });
  assert.equal(retired.status, 'retired');
  assert.equal(slots.get('slot_production_001').status, 'retired');
  assert.equal(orphanedAssignedRetire.status, 'retired');
  assert.equal(slots.get('slot_production_003').status, 'retired');
  assert.equal(activeRetire, null);
  assert.equal(activePending, null);
  assert.equal(slots.get('slot_production_007').status, 'assigned');
});

test('D1 store can mark idle admin normal workers delete pending before retry', async () => {
  const slots = new Map([
    ['slot_production_001', workerSlotRow({ id: 'slot_production_001', slot_number: 1 })],
  ]);
  const db = fakeAdminNormalWorkerDb(slots, []);
  const store = new D1PagesStore(db, { now: () => '2026-06-15T00:00:00.000Z' });

  const pending = await store.markNormalWorkerDeletePending({
    id: 'slot_production_001',
    environment: 'production',
    actorUserId: 'usr_root',
    reason: 'stale router binding',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });
  const retired = await store.retireIdleNormalWorker({
    id: 'slot_production_001',
    environment: 'production',
    actorUserId: 'usr_root',
    reason: 'retry after router deploy',
    updatedAt: '2026-06-15T00:02:00.000Z',
  });

  assert.equal(pending.status, 'delete_pending');
  assert.equal(slots.get('slot_production_001').status, 'retired');
  assert.match(pending.notes, /delete pending by usr_root/);
  assert.equal(retired.status, 'retired');
});

test('D1 store upserts SSO users and keeps disabled users disabled', async () => {
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

test('D1 store acquireHostnameClaim rejects same-owner slug conflicts when hostname differs', async () => {
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
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(result.claim.ownerSystem, 'v1');
  assert.equal(await store.getHostnameClaim('portal.pages.xd.team'), null);
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

function userIdentityStoreCases() {
  const now = () => '2026-06-15T00:00:00.000Z';
  return [
    ['test store', () => createTestPagesStore({ now })],
    ['D1 store', () => new D1PagesStore(fakeUserDb(), { now })],
  ];
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
    const [environment, normalizedSlug, now, excludeHostname] = args;
    return (
      [...state.claims.values()].find(
        (claim) =>
          claim.environment === environment &&
          claim.normalized_slug === normalizedSlug &&
          isBlockingCreateSiteClaim(claim, now) &&
          claim.hostname !== excludeHostname
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
      excludeHostname
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
  ] = args;
  if (state.claims.has(hostname)) throw new Error('unique constraint failed: hostname_claims.hostname');
  if (
    hasBlockingCreateSiteClaim(
      state,
      conflictEnvironment,
      conflictSlug,
      conflictNow,
      excludeHostname
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
    runtimeConfigGeneration,
    runtimeConfigLockId,
    runtimeConfigLockExpiresAt,
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
    runtime_config_generation: runtimeConfigGeneration,
    runtime_config_lock_id: runtimeConfigLockId,
    runtime_config_lock_expires_at: runtimeConfigLockExpiresAt,
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

function hasBlockingCreateSiteClaim(state, environment, normalizedSlug, now, excludeHostname) {
  return [...state.claims.values()].some(
    (claim) =>
      claim.environment === environment &&
      claim.normalized_slug === normalizedSlug &&
      isBlockingCreateSiteClaim(claim, now) &&
      claim.hostname !== excludeHostname
  );
}

function isBlockingCreateSiteClaim(claim, now) {
  if (['pending', 'active', 'conflicted'].includes(claim.status)) return true;
  if (claim.status !== 'held') return false;
  return !claim.reuse_hold_until || claim.reuse_hold_until > now;
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

function fakeTransferSiteOwnerDb({ site, members = [] } = {}) {
  const state = {
    site: { ...site },
    members: members.map((member) => ({ ...member })),
  };
  return {
    state,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (/SELECT \* FROM sites WHERE id = \?/.test(sql)) return state.site?.id === args[0] ? state.site : null;
              throw new Error(`Unhandled transfer first SQL: ${sql}`);
            },
            run: async () => {
              if (/UPDATE sites\s+SET owner_type = \?/.test(sql)) {
                const [
                  ownerType,
                  ownerId,
                  ownerUserId,
                  defaultVisibility,
                  defaultAccessMode,
                  updatedAt,
                  siteId,
                  environment,
                ] = args;
                if (state.site?.id !== siteId || state.site?.environment !== environment || state.site?.deleted_at) {
                  return { meta: { changes: 0 } };
                }
                Object.assign(state.site, {
                  owner_type: ownerType,
                  owner_id: ownerId,
                  owner_user_id: ownerUserId,
                  default_visibility: defaultVisibility,
                  default_access_mode: defaultAccessMode,
                  updated_at: updatedAt,
                });
                return { meta: { changes: 1 } };
              }
              if (/DELETE FROM site_members WHERE site_id = \? AND user_id != \?/.test(sql)) {
                const [siteId, userId] = args;
                state.members = state.members.filter((member) => member.site_id !== siteId || member.user_id === userId);
                return { meta: { changes: 1 } };
              }
              if (/INSERT INTO site_members/.test(sql)) {
                const [siteId, userId, createdBy, createdAt] = args;
                const existing = state.members.find((member) => member.site_id === siteId && member.user_id === userId);
                if (existing) existing.role = 'owner';
                else {
                  state.members.push({
                    site_id: siteId,
                    user_id: userId,
                    role: 'owner',
                    created_by: createdBy,
                    created_at: createdAt,
                  });
                }
                return { meta: { changes: 1 } };
              }
              throw new Error(`Unhandled transfer run SQL: ${sql}`);
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
    },
  };
}

function fakeSiteReadDb({ sites = [], routes = [], members = [] } = {}) {
  const state = {
    sites: new Map(sites.map((site) => [site.id, site])),
    routes,
    members,
  };
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => fakeSiteReadRows(state, sql, args)[0] || null,
            all: async () => ({ results: fakeSiteReadRows(state, sql, args) }),
          };
        },
      };
    },
  };
}

function fakeSiteReadRows(state, sql, args) {
  if (!/FROM sites/.test(sql) || !/LEFT JOIN site_routes/.test(sql)) throw new Error(`Unhandled site read SQL: ${sql}`);

  const requiresMember = /JOIN site_members/.test(sql);
  const filtersBySiteId = /WHERE sites\.id = \?/.test(sql) || /AND sites\.id = \?/.test(sql);
  let argIndex = 0;
  let siteId = null;
  let userId = null;
  let environment = null;

  if (/WHERE sites\.id = \?/.test(sql)) siteId = args[argIndex++];
  if (requiresMember) userId = args[argIndex++];
  if (/WHERE site_members\.user_id = \?/.test(sql)) userId = args[argIndex++];
  if (/sites\.environment = \?/.test(sql)) environment = args[argIndex++];
  if (filtersBySiteId && !siteId) siteId = args[argIndex++];

  return [...state.sites.values()]
    .filter((site) => !siteId || site.id === siteId)
    .filter((site) => site.deleted_at == null)
    .filter((site) => !environment || site.environment === environment)
    .filter((site) => !requiresMember || state.members.some((member) => member.site_id === site.id && member.user_id === userId))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((site) => siteJoinedRouteRow(site, state.routes.find((route) => route.site_id === site.id)));
}

function fakeSiteDeleteRestoreDb({ sites = [], routes = [], claims = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => fakeSiteDeleteRestoreFirst({ sites, routes, claims }, sql, args),
            run: async () => fakeSiteDeleteRestoreRun({ sites, routes, claims }, sql, args),
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
    },
  };
}

function fakeSiteDeleteRestoreFirst(state, sql, args) {
  if (/SELECT \* FROM sites WHERE id = \?/.test(sql)) {
    return state.sites.find((site) => site.id === args[0]) || null;
  }
  if (/SELECT \* FROM site_routes WHERE site_id = \?/.test(sql)) {
    const [siteId, environment] = args;
    return (
      state.routes.find((route) => route.site_id === siteId && (!environment || route.environment === environment)) || null
    );
  }
  if (/SELECT \* FROM hostname_claims WHERE hostname = \?/.test(sql)) {
    return state.claims.find((claim) => claim.hostname === args[0]) || null;
  }
  throw new Error(`Unhandled site delete restore SELECT: ${sql}`);
}

function fakeSiteDeleteRestoreRun(state, sql, args) {
  if (/UPDATE sites SET deleted_at = \?, updated_at = \?/.test(sql)) {
    const [deletedAt, updatedAt, siteId, environment] = args;
    const site = state.sites.find((row) => row.id === siteId && (!environment || row.environment === environment));
    if (!site) return { meta: { changes: 0 } };
    site.deleted_at = deletedAt;
    site.updated_at = updatedAt;
    return { meta: { changes: 1 } };
  }
  if (/UPDATE site_routes\s+SET active_version_id = \?/.test(sql)) {
    const [
      activeVersionId,
      workerName,
      runtime,
      executionProvider,
      dispatchType,
      dispatchBindingName,
      slotId,
      visibility,
      exposure,
      accessMode,
      policyVersion,
      routeGeneration,
      runtimeConfigGeneration,
      routeStatus,
      cacheTier,
      updatedAt,
      siteId,
      environment,
    ] = args;
    const route = state.routes.find(
      (row) => row.site_id === siteId && (!environment || row.environment === environment)
    );
    if (!route) return { meta: { changes: 0 } };
    Object.assign(route, {
      active_version_id: activeVersionId,
      worker_name: workerName,
      runtime,
      execution_provider: executionProvider,
      dispatch_type: dispatchType,
      dispatch_binding_name: dispatchBindingName,
      slot_id: slotId,
      visibility,
      exposure,
      access_mode: accessMode,
      policy_version: policyVersion,
      route_generation: routeGeneration,
      runtime_config_generation: runtimeConfigGeneration,
      route_status: routeStatus,
      cache_tier: cacheTier,
      updated_at: updatedAt,
    });
    return { meta: { changes: 1 } };
  }
  if (/UPDATE hostname_claims\s+SET environment = \?/.test(sql)) {
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
      releasedAt,
      reuseHoldUntil,
      releaseReason,
      updatedAt,
      hostname,
      expectedOwnerSystem,
      expectedOwnerId,
    ] = args;
    const claim = state.claims.find(
      (row) =>
        row.hostname === hostname &&
        row.owner_system === expectedOwnerSystem &&
        row.owner_id === expectedOwnerId
    );
    if (!claim) return { meta: { changes: 0 } };
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
      released_at: releasedAt,
      reuse_hold_until: reuseHoldUntil,
      release_reason: releaseReason,
      updated_at: updatedAt,
    });
    return { meta: { changes: 1 } };
  }
  throw new Error(`Unhandled site delete restore UPDATE: ${sql}`);
}

function siteJoinedRouteRow(site, route) {
  return {
    ...site,
    route_id: route?.id || null,
    route_hostname: route?.hostname || null,
    route_runtime: route?.runtime || null,
    route_execution_provider: route?.execution_provider || null,
    route_worker_name: route?.worker_name || null,
    route_dispatch_type: route?.dispatch_type || null,
    route_dispatch_binding_name: route?.dispatch_binding_name || null,
    route_slot_id: route?.slot_id || null,
    route_active_version_id: route?.active_version_id || null,
    route_visibility: route?.visibility || null,
    route_policy_version: route?.policy_version || null,
    route_route_generation: route?.route_generation || null,
    route_runtime_config_generation: route?.runtime_config_generation || 0,
    route_route_status: route?.route_status || null,
    route_cache_tier: route?.cache_tier || null,
    route_created_at: route?.created_at || null,
    route_updated_at: route?.updated_at || null,
  };
}

function consoleDirectorySiteRow({ id, slug, visibility }) {
  return {
    ...siteJoinedRouteRow(
      siteRow({
        id,
        slug,
        ownerUserId: 'usr_owner',
        defaultVisibility: visibility,
      }),
      routeRow({
        id: `route_${id}`,
        siteId: id,
        hostname: `${slug}.pages.xd.team`,
        visibility,
      })
    ),
    owner_user_realname: 'Owner Name',
    owner_user_email: 'owner@example.com',
    owner_team_id: null,
    owner_team_name: null,
    owner_team_type: null,
    owner_team_department_path: null,
  };
}

function fakeConsoleDirectoryDb({ internalRows, accessibleRows }) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      return {
        bind(...args) {
          call.args = args;
          return {
            all: async () => {
              if (sql.includes("COALESCE(site_routes.visibility, sites.default_visibility) = 'internal'")) {
                return { results: internalRows };
              }
              if (sql.includes('JOIN users AS viewer_users')) {
                return { results: accessibleRows };
              }
              return { results: [] };
            },
            first: async () => null,
          };
        },
      };
    },
  };
}

function assertConsoleDirectoryRouteJoin(sql) {
  assert.match(sql, /JOIN site_routes ON site_routes\.id = \(/);
  assert.match(sql, /SELECT route\.id/);
  assert.match(sql, /FROM site_routes AS route/);
  assert.match(sql, /route\.site_id = sites\.id/);
  assert.match(sql, /route\.environment = sites\.environment/);
  assert.match(sql, /route\.route_status = 'active'/);
  assert.doesNotMatch(sql, /route\.route_status != 'deleted'/);
  assert.match(sql, /ORDER BY route\.updated_at DESC, route\.id DESC/);
  assert.match(sql, /LIMIT 1/);
  assert.doesNotMatch(sql, /LEFT JOIN site_routes ON site_routes\.site_id = sites\.id/);
  assert.doesNotMatch(sql, /LEFT JOIN site_routes/);
}

function siteRow({
  id,
  slug,
  environment = 'production',
  ownerUserId = 'usr_1',
  defaultVisibility = 'org',
  executionModeOverride = null,
  siteUuid = `${id}-uuid`,
  createdAt = '2026-06-15T00:00:00.000Z',
  updatedAt = '2026-06-15T00:00:00.000Z',
  deletedAt = null,
}) {
  return {
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
  };
}

function routeRow({
  id,
  siteId,
  hostname,
  environment = 'production',
  runtime = 'worker',
  executionProvider = 'wfp',
  workerName = 'pages-v2-docs-ver-1',
  dispatchType = 'dispatch-namespace',
  dispatchBindingName = null,
  slotId = null,
  activeVersionId = 'ver_1',
  visibility = 'org',
  policyVersion = 1,
  routeGeneration = 1,
  runtimeConfigGeneration = 0,
  routeStatus = 'active',
  cacheTier = 'private',
  createdAt = '2026-06-15T00:00:00.000Z',
  updatedAt = '2026-06-15T00:00:00.000Z',
}) {
  return {
    id,
    site_id: siteId,
    hostname,
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
    runtime_config_generation: runtimeConfigGeneration,
    route_status: routeStatus,
    cache_tier: cacheTier,
    created_at: createdAt,
    updated_at: updatedAt,
  };
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

function fakeAdminNormalWorkerDb(slots, routes = []) {
  function activeRouteForSlot(slot) {
    return routes.find(
      (route) =>
        route.environment === slot.environment &&
        route.route_status === 'active' &&
        (route.slot_id === slot.id || route.active_version_id === slot.assigned_version_id)
    );
  }

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              assert.match(sql, /WITH active_slot_routes AS/);
              assert.match(sql, /GROUP BY worker_slots\.id/);
              const [environment] = args;
              return {
                results: [...slots.values()]
                  .filter((slot) => slot.environment === environment)
                  .sort((left, right) => left.slot_number - right.slot_number)
                  .map((slot) => {
                    const route = activeRouteForSlot(slot);
                    return {
                      ...slot,
                      active_site_id: route?.site_id || null,
                      active_route_id: route?.id || null,
                      active_version_id: route?.active_version_id || null,
                      active_hostname: route?.hostname || null,
                    };
                  }),
              };
            },
            async first() {
              assert.match(sql, /SELECT \* FROM worker_slots WHERE id = \?/);
              const [id] = args;
              return slots.get(id) || null;
            },
            async run() {
              assert.match(sql, /UPDATE worker_slots/);
              assert.match(sql, /'assigned'/);
              const [notes, updatedAt, id, environment] = args;
              const slot = slots.get(id);
              if (
                !slot ||
                slot.environment !== environment ||
                !['available', 'assigned', 'cleanup_pending', 'disabled', 'delete_pending'].includes(slot.status) ||
                activeRouteForSlot(slot)
              ) {
                return { meta: { changes: 0 } };
              }
              if (/SET status = 'delete_pending'/.test(sql)) {
                Object.assign(slot, {
                  status: 'delete_pending',
                  notes,
                  updated_at: updatedAt,
                });
                return { meta: { changes: 1 } };
              }
              Object.assign(slot, {
                status: 'retired',
                assigned_site_id: null,
                assigned_route_id: null,
                assigned_version_id: null,
                assigned_at: null,
                notes,
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
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/SELECT \* FROM users WHERE user_id = \?/.test(sql)) return users.get(args[0]) || null;
              if (/SELECT \* FROM users WHERE lower\(trim\(email\)\) = \?/.test(sql)) {
                return [...users.values()].find((user) => user.email.trim().toLowerCase() === args[0]) || null;
              }
              if (/SELECT \* FROM users WHERE feishu_open_id = \?/.test(sql)) {
                assert.ok(args[0], 'empty Feishu open id should not query D1');
                return [...users.values()].find((user) => user.feishu_open_id === args[0]) || null;
              }
              if (/SELECT \* FROM users WHERE cindy_membership_id = \?/.test(sql)) {
                assert.ok(args[0], 'empty Cindy membership id should not query D1');
                return [...users.values()].find((user) => user.cindy_membership_id === args[0]) || null;
              }
              assert.fail(`Unexpected user query: ${sql}`);
            },
            async run() {
              if (/UPDATE users\s+SET feishu_open_id = \?/.test(sql)) {
                const [feishuOpenId, updatedAt, id, expectedFeishuOpenId] = args;
                assert.ok(feishuOpenId, 'empty Feishu open id should not update D1');
                const user = users.get(id) || null;
                if (!user || (user.feishu_open_id !== null && user.feishu_open_id !== expectedFeishuOpenId)) {
                  return { meta: { changes: 0 } };
                }
                const feishuIdConflict = [...users.values()].some(
                  (candidate) => candidate.user_id !== id && candidate.feishu_open_id === feishuOpenId
                );
                if (feishuIdConflict) {
                  return { meta: { changes: 0 } };
                }
                user.feishu_open_id = feishuOpenId;
                user.updated_at = updatedAt;
                return { meta: { changes: 1 } };
              }
              if (/UPDATE users\s+SET cindy_membership_id = \?/.test(sql)) {
                const [membershipId, updatedAt, id, expectedMembershipId] = args;
                assert.ok(membershipId, 'empty Cindy membership id should not update D1');
                const user = users.get(id) || null;
                if (!user || (user.cindy_membership_id !== null && user.cindy_membership_id !== expectedMembershipId)) {
                  return { meta: { changes: 0 } };
                }
                const membershipConflict = [...users.values()].some(
                  (candidate) => candidate.user_id !== id && candidate.cindy_membership_id === membershipId
                );
                if (membershipConflict) {
                  return { meta: { changes: 0 } };
                }
                user.cindy_membership_id = membershipId;
                user.updated_at = updatedAt;
                return { meta: { changes: 1 } };
              }

              assert.match(sql, /INSERT INTO users/);
              const [
                id,
                account,
                accountId,
                email,
                realname,
                employeenum,
                employeeStatus,
                feishuOpenId,
                cindyMembershipId,
                createdSource,
                departmentPath,
                departmentCheckedAt,
                sessionVersion,
                lastLoginAt,
                createdAt,
                updatedAt,
              ] = args;
              const isUpsert = /ON CONFLICT\(user_id\) DO UPDATE/.test(sql);
              if (!isUpsert) {
                if (users.has(id)) throw new Error('UNIQUE constraint failed: users.user_id');
                if ([...users.values()].some((user) => user.email.toLowerCase() === email.toLowerCase())) {
                  throw new Error('UNIQUE constraint failed: index idx_users_email_normalized');
                }
                if (
                  feishuOpenId !== null &&
                  [...users.values()].some((user) => user.feishu_open_id === feishuOpenId)
                ) {
                  throw new Error('UNIQUE constraint failed: users.feishu_open_id');
                }
                if (
                  cindyMembershipId !== null &&
                  [...users.values()].some((user) => user.cindy_membership_id === cindyMembershipId)
                ) {
                  throw new Error('UNIQUE constraint failed: users.cindy_membership_id');
                }
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
                    feishuOpenId,
                    cindyMembershipId,
                    createdSource,
                    departmentPath,
                    departmentCheckedAt,
                    sessionVersion,
                    lastLoginAt,
                    createdAt,
                    updatedAt,
                  })
                );
                return { meta: { changes: 1 } };
              }

              assert.match(sql, /users\.employee_status = 'disabled'/);
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
                    feishuOpenId,
                    cindyMembershipId,
                    createdSource,
                    departmentPath,
                    departmentCheckedAt,
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
                  feishuOpenId: existing.feishu_open_id,
                  cindyMembershipId: existing.cindy_membership_id,
                  createdSource: existing.created_source,
                  departmentPath: staleActiveOrUnknown
                    ? existing.department_path
                    : departmentPath || existing.department_path,
                  departmentCheckedAt: staleActiveOrUnknown
                    ? existing.department_checked_at
                    : departmentCheckedAt || existing.department_checked_at,
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

function fakeSiteSecretsDb(rows, auditRows = [], hooks = {}) {
  return fakeRuntimeConfigDb({
    siteSecrets: rows,
    siteVars: hooks.siteVars || new Map(),
    auditRows,
    routes: hooks.routes || new Map(),
    hooks,
  });
}

function fakeRuntimeConfigDb({
  siteSecrets = new Map(),
  siteVars = new Map(),
  auditRows = [],
  routes = new Map(),
  hooks = {},
} = {}) {
  return {
    async batch(statements) {
      hooks.afterRuntimeConfigBatch?.({ statements });
      const secretSnapshot = new Map([...siteSecrets.entries()].map(([key, value]) => [key, { ...value }]));
      const varSnapshot = new Map([...siteVars.entries()].map(([key, value]) => [key, { ...value }]));
      const auditSnapshot = auditRows.map((row) => ({ ...row }));
      const routeSnapshot = new Map([...routes.entries()].map(([key, value]) => [key, { ...value }]));
      try {
        const results = [];
        let previousChanges = null;
        for (const statement of statements) {
          const result = await statement.run({ previousChanges });
          results.push(result);
          previousChanges = result?.meta?.changes ?? null;
        }
        return results;
      } catch (error) {
        siteSecrets.clear();
        for (const [key, value] of secretSnapshot) siteSecrets.set(key, value);
        siteVars.clear();
        for (const [key, value] of varSnapshot) siteVars.set(key, value);
        auditRows.splice(0, auditRows.length, ...auditSnapshot);
        routes.clear();
        for (const [key, value] of routeSnapshot) routes.set(key, value);
        throw error;
      }
    },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () =>
              /FROM site_vars/.test(sql) || /runtime_config_lock_id/.test(sql)
                ? fakeSiteVarsFirst(siteVars, routes, sql, args, hooks)
                : fakeSiteSecretsFirst(siteSecrets, sql, args, hooks),
            all: async () =>
              /FROM site_vars/.test(sql)
                ? fakeSiteVarsAll(siteVars, sql, args, hooks)
                : fakeSiteSecretsAll(siteSecrets, sql, args),
            bind(...nextArgs) {
              return this.bind(...nextArgs);
            },
            run: async (context = {}) =>
              /json_extract\('\{"ok":true\}'/.test(sql)
                ? fakeRuntimeChangeGuardRun(context, args)
                : /site_vars/.test(sql) ||
                  (/runtime_config_lock_id/.test(sql) && !/site_secrets/.test(sql)) ||
                  (/UPDATE site_routes\s+SET runtime_config_generation = runtime_config_generation \+ 1/.test(sql) &&
                    args.length === 3)
                  ? fakeSiteVarsRun(siteVars, routes, sql, args, hooks)
                  : fakeSiteSecretsRun(siteSecrets, auditRows, routes, sql, args),
          };
        },
      };
    },
  };
}

function fakeRuntimeChangeGuardRun(context, args) {
  if (context.previousChanges !== 1) {
    throw new Error(args[0] || 'SITE_VAR_REVISION_CONFLICT');
  }
  return { meta: { changes: 0 } };
}

function liveSecretRow(rows, environment, siteId, name) {
  return [...rows.values()].find(
    (row) => row.environment === environment && row.site_id === siteId && row.name === name && !row.deleted_at
  );
}

function secretRowById(rows, id) {
  return [...rows.values()].find((row) => row.id === id);
}

function liveVarRow(rows, environment, siteId, name) {
  return [...rows.values()].find(
    (row) => row.environment === environment && row.site_id === siteId && row.name === name && !row.deleted_at
  );
}

function varRowById(rows, id) {
  return [...rows.values()].find((row) => row.id === id);
}

function fakeSiteSecretsFirst(rows, sql, args, hooks = {}) {
  if (/MAX\(revision\)/.test(sql)) {
    const [environment, siteId, name] = args;
    const maxRevision = [...rows.values()]
      .filter((row) => row.environment === environment && row.site_id === siteId && row.name === name)
      .reduce((max, row) => Math.max(max, Number(row.revision || 0)), 0);
    return { max_revision: maxRevision || null };
  }
  if (/FROM site_secrets/.test(sql)) {
    const [environment, siteId, name] = args;
    const row = [...rows.values()].find(
      (candidate) =>
        candidate.environment === environment &&
        candidate.site_id === siteId &&
        candidate.name === name &&
        !candidate.deleted_at
    );
    const result = row && !row.deleted_at ? { ...row } : null;
    hooks.afterSiteSecretFirst?.({ sql, args, row });
    return result;
  }
  return null;
}

function fakeSiteSecretsAll(rows, sql, args) {
  if (/FROM site_secrets/.test(sql)) {
    const [environment, siteId] = args;
    return {
      results: [...rows.values()]
        .filter((row) => row.environment === environment && row.site_id === siteId && !row.deleted_at)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((row) => ({ ...row })),
    };
  }
  return { results: [] };
}

function fakeSiteVarsFirst(rows, routes, sql, args, hooks = {}) {
  if (/SELECT runtime_config_generation, runtime_config_lock_id/.test(sql)) {
    const [environment, siteId] = args;
    const route = routes.get(`${environment}:${siteId}`);
    return route
      ? {
          runtime_config_generation: route.runtime_config_generation || 0,
          runtime_config_lock_id: route.runtime_config_lock_id || null,
          runtime_config_lock_expires_at: route.runtime_config_lock_expires_at || null,
        }
      : null;
  }
  if (/MAX\(revision\)/.test(sql)) {
    const [environment, siteId, name] = args;
    const maxRevision = [...rows.values()]
      .filter((row) => row.environment === environment && row.site_id === siteId && row.name === name)
      .reduce((max, row) => Math.max(max, Number(row.revision || 0)), 0);
    return { max_revision: maxRevision || null };
  }
  if (/FROM site_vars/.test(sql)) {
    const [environment, siteId, name] = args;
    const row = [...rows.values()].find(
      (candidate) =>
        candidate.environment === environment &&
        candidate.site_id === siteId &&
        candidate.name === name &&
        !candidate.deleted_at
    );
    hooks.afterSiteVarsFirst?.({ sql, args, row });
    return row ? { ...row } : null;
  }
  return null;
}

function fakeSiteVarsAll(rows, sql, args, hooks = {}) {
  if (/FROM site_vars/.test(sql)) {
    const [environment, siteId] = args;
    const result = {
      results: [...rows.values()]
        .filter((row) => row.environment === environment && row.site_id === siteId && !row.deleted_at)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((row) => ({ ...row })),
    };
    hooks.afterSiteVarsAll?.({ sql, args, rows: result.results });
    return result;
  }
  return { results: [] };
}

function fakeSiteVarsRun(rows, routes, sql, args, hooks = {}) {
  if (/SET runtime_config_lock_id = \?, runtime_config_lock_expires_at = \?, updated_at = \?/.test(sql)) {
    const [lockId, expiresAt, updatedAt, environment, siteId, acquiredAt] = args;
    const route = routes.get(`${environment}:${siteId}`);
    const available =
      !route?.runtime_config_lock_id ||
      !route?.runtime_config_lock_expires_at ||
      route.runtime_config_lock_expires_at <= acquiredAt;
    if (!route || !available) return { meta: { changes: 0 } };
    route.runtime_config_lock_id = lockId;
    route.runtime_config_lock_expires_at = expiresAt;
    route.updated_at = updatedAt;
    return { meta: { changes: 1 } };
  }
  if (/SET runtime_config_lock_expires_at = \?\s+WHERE/.test(sql)) {
    const override = hooks.beforeRuntimeConfigRenew?.({ sql, args });
    if (override) return { meta: { changes: override.changes } };
    const [expiresAt, environment, siteId, lockId, renewedAt] = args;
    const route = routes.get(`${environment}:${siteId}`);
    if (
      !route ||
      route.runtime_config_lock_id !== lockId ||
      !route.runtime_config_lock_expires_at ||
      route.runtime_config_lock_expires_at <= renewedAt
    ) {
      return { meta: { changes: 0 } };
    }
    route.runtime_config_lock_expires_at = expiresAt;
    return { meta: { changes: 1 } };
  }
  if (/SET runtime_config_lock_id = NULL, runtime_config_lock_expires_at = NULL, updated_at = \?/.test(sql)) {
    const [updatedAt, environment, siteId, lockId] = args;
    const route = routes.get(`${environment}:${siteId}`);
    if (!route || route.runtime_config_lock_id !== lockId) return { meta: { changes: 0 } };
    route.runtime_config_lock_id = null;
    route.runtime_config_lock_expires_at = null;
    route.updated_at = updatedAt;
    return { meta: { changes: 1 } };
  }
  if (/runtime_config_lock_id = NULL/.test(sql) && /runtime_config_generation\s*=\s*runtime_config_generation \+ 1/.test(sql)) {
    const [updatedAt, environment, siteId, lockId] = args;
    const route = routes.get(`${environment}:${siteId}`);
    if (!route || route.runtime_config_lock_id !== lockId) return { meta: { changes: 0 } };
    route.runtime_config_generation = Number(route.runtime_config_generation || 0) + 1;
    route.runtime_config_lock_id = null;
    route.runtime_config_lock_expires_at = null;
    route.updated_at = updatedAt;
    return { meta: { changes: 1 } };
  }
  if (/UPDATE site_routes\s+SET runtime_config_generation = runtime_config_generation \+ 1/.test(sql)) {
    const [updatedAt, environment, siteId] = args;
    const route = routes.get(`${environment}:${siteId}`);
    if (!route) return { meta: { changes: 0 } };
    route.runtime_config_generation = Number(route.runtime_config_generation || 0) + 1;
    route.updated_at = updatedAt;
    return { meta: { changes: 1 } };
  }
  if (/INSERT INTO site_vars/.test(sql)) {
    const override = hooks.beforeSiteVarWrite?.({ sql, args, operation: 'insert' });
    if (override) return { meta: { changes: override.changes } };
    const [id, environment, siteId, name, value, revision, createdBy, createdAt, updatedAt, liveEnvironment, liveSiteId, lockId] =
      args;
    const route = routes.get(`${liveEnvironment}:${liveSiteId}`);
    if (/FROM site_routes/.test(sql) && (!route || route.runtime_config_lock_id !== lockId)) {
      return { meta: { changes: 0 } };
    }
    rows.set(`${environment}:${siteId}:${name}:${id}`, {
      id,
      environment,
      site_id: siteId,
      name,
      value,
      revision,
      created_by: createdBy,
      created_at: createdAt,
      updated_at: updatedAt,
      deleted_at: null,
    });
    return { meta: { changes: 1 } };
  }
  if (/UPDATE site_vars\s+SET value/.test(sql)) {
    const override = hooks.beforeSiteVarWrite?.({ sql, args, operation: 'update' });
    if (override) return { meta: { changes: override.changes } };
    const [value, revision, updatedAt, id, environment, siteId, lockId] = args;
    const row = [...rows.values()].find((candidate) => candidate.id === id);
    const route = routes.get(`${environment}:${siteId}`);
    const lockMatches = !/FROM site_routes/.test(sql) || route?.runtime_config_lock_id === lockId;
    if (row && !row.deleted_at && lockMatches) {
      row.value = value;
      row.revision = revision;
      row.updated_at = updatedAt;
    }
    return { meta: { changes: row && !row.deleted_at && lockMatches ? 1 : 0 } };
  }
  if (/UPDATE site_vars\s+SET deleted_at/.test(sql)) {
    const override = hooks.beforeSiteVarWrite?.({ sql, args, operation: 'delete' });
    if (override) return { meta: { changes: override.changes } };
    const [deletedAt, updatedAt, id, environment, siteId, lockId] = args;
    const row = [...rows.values()].find((candidate) => candidate.id === id);
    const route = routes.get(`${environment}:${siteId}`);
    const lockMatches = !/FROM site_routes/.test(sql) || route?.runtime_config_lock_id === lockId;
    if (row && !row.deleted_at && lockMatches) {
      row.deleted_at = deletedAt;
      row.updated_at = updatedAt;
    }
    return { meta: { changes: row && lockMatches ? 1 : 0 } };
  }
  return { meta: { changes: 0 } };
}

function fakeSiteSecretsRun(rows, auditRows, routes, sql, args) {
  if (/UPDATE site_routes\s+SET runtime_config_generation = runtime_config_generation \+ 1/.test(sql)) {
    const [updatedAt, environment, siteId, secretId, revision, expectedValue] = args;
    const route = routes.get(`${environment}:${siteId}`);
    const secret = [...rows.values()].find((row) => row.id === secretId);
    const secretMatches = /encrypted_value/.test(sql)
      ? secret &&
        !secret.deleted_at &&
        Number(secret.revision || 0) === Number(revision) &&
        secret.encrypted_value === expectedValue
      : secret && Number(secret.revision || 0) === Number(revision) && secret.deleted_at === expectedValue;
    if (!route || !secretMatches) return { meta: { changes: 0 } };
    route.runtime_config_generation = Number(route.runtime_config_generation || 0) + 1;
    route.updated_at = updatedAt;
    return { meta: { changes: 1 } };
  }
  if (/INSERT INTO site_secrets/.test(sql)) {
    const [
      id,
      environment,
      siteId,
      name,
      encryptedValue,
      revision,
      createdBy,
      createdAt,
      updatedAt,
      liveEnvironment,
      liveSiteId,
      liveName,
    ] = args;
    const liveExists =
      /WHERE NOT EXISTS/.test(sql) &&
      [...rows.values()].some(
        (row) =>
          row.environment === liveEnvironment &&
          row.site_id === liveSiteId &&
          row.name === liveName &&
          !row.deleted_at
      );
    if (liveExists) return { meta: { changes: 0 } };
    rows.set(`${environment}:${siteId}:${name}:${id}`, {
      id,
      environment,
      site_id: siteId,
      name,
      encrypted_value: encryptedValue,
      revision,
      created_by: createdBy,
      created_at: createdAt,
      updated_at: updatedAt,
      deleted_at: null,
    });
    return { meta: { changes: 1 } };
  }
  if (/UPDATE site_secrets\s+SET encrypted_value/.test(sql)) {
    const [encryptedValue, revision, updatedAt, id, expectedRevision] = args;
    const row = [...rows.values()].find((candidate) => candidate.id === id);
    const revisionMatches =
      !/AND revision = \?/.test(sql) || Number(row?.revision || 0) === Number(expectedRevision);
    if (row && !row.deleted_at && revisionMatches) {
      row.encrypted_value = encryptedValue;
      row.revision = revision;
      row.updated_at = updatedAt;
    }
    return { meta: { changes: row && !row.deleted_at && revisionMatches ? 1 : 0 } };
  }
  if (/UPDATE site_secrets\s+SET deleted_at/.test(sql)) {
    const [deletedAt, updatedAt, id, expectedRevision, environment, siteId, lockId] = args;
    const row = [...rows.values()].find((candidate) => candidate.id === id);
    const revisionMatches =
      !/AND revision = \?/.test(sql) || Number(row?.revision || 0) === Number(expectedRevision);
    const route = routes.get(`${environment}:${siteId}`);
    const lockMatches = !/FROM site_routes/.test(sql) || route?.runtime_config_lock_id === lockId;
    if (row && !row.deleted_at && revisionMatches && lockMatches) {
      row.deleted_at = deletedAt;
      row.updated_at = updatedAt;
    }
    return { meta: { changes: row && revisionMatches && lockMatches ? 1 : 0 } };
  }
  if (/INSERT INTO audit_events/.test(sql) && /FROM site_secrets/.test(sql)) {
    const [
      id,
      environment,
      traceId,
      eventType,
      actorUserId,
      actorType,
      siteId,
      routeId,
      versionId,
      decision,
      statusCode,
      ipHash,
      userAgentHash,
      metadataJson,
      createdAt,
      secretId,
      revision,
      expectedValue,
      expectedTime,
    ] = args;
    const secret = [...rows.values()].find((row) => row.id === secretId);
    const matches = /encrypted_value/.test(sql)
      ? secret &&
        !secret.deleted_at &&
        Number(secret.revision || 0) === Number(revision) &&
        secret.encrypted_value === expectedValue &&
        secret.updated_at === expectedTime
      : secret && Number(secret.revision || 0) === Number(revision) && secret.deleted_at === expectedValue;
    if (!matches) return { meta: { changes: 0 } };
    auditRows.push({
      id,
      environment,
      trace_id: traceId,
      event_type: eventType,
      actor_user_id: actorUserId,
      actor_type: actorType,
      site_id: siteId,
      route_id: routeId,
      version_id: versionId,
      decision,
      status_code: statusCode,
      ip_hash: ipHash,
      user_agent_hash: userAgentHash,
      metadata_json: metadataJson,
      created_at: createdAt,
    });
    return { meta: { changes: 1 } };
  }
  if (/INSERT INTO audit_events/.test(sql)) {
    const [
      id,
      environment,
      traceId,
      eventType,
      actorUserId,
      actorType,
      siteId,
      routeId,
      versionId,
      decision,
      statusCode,
      ipHash,
      userAgentHash,
      metadataJson,
      createdAt,
    ] = args;
    auditRows.push({
      id,
      environment,
      trace_id: traceId,
      event_type: eventType,
      actor_user_id: actorUserId,
      actor_type: actorType,
      site_id: siteId,
      route_id: routeId,
      version_id: versionId,
      decision,
      status_code: statusCode,
      ip_hash: ipHash,
      user_agent_hash: userAgentHash,
      metadata_json: metadataJson,
      created_at: createdAt,
    });
    return { meta: { changes: 1 } };
  }
  return { meta: { changes: 0 } };
}

function userRow({
  id,
  account,
  accountId,
  email,
  realname,
  employeenum,
  employeeStatus,
  feishuOpenId = null,
  cindyMembershipId = null,
  createdSource = 'xd_sso',
  departmentPath = null,
  departmentCheckedAt = null,
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
    feishu_open_id: feishuOpenId,
    cindy_membership_id: cindyMembershipId,
    created_source: createdSource,
    department_path: departmentPath,
    department_checked_at: departmentCheckedAt,
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
