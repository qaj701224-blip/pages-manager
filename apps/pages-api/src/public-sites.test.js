import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import worker from './index.js';
import {
  createTestPagesStore,
  insertTestRoute,
  insertTestTeamMember,
  updateTestRoute,
  updateTestSite,
  updateTestTeam,
} from '../test-support/pages-store-fixture.js';

const ENVIRONMENT = 'production';
const CREATED_AT = '2026-08-01T00:00:00.000Z';
const ROUTE_UPDATED_AT = '2026-08-02T00:00:00.000Z';
const HTTP_NOW = '2026-08-27T12:00:00.000Z';
const PUBLIC_SITES_PATH = '/.xd-pages/api/public/sites';

test('D1 Store returns every accessible active site once and fails closed on access misses', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', {
    email: 'viewer@example.com',
    departmentPath: '心动/平台支持/Web',
    departmentCheckedAt: CREATED_AT,
  });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });

  await seedActiveSite(store, {
    id: 'site_personal_owner',
    ownerUserId: 'usr_viewer',
    visibility: 'owner',
  });

  const team = await store.createTeam({
    id: 'team_accessible',
    environment: ENVIRONMENT,
    name: 'Accessible Team',
    createdByUserId: 'usr_owner',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_viewer',
    role: 'viewer',
    membershipSource: 'manual',
  });
  await seedActiveSite(store, {
    id: 'site_team_member',
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await seedActiveSite(store, {
    id: 'site_team_duplicate',
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await addAclEntries(store, 'site_team_duplicate', [
    emailAcl('acl_team_email_1', 'viewer@example.com'),
    emailAcl('acl_team_email_2', ' VIEWER@EXAMPLE.COM '),
  ]);

  await seedActiveSite(store, { id: 'site_internal', visibility: 'internal' });
  await seedActiveSite(store, { id: 'site_org', visibility: 'org' });
  await seedActiveSite(store, { id: 'site_email_acl', visibility: 'acl' });
  await addAclEntries(store, 'site_email_acl', [emailAcl('acl_email', ' VIEWER@EXAMPLE.COM ')]);
  await seedActiveSite(store, { id: 'site_department_acl', visibility: 'acl' });
  await addAclEntries(store, 'site_department_acl', [departmentAcl('acl_department', '心动/平台支持')]);

  await seedActiveSite(store, { id: 'site_acl_miss', visibility: 'acl' });
  await addAclEntries(store, 'site_acl_miss', [
    emailAcl('acl_other_email', 'other@example.com'),
    emailAcl('acl_deny_viewer', 'viewer@example.com', { effect: 'deny' }),
    emailAcl('acl_publisher', 'viewer@example.com', { accessRole: 'publisher' }),
  ]);

  const removedTeam = await store.createTeam({
    id: 'team_removed_member',
    environment: ENVIRONMENT,
    name: 'Removed Member Team',
    createdByUserId: 'usr_owner',
  });
  await store.addTeamMember({
    teamId: removedTeam.id,
    userId: 'usr_viewer',
    role: 'viewer',
    membershipSource: 'manual',
  });
  await store.removeTeamMember({ teamId: removedTeam.id, userId: 'usr_viewer', actorUserId: 'usr_owner' });
  await seedActiveSite(store, {
    id: 'site_removed_team_member',
    ownerType: 'team',
    ownerId: removedTeam.id,
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });

  await seedActiveSite(store, {
    id: 'site_team_owner_visibility',
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: 'usr_owner',
    visibility: 'owner',
  });
  await seedActiveSite(store, { id: 'site_disabled_visibility', visibility: 'disabled' });
  await seedActiveSite(store, { id: 'site_unknown_visibility', visibility: 'future_visibility' });

  const sites = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
    departmentAclEnabled: true,
  });
  const expectedIds = [
    'site_personal_owner',
    'site_team_member',
    'site_team_duplicate',
    'site_internal',
    'site_org',
    'site_email_acl',
    'site_department_acl',
  ];

  assert.deepEqual(new Set(sites.map((site) => site.id)), new Set(expectedIds));
  assert.equal(sites.length, expectedIds.length);
  assert.equal(new Set(sites.map((site) => site.id)).size, sites.length);
  assert.equal(sites.find((site) => site.id === 'site_team_member').ownerType, 'team');
});

test('D1 Store pins the latest-route correlated lookup to the site_id index', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', { email: 'viewer@example.com' });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });
  await seedActiveSite(store, { id: 'site_index_hint', visibility: 'internal' });

  const preparedSql = [];
  const originalPrepare = store.db.prepare;
  store.db.prepare = (sql) => {
    preparedSql.push(sql);
    return originalPrepare.call(store.db, sql);
  };
  try {
    assert.deepEqual(
      (await store.listPublicSitesForUser({ environment: ENVIRONMENT, viewerUserId: 'usr_viewer' })).map((site) => site.id),
      ['site_index_hint']
    );
  } finally {
    store.db.prepare = originalPrepare;
  }

  assert.match(preparedSql.at(-1), /FROM site_routes AS latest INDEXED BY idx_site_routes_site_id/);
});

test('D1 Store accepts supported active team roles and rejects an active corrupt role', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', { email: 'viewer@example.com' });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });
  const roles = ['viewer', 'publisher', 'admin', 'corrupted-role'];

  for (const role of roles) {
    const team = await seedTeam(store, `team_role_${role}`);
    await insertTestTeamMember(store, {
      teamId: team.id,
      userId: 'usr_viewer',
      role,
      membershipSource: 'manual',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    await seedActiveSite(store, {
      id: `site_team_role_${role}`,
      ownerType: 'team',
      ownerId: team.id,
      ownerUserId: 'usr_owner',
      visibility: 'acl',
    });
  }

  const sites = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
  });
  assert.deepEqual(
    new Set(sites.map((site) => site.id)),
    new Set(['site_team_role_viewer', 'site_team_role_publisher', 'site_team_role_admin'])
  );
});

test('D1 Store gates exact and parent department ACL matches with the per-request freshness flag', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', {
    email: 'viewer@example.com',
    departmentPath: '心动/平台支持/Web',
    departmentCheckedAt: '2025-01-01T00:00:00.000Z',
  });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });

  await seedActiveSite(store, { id: 'site_department_parent', visibility: 'acl' });
  await addAclEntries(store, 'site_department_parent', [departmentAcl('acl_parent', '心动/平台支持')]);
  await seedActiveSite(store, { id: 'site_department_exact', visibility: 'acl' });
  await addAclEntries(store, 'site_department_exact', [departmentAcl('acl_exact', '心动/平台支持/Web')]);
  await seedActiveSite(store, { id: 'site_department_partial', visibility: 'acl' });
  await addAclEntries(store, 'site_department_partial', [departmentAcl('acl_partial', '心动/平台')]);
  await seedActiveSite(store, { id: 'site_department_empty', visibility: 'acl' });
  await addAclEntries(store, 'site_department_empty', [departmentAcl('acl_empty', '   ')]);

  assert.deepEqual(
    await store.listPublicSitesForUser({
      environment: ENVIRONMENT,
      viewerUserId: 'usr_viewer',
      departmentAclEnabled: false,
    }),
    []
  );

  const enabled = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
    departmentAclEnabled: true,
  });
  assert.deepEqual(new Set(enabled.map((site) => site.id)), new Set(['site_department_parent', 'site_department_exact']));
});

test('D1 Store requires an active authoritative viewer even for owned, internal, and org sites', async () => {
  const store = testStore();
  await seedUser(store, 'usr_inactive', { email: 'inactive@example.com', employeeStatus: 'disabled' });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });
  await seedActiveSite(store, {
    id: 'site_inactive_personal',
    ownerUserId: 'usr_inactive',
    visibility: 'owner',
  });
  await seedActiveSite(store, { id: 'site_inactive_internal', visibility: 'internal' });
  await seedActiveSite(store, { id: 'site_inactive_org', visibility: 'org' });

  assert.deepEqual(await store.listPublicSitesForUser({ environment: ENVIRONMENT, viewerUserId: 'usr_inactive' }), []);
  assert.deepEqual(await store.listPublicSitesForUser({ environment: ENVIRONMENT, viewerUserId: 'usr_missing' }), []);
});

test('D1 Store fails closed on invalid teams, versions, sites, environments, owners, and latest routes', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', { email: 'viewer@example.com' });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });

  const control = await seedActiveSite(store, { id: 'site_control', visibility: 'internal' });
  await updateTestRoute(store, control.routeId, { exposure: 'public' });

  await seedInactiveSite(store, { id: 'site_null_active_version', visibility: 'internal' });
  await updateTestRoute(store, 'route_site_null_active_version', {
    routeStatus: 'active',
    visibility: 'internal',
  });

  await seedInactiveSite(store, { id: 'site_dangling_version', visibility: 'internal' });
  await updateTestRoute(store, 'route_site_dangling_version', {
    activeVersionId: 'ver_missing',
    routeStatus: 'active',
    visibility: 'internal',
  });

  await seedInactiveSite(store, { id: 'site_wrong_site_version', visibility: 'internal' });
  await updateTestRoute(store, 'route_site_wrong_site_version', {
    activeVersionId: control.versionId,
    routeStatus: 'active',
    visibility: 'internal',
  });

  await seedActiveSite(store, { id: 'site_deleted', visibility: 'internal' });
  await updateTestSite(store, 'site_deleted', { deletedAt: '2026-08-03T00:00:00.000Z' });
  await seedActiveSite(store, {
    id: 'site_other_environment',
    environment: 'staging',
    visibility: 'internal',
  });
  await seedActiveSite(store, {
    id: 'site_unknown_owner_type',
    ownerType: 'service',
    ownerId: 'service_1',
    visibility: 'internal',
  });

  const inactiveTeam = await seedTeam(store, 'team_inactive');
  await updateTestTeam(store, inactiveTeam.id, { status: 'inactive' });
  await seedActiveSite(store, {
    id: 'site_inactive_team',
    ownerType: 'team',
    ownerId: inactiveTeam.id,
    visibility: 'internal',
  });

  const deletedTeam = await seedTeam(store, 'team_deleted');
  await updateTestTeam(store, deletedTeam.id, { deletedAt: '2026-08-03T00:00:00.000Z' });
  await seedActiveSite(store, {
    id: 'site_deleted_team',
    ownerType: 'team',
    ownerId: deletedTeam.id,
    visibility: 'org',
  });

  const crossEnvironmentTeam = await seedTeam(store, 'team_cross_environment', { environment: 'staging' });
  await seedActiveSite(store, {
    id: 'site_cross_environment_team',
    ownerType: 'team',
    ownerId: crossEnvironmentTeam.id,
    visibility: 'internal',
  });

  const latestDisabled = await seedActiveSite(store, {
    id: 'site_latest_disabled',
    visibility: 'internal',
  });
  await insertLatestRoute(store, latestDisabled, {
    id: 'route_z_site_latest_disabled',
    routeStatus: 'disabled',
    updatedAt: latestDisabled.routeUpdatedAt,
  });

  const latestDeleted = await seedActiveSite(store, {
    id: 'site_latest_deleted',
    visibility: 'internal',
  });
  await insertLatestRoute(store, latestDeleted, {
    id: 'route_z_site_latest_deleted',
    routeStatus: 'deleted',
    updatedAt: '2026-08-03T00:00:00.000Z',
  });

  const sites = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
  });
  assert.deepEqual(
    sites.map((site) => site.id),
    ['site_control']
  );
});

test('D1 Store projects only the Public Site record and orders by the effective updated timestamp', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', { email: 'viewer@example.com' });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });

  await seedActiveSite(store, {
    id: 'site_site_later',
    title: 'Site timestamp wins',
    visibility: 'org',
    routeUpdatedAt: '2026-08-03T00:00:00.000Z',
    siteUpdatedAt: '2026-08-06T00:00:00.000Z',
  });
  await updateTestSite(store, 'site_site_later', { slugRevision: 2 });
  await seedActiveSite(store, {
    id: 'site_route_later',
    visibility: 'internal',
    routeUpdatedAt: '2026-08-05T00:00:00.000Z',
  });
  await seedActiveSite(store, {
    id: 'site_tie_a',
    visibility: 'internal',
    routeUpdatedAt: '2026-08-07T00:00:00.000Z',
  });
  await seedActiveSite(store, {
    id: 'site_tie_b',
    visibility: 'internal',
    routeUpdatedAt: '2026-08-07T00:00:00.000Z',
  });

  const sites = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
  });
  assert.deepEqual(
    sites.map((site) => site.id),
    ['site_tie_b', 'site_tie_a', 'site_site_later', 'site_route_later']
  );
  assert.deepEqual(
    sites.find((site) => site.id === 'site_site_later'),
    {
      id: 'site_site_later',
      title: 'Site timestamp wins',
      slug: 'site-site-later',
      slugRevision: 2,
      slugRoutingSyncedRevision: 1,
      environment: ENVIRONMENT,
      ownerType: 'user',
      hostname: 'site-site-later.workers.xd.team',
      visibility: 'org',
      createdAt: CREATED_AT,
      updatedAt: '2026-08-06T00:00:00.000Z',
    }
  );
  assert.equal(sites.find((site) => site.id === 'site_route_later').updatedAt, '2026-08-05T00:00:00.000Z');
});

test('D1 Store uses stable keyset pagination without duplicates or omissions for static data', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', { email: 'viewer@example.com' });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });
  const records = [
    ['site_page_e', '2026-08-06T00:00:00.000Z'],
    ['site_page_d', '2026-08-05T00:00:00.000Z'],
    ['site_page_c', '2026-08-05T00:00:00.000Z'],
    ['site_page_b', '2026-08-04T00:00:00.000Z'],
    ['site_page_a', '2026-08-03T00:00:00.000Z'],
  ];
  for (const [id, routeUpdatedAt] of records) {
    await seedActiveSite(store, { id, visibility: 'internal', routeUpdatedAt });
  }

  const all = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
    limit: 100,
  });
  const firstRaw = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
    limit: 2,
  });
  assert.equal(firstRaw.length, 3);
  const first = firstRaw.slice(0, 2);

  const secondRaw = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
    limit: 2,
    cursor: cursorFor(first.at(-1)),
  });
  assert.equal(secondRaw.length, 3);
  const second = secondRaw.slice(0, 2);

  const third = await store.listPublicSitesForUser({
    environment: ENVIRONMENT,
    viewerUserId: 'usr_viewer',
    limit: 2,
    cursor: cursorFor(second.at(-1)),
  });
  assert.equal(third.length, 1);

  const pagedIds = [...first, ...second, ...third].map((site) => site.id);
  assert.deepEqual(
    pagedIds,
    all.map((site) => site.id)
  );
  assert.equal(new Set(pagedIds).size, pagedIds.length);
});

test('D1 Store defensively normalizes limits and never returns more than 101 rows', async () => {
  const store = testStore();
  await seedUser(store, 'usr_viewer', { email: 'viewer@example.com' });
  await seedUser(store, 'usr_owner', { email: 'owner@example.com' });
  for (let index = 0; index < 105; index += 1) {
    await seedActiveSite(store, {
      id: `site_limit_${String(index).padStart(3, '0')}`,
      visibility: 'internal',
    });
  }

  const list = (limit) =>
    store.listPublicSitesForUser({
      environment: ENVIRONMENT,
      viewerUserId: 'usr_viewer',
      ...(limit === undefined ? {} : { limit }),
    });

  assert.equal((await list(1_000)).length, 101);
  assert.equal((await list(100)).length, 101);
  assert.equal((await list(0)).length, 2);
  assert.equal((await list(-10)).length, 2);
  assert.equal((await list(1.9)).length, 2);
  assert.equal((await list('2')).length, 3);
  assert.equal((await list(Number.NaN)).length, 51);
  assert.equal((await list(Number.POSITIVE_INFINITY)).length, 51);
  assert.equal((await list()).length, 51);
});

test('Public Sites HTTP requires Bearer authentication', async () => {
  const response = await worker.fetch(publicSitesRequest(), publicSitesEnv(testStore()));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: {
      code: 'PAGES_AUTH_REQUIRED',
      message: 'Login required.',
      action: 'Run `xd-cell login` and retry.',
    },
  });
});

test('Public Sites HTTP accepts CLI login and unscoped personal read keys', async (t) => {
  const store = testStore();
  await seedUser(store, 'usr_http_viewer', {
    email: 'http-viewer@example.com',
    departmentPath: '心动/平台支持/Web',
    departmentCheckedAt: '2026-08-27T11:00:00.000Z',
  });
  const credentials = [
    {
      name: 'CLI login key',
      keyId: 'ak_public_cli',
      scopes: ['*'],
      issuedSource: 'cli_login',
      issuedSessionVersion: 1,
      byte: 31,
    },
    { name: 'personal read key', keyId: 'ak_public_read', scopes: ['read:site'], byte: 32 },
    { name: 'personal wildcard key', keyId: 'ak_public_star', scopes: ['*'], byte: 33 },
  ];

  for (const credential of credentials) {
    const token = await seedPublicSitesAccessKey(store, {
      ...credential,
      userId: 'usr_http_viewer',
    });
    await t.test(credential.name, async () => {
      const response = await worker.fetch(publicSitesRequest({ token }), publicSitesEnv(store));

      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { sites: [], pagination: { nextCursor: null } });
    });
  }
});

test('Public Sites HTTP rejects deploy-only, team, and site-scoped keys before directory hydration', async (t) => {
  const store = testStore();
  await seedUser(store, 'usr_http_forbidden', { email: 'forbidden@example.com' });
  const team = await store.createTeam({
    id: 'team_public_key',
    environment: ENVIRONMENT,
    name: 'Public Key Team',
    createdByUserId: 'usr_http_forbidden',
  });
  const credentials = [
    {
      name: 'deploy-only key',
      keyId: 'ak_public_deploy',
      scopes: ['deploy:site'],
      byte: 34,
    },
    {
      name: 'team key',
      keyId: 'ak_public_team',
      scopes: ['read:site'],
      ownerType: 'team',
      ownerId: team.id,
      byte: 35,
    },
    {
      name: 'site-scoped key',
      keyId: 'ak_public_site',
      scopes: ['read:site'],
      siteId: 'site_scope',
      byte: 36,
    },
  ];

  for (const credential of credentials) {
    const token = await seedPublicSitesAccessKey(store, {
      ...credential,
      userId: 'usr_http_forbidden',
    });
    await t.test(credential.name, async () => {
      let directoryCalls = 0;
      let listCalls = 0;
      const originalList = store.listPublicSitesForUser.bind(store);
      store.listPublicSitesForUser = async (input) => {
        listCalls += 1;
        return originalList(input);
      };
      try {
        const response = await worker.fetch(
          publicSitesRequest({ token }),
          publicSitesEnv(store, {
            XDS_OPENAI_TOKEN: 'test-directory-token',
            XDS_FETCH: async () => {
              directoryCalls += 1;
              return Response.json({ code: 0, data: [] });
            },
          })
        );

        assert.equal(response.status, 403);
        assert.equal((await response.json()).error.code, 'PUBLIC_SITES_FORBIDDEN');
        assert.equal(directoryCalls, 0);
        assert.equal(listCalls, 0);
      } finally {
        store.listPublicSitesForUser = originalList;
      }
    });
  }
});

test('Public Sites HTTP validates method and query before authentication or directory hydration', async (t) => {
  const store = testStore();
  let directoryCalls = 0;
  const env = publicSitesEnv(store, {
    XDS_OPENAI_TOKEN: 'test-directory-token',
    XDS_FETCH: async () => {
      directoryCalls += 1;
      return Response.json({ code: 0, data: [] });
    },
  });

  const methodResponse = await worker.fetch(publicSitesRequest({ method: 'POST' }), env);
  assert.equal(methodResponse.status, 405);
  assert.equal((await methodResponse.json()).error.code, 'METHOD_NOT_ALLOWED');

  let stableInvalidBody;
  for (const query of ['limit=0', 'limit=1&limit=2', 'owner=user']) {
    await t.test(query, async () => {
      const response = await worker.fetch(publicSitesRequest({ query }), env);
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.deepEqual(Object.keys(body.error), ['code', 'message', 'action']);
      assert.equal(body.error.code, 'PUBLIC_SITES_QUERY_INVALID');
      stableInvalidBody ||= body;
      assert.deepEqual(body, stableInvalidBody);
    });
  }
  assert.equal(directoryCalls, 0);
});

test('Public Sites HTTP returns the exact minimal projection without sensitive fields', async () => {
  const store = testStore();
  await seedUser(store, 'usr_http_projection', {
    email: 'projection@example.com',
    departmentPath: '心动/平台支持/Web',
    departmentCheckedAt: '2026-08-27T11:00:00.000Z',
  });
  await seedActiveSite(store, {
    id: 'site_public_projection',
    ownerUserId: 'usr_http_projection',
    visibility: 'org',
  });
  const token = await seedPublicSitesAccessKey(store, {
    keyId: 'ak_public_projection',
    userId: 'usr_http_projection',
    scopes: ['read:site'],
    byte: 37,
  });

  const response = await worker.fetch(publicSitesRequest({ token }), publicSitesEnv(store));

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    sites: [
      {
        id: 'site_public_projection',
        title: null,
        displayName: 'site-public-projection',
        slug: 'site-public-projection',
        environment: 'production',
        routingStatus: 'ready',
        hostname: 'site-public-projection.workers.xd.team',
        url: 'https://site-public-projection.workers.xd.team',
        owner: { type: 'user' },
        visibility: 'org',
        createdAt: CREATED_AT,
        updatedAt: ROUTE_UPDATED_AT,
      },
    ],
    pagination: { nextCursor: null },
  });
});

test('Public Sites HTTP maps repository and authoritative-user failures to a stable redacted 503', async (t) => {
  const expected = {
    error: {
      code: 'PUBLIC_SITES_UNAVAILABLE',
      message: 'Public sites are temporarily unavailable.',
      action: 'Retry shortly.',
    },
  };

  await t.test('repository failure', async () => {
    const { store, token } = await createAuthenticatedPublicSitesFixture('repository', 38);
    store.listPublicSitesForUser = async () => {
      throw new Error('secret SQL and provider detail');
    };

    const response = await worker.fetch(publicSitesRequest({ token }), publicSitesEnv(store));
    const text = await response.text();

    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(text), expected);
    assert.doesNotMatch(text, /secret|SQL|provider/i);
  });

  await t.test('authoritative user failure', async () => {
    const { store, token } = await createAuthenticatedPublicSitesFixture('user_read', 39);
    const originalGetUser = store.getUser.bind(store);
    let reads = 0;
    store.getUser = async (...args) => {
      reads += 1;
      if (reads === 2) throw new Error('secret user query detail');
      return originalGetUser(...args);
    };

    const response = await worker.fetch(publicSitesRequest({ token }), publicSitesEnv(store));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), expected);
  });
});

test('Public Sites HTTP does not relabel projection programming errors as Store outages', async () => {
  const { store, token } = await createAuthenticatedPublicSitesFixture('projection_error', 48);
  const programmingError = new Error('unexpected projection failure');
  store.listPublicSitesForUser = async () =>
    Object.defineProperty({}, 'length', {
      get() {
        throw programmingError;
      },
    });

  await assert.rejects(worker.fetch(publicSitesRequest({ token }), publicSitesEnv(store)), (error) => error === programmingError);
});

test('Public Sites HTTP truncates limit plus one and returns a usable nonduplicating cursor', async () => {
  const { store, token } = await createAuthenticatedPublicSitesFixture('pagination', 40);
  for (const [id, routeUpdatedAt] of [
    ['site_http_page_a', '2026-08-03T00:00:00.000Z'],
    ['site_http_page_b', '2026-08-04T00:00:00.000Z'],
    ['site_http_page_c', '2026-08-05T00:00:00.000Z'],
  ]) {
    await seedActiveSite(store, { id, visibility: 'internal', routeUpdatedAt });
  }

  const firstResponse = await worker.fetch(publicSitesRequest({ token, query: 'limit=2' }), publicSitesEnv(store));
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const first = await firstResponse.json();
  assert.deepEqual(
    first.sites.map((site) => site.id),
    ['site_http_page_c', 'site_http_page_b']
  );
  assert.match(first.pagination.nextCursor, /^[A-Za-z0-9_-]+$/);

  const secondQuery = new URLSearchParams({ limit: '2', cursor: first.pagination.nextCursor });
  const secondResponse = await worker.fetch(publicSitesRequest({ token, query: secondQuery.toString() }), publicSitesEnv(store));
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  const second = await secondResponse.json();
  assert.deepEqual(
    second.sites.map((site) => site.id),
    ['site_http_page_a']
  );
  assert.equal(second.pagination.nextCursor, null);

  const allIds = [...first.sites, ...second.sites].map((site) => site.id);
  assert.equal(new Set(allIds).size, allIds.length);
});

test('Public Sites HTTP trusts a fresh authoritative department path without calling XDS', async () => {
  const store = testStore();
  const token = await seedDepartmentHttpFixture(store, {
    keyId: 'ak_public_department_fresh',
    byte: 41,
    departmentPath: '心动/平台支持/Web',
    departmentCheckedAt: '2026-08-27T11:00:00.000Z',
  });
  let directoryCalls = 0;

  const response = await worker.fetch(
    publicSitesRequest({ token }),
    publicSitesEnv(store, {
      XDS_OPENAI_TOKEN: 'test-directory-token',
      XDS_FETCH: async () => {
        directoryCalls += 1;
        return Response.json({ code: 0, data: [] });
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(new Set((await response.json()).sites.map((site) => site.id)), departmentVisibleSiteIds());
  assert.equal(directoryCalls, 0);
});

test('Public Sites HTTP enables department ACL only after successful XDS hydration and authoritative reload', async () => {
  const store = testStore();
  const token = await seedDepartmentHttpFixture(store, {
    keyId: 'ak_public_department_hydrated',
    byte: 42,
    departmentPath: '心动/旧部门',
    departmentCheckedAt: '2026-08-25T00:00:00.000Z',
  });
  let directoryCalls = 0;

  const response = await worker.fetch(
    publicSitesRequest({ token }),
    publicSitesEnv(store, {
      XDS_OPENAI_TOKEN: 'test-directory-token',
      XDS_FETCH: async () => {
        directoryCalls += 1;
        return Response.json({
          code: 0,
          data: [{ email: 'department-viewer@example.com', departmentPath: '心动/平台支持/Web' }],
        });
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(new Set((await response.json()).sites.map((site) => site.id)), departmentVisibleSiteIds());
  assert.equal(directoryCalls, 1);
  const user = await store.getUser('usr_department_viewer');
  assert.equal(user.departmentPath, '心动/平台支持/Web');
  assert.equal(user.departmentCheckedAt, HTTP_NOW);
});

test('Public Sites HTTP hides department ACL when hydration is unavailable or non-hydrated', async (t) => {
  const cases = [
    {
      name: 'XDS transport unavailable',
      keyId: 'ak_public_department_xds_down',
      byte: 43,
      departmentPath: '心动/旧部门',
      departmentCheckedAt: '2026-08-25T00:00:00.000Z',
      expectedDirectoryCalls: 1,
      fetch: async () => new Response('provider detail', { status: 503 }),
    },
    {
      name: 'recent negative department check observes retry backoff',
      keyId: 'ak_public_department_missing',
      byte: 44,
      departmentPath: null,
      departmentCheckedAt: HTTP_NOW,
      expectedDirectoryCalls: 0,
      fetch: async () => Response.json({ code: 0, data: [] }),
    },
    {
      name: 'missing department outside retry backoff hydrates once',
      keyId: 'ak_public_department_retry',
      byte: 49,
      departmentPath: null,
      departmentCheckedAt: '2026-08-27T11:49:59.000Z',
      expectedDirectoryCalls: 1,
      fetch: async () => Response.json({ code: 0, data: [] }),
    },
  ];

  for (const input of cases) {
    await t.test(input.name, async () => {
      const store = testStore();
      const token = await seedDepartmentHttpFixture(store, {
        keyId: input.keyId,
        byte: input.byte,
        departmentPath: input.departmentPath,
        departmentCheckedAt: input.departmentCheckedAt,
      });
      let directoryCalls = 0;

      const response = await worker.fetch(
        publicSitesRequest({ token }),
        publicSitesEnv(store, {
          XDS_OPENAI_TOKEN: 'test-directory-token',
          XDS_FETCH: async (...args) => {
            directoryCalls += 1;
            return input.fetch(...args);
          },
        })
      );

      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(
        new Set((await response.json()).sites.map((site) => site.id)),
        new Set(['site_department_internal', 'site_department_org'])
      );
      assert.equal(directoryCalls, input.expectedDirectoryCalls);
    });
  }
});

test('Public Sites HTTP keeps department ACL disabled when membership hydration throws after writing the new path', async () => {
  const store = testStore();
  const token = await seedDepartmentHttpFixture(store, {
    keyId: 'ak_public_department_membership_fail',
    byte: 45,
    departmentPath: '心动/旧部门',
    departmentCheckedAt: '2026-08-25T00:00:00.000Z',
  });
  store.hydrateDepartmentMembership = async () => {
    throw new Error('secret membership write failure');
  };

  const response = await worker.fetch(
    publicSitesRequest({ token }),
    publicSitesEnv(store, {
      XDS_OPENAI_TOKEN: 'test-directory-token',
      XDS_FETCH: async () =>
        Response.json({
          code: 0,
          data: [{ email: 'department-viewer@example.com', departmentPath: '心动/平台支持/Web' }],
        }),
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    new Set((await response.json()).sites.map((site) => site.id)),
    new Set(['site_department_internal', 'site_department_org'])
  );
  assert.equal((await store.getUser('usr_department_viewer')).departmentPath, '心动/平台支持/Web');
});

test('Public Sites HTTP keeps department ACL disabled when the post-hydration authoritative reload fails', async () => {
  const store = testStore();
  const token = await seedDepartmentHttpFixture(store, {
    keyId: 'ak_public_department_reload_fail',
    byte: 46,
    departmentPath: '心动/旧部门',
    departmentCheckedAt: '2026-08-25T00:00:00.000Z',
  });
  const originalGetUser = store.getUser.bind(store);
  let reads = 0;
  store.getUser = async (...args) => {
    reads += 1;
    if (reads === 4) throw new Error('post-hydration reload failed');
    return originalGetUser(...args);
  };

  const response = await worker.fetch(
    publicSitesRequest({ token }),
    publicSitesEnv(store, {
      XDS_OPENAI_TOKEN: 'test-directory-token',
      XDS_FETCH: async () =>
        Response.json({
          code: 0,
          data: [{ email: 'department-viewer@example.com', departmentPath: '心动/平台支持/Web' }],
        }),
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    new Set((await response.json()).sites.map((site) => site.id)),
    new Set(['site_department_internal', 'site_department_org'])
  );
  assert.equal((await originalGetUser('usr_department_viewer')).departmentPath, '心动/平台支持/Web');
});

test('Public Sites HTTP supports local access keys and local pagination cursors', async () => {
  const store = testStore();
  await seedUser(store, 'usr_local_viewer', {
    email: 'local-viewer@example.com',
    departmentPath: '心动/本地开发',
    departmentCheckedAt: '2026-08-27T11:00:00.000Z',
  });
  await seedActiveSite(store, {
    id: 'site_local_page_b',
    environment: 'local',
    visibility: 'internal',
    routeUpdatedAt: '2026-08-04T00:00:00.000Z',
  });
  await seedActiveSite(store, {
    id: 'site_local_page_a',
    environment: 'local',
    visibility: 'internal',
    routeUpdatedAt: '2026-08-03T00:00:00.000Z',
  });
  const token = await seedPublicSitesAccessKey(store, {
    keyId: 'ak_public_local',
    userId: 'usr_local_viewer',
    environment: 'local',
    scopes: ['read:site'],
    byte: 47,
  });
  const localEnv = publicSitesEnv(store, { PAGES_ENV: 'local' });

  const firstResponse = await worker.fetch(
    publicSitesRequest({ token, query: 'limit=1', baseUrl: 'http://xd-pages.127.0.0.1.nip.io:8787' }),
    localEnv
  );
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const first = await firstResponse.json();
  assert.equal(first.sites[0].environment, 'local');
  assert.equal(first.sites[0].id, 'site_local_page_b');
  assert.ok(first.pagination.nextCursor);

  const query = new URLSearchParams({ limit: '1', cursor: first.pagination.nextCursor });
  const secondResponse = await worker.fetch(
    publicSitesRequest({ token, query: query.toString(), baseUrl: 'http://xd-pages.127.0.0.1.nip.io:8787' }),
    localEnv
  );
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  const second = await secondResponse.json();
  assert.equal(second.sites[0].id, 'site_local_page_a');
  assert.equal(second.pagination.nextCursor, null);
});

function testStore() {
  return createTestPagesStore({ now: () => CREATED_AT });
}

function publicSitesEnv(store, overrides = {}) {
  return {
    PAGES_ENV: ENVIRONMENT,
    PAGES_STORE: store,
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => HTTP_NOW,
    ...overrides,
  };
}

function publicSitesRequest({ token, query, method = 'GET', baseUrl = 'https://api.pages.xd.team', headers = {} } = {}) {
  const search = query ? `?${query}` : '';
  return new Request(`${baseUrl}${PUBLIC_SITES_PATH}${search}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

async function seedPublicSitesAccessKey(
  store,
  {
    keyId,
    userId,
    environment = ENVIRONMENT,
    scopes,
    ownerType = 'user',
    ownerId = ownerType === 'user' ? userId : undefined,
    siteId = null,
    issuedSource = 'legacy',
    issuedSessionVersion = null,
    byte,
  }
) {
  const plaintext = createAccessKeyPlaintext({
    environment,
    keyId,
    bytes: new Uint8Array(24).fill(byte),
  });
  await store.createAccessKey({
    id: keyId,
    environment,
    ownerType,
    ownerId,
    ownerUserId: userId,
    createdByUserId: userId,
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes,
    siteId,
    issuedSource,
    issuedSessionVersion,
  });
  return plaintext;
}

async function createAuthenticatedPublicSitesFixture(suffix, byte) {
  const store = testStore();
  const userId = `usr_http_${suffix}`;
  await seedUser(store, userId, {
    email: `${suffix}@example.com`,
    departmentPath: '心动/平台支持/Web',
    departmentCheckedAt: '2026-08-27T11:00:00.000Z',
  });
  const token = await seedPublicSitesAccessKey(store, {
    keyId: `ak_public_${suffix}`,
    userId,
    scopes: ['read:site'],
    byte,
  });
  return { store, token };
}

async function seedDepartmentHttpFixture(store, { keyId, byte, departmentPath, departmentCheckedAt }) {
  await seedUser(store, 'usr_department_viewer', {
    email: 'department-viewer@example.com',
    departmentPath,
    departmentCheckedAt,
  });
  await seedActiveSite(store, { id: 'site_department_internal', visibility: 'internal' });
  await seedActiveSite(store, { id: 'site_department_org', visibility: 'org' });
  await seedActiveSite(store, { id: 'site_department_acl_http', visibility: 'acl' });
  await addAclEntries(store, 'site_department_acl_http', [departmentAcl('acl_department_http', '心动/平台支持')]);
  return seedPublicSitesAccessKey(store, {
    keyId,
    userId: 'usr_department_viewer',
    scopes: ['read:site'],
    byte,
  });
}

function departmentVisibleSiteIds() {
  return new Set(['site_department_internal', 'site_department_org', 'site_department_acl_http']);
}

async function seedUser(store, userId, overrides = {}) {
  const existing = await store.getUser(userId);
  if (existing) return existing;
  return store.createUser({
    userId,
    email: `${userId}@example.com`,
    employeeStatus: 'active',
    ...overrides,
  });
}

async function seedTeam(store, id, { environment = ENVIRONMENT } = {}) {
  return store.createTeam({
    id,
    environment,
    name: id,
    createdByUserId: 'usr_owner',
  });
}

async function seedInactiveSite(store, input) {
  const ownerUserId = input.ownerUserId || 'usr_owner';
  await seedUser(store, ownerUserId);
  await store.createSite({
    id: input.id,
    slug: slugFor(input.id),
    title: input.title,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    ownerUserId,
    siteUuid: `uuid_${input.id}`,
    defaultVisibility: input.visibility,
    environment: input.environment || ENVIRONMENT,
    routeId: `route_${input.id}`,
    hostname: hostnameFor(input.id, input.environment || ENVIRONMENT),
  });
}

async function seedActiveSite(store, input) {
  const environment = input.environment || ENVIRONMENT;
  const ownerUserId = input.ownerUserId || 'usr_owner';
  await seedInactiveSite(store, { ...input, environment, ownerUserId });
  const versionId = `ver_${input.id}`;
  const routeId = `route_${input.id}`;
  const workerName = `worker-${slugFor(input.id)}`;
  await store.createSiteVersion({
    id: versionId,
    siteId: input.id,
    deploymentId: `dep_${input.id}`,
    workerName,
    runtime: 'wfp',
    artifactRef: `wfp://test/${workerName}`,
    contentHash: `sha256:${input.id}`,
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    createdBy: ownerUserId,
  });
  const routeUpdatedAt = input.routeUpdatedAt || ROUTE_UPDATED_AT;
  await store.activateSiteVersion(
    input.id,
    {
      activeVersionId: versionId,
      workerName,
      runtime: 'wfp',
      visibility: input.visibility,
      updatedAt: routeUpdatedAt,
    },
    environment
  );
  if (input.siteUpdatedAt) await updateTestSite(store, input.id, { updatedAt: input.siteUpdatedAt });
  return { siteId: input.id, routeId, versionId, routeUpdatedAt };
}

async function insertLatestRoute(store, site, { id, routeStatus, updatedAt }) {
  await insertTestRoute(store, {
    id,
    hostname: `${slugFor(site.siteId)}-${routeStatus}.workers.xd.team`,
    siteId: site.siteId,
    environment: ENVIRONMENT,
    runtime: 'disabled',
    executionProvider: null,
    workerName: null,
    dispatchType: null,
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: site.versionId,
    visibility: 'internal',
    exposure: 'internal',
    accessMode: 'org',
    policyVersion: 2,
    routeGeneration: 2,
    runtimeConfigGeneration: 0,
    runtimeConfigLockId: null,
    runtimeConfigLockExpiresAt: null,
    routeStatus,
    cacheTier: 'strict',
    createdAt: updatedAt,
    updatedAt,
  });
}

async function addAclEntries(store, siteId, entries) {
  await store.addSiteAclEntries(siteId, entries, { createdBy: 'usr_owner', updatedAt: ROUTE_UPDATED_AT }, ENVIRONMENT);
}

function emailAcl(id, subjectValue, { accessRole = 'viewer', effect = 'allow' } = {}) {
  return { id, subjectType: 'email', subjectValue, accessRole, effect };
}

function departmentAcl(id, subjectValue) {
  return { id, subjectType: 'department', subjectValue, accessRole: 'viewer', effect: 'allow' };
}

function cursorFor(site) {
  return { updatedAt: site.updatedAt, id: site.id };
}

function slugFor(id) {
  return id.replaceAll('_', '-');
}

function hostnameFor(id, environment) {
  const suffix = environment === ENVIRONMENT ? '' : `-${environment}`;
  return `${slugFor(id)}${suffix}.workers.xd.team`;
}
