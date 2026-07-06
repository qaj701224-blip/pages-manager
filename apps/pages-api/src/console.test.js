import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('public API host cannot use forged console identity headers', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_internal',
    slug: 'internal-demo',
    ownerUserId: 'usr_owner',
    visibility: 'internal',
  });

  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/console/workspace/sites?owner=personal', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'X-Console-BFF': 'pages-console',
        'X-Console-User-Id': 'usr_owner',
        'X-Console-Admin': 'true',
      },
    }),
    env(store)
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});

test('unauthenticated directory returns only internal sites with minimal metadata', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    realname: 'Owner Name',
  });
  await seedSite(store, {
    id: 'site_internal',
    slug: 'internal-demo',
    ownerUserId: 'usr_owner',
    visibility: 'internal',
  });
  await seedSite(store, {
    id: 'site_private',
    slug: 'private-demo',
    ownerUserId: 'usr_owner',
    visibility: 'owner',
  });

  const response = await worker.fetch(internalConsoleRequest('/.xd-pages/api/console/directory'), env(store));

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.sites, [
    {
      id: 'site_internal',
      slug: 'internal-demo',
      hostname: 'internal-demo.workers.xd.team',
      owner: { type: 'user', displayName: 'Owner Name' },
      visibility: 'internal',
      status: 'disabled',
    },
  ]);
  assertNoSensitiveConsoleFields(body);
});

test('unauthenticated directory hides sites whose effective route visibility is no longer internal', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_internal_then_owner',
    slug: 'internal-then-owner',
    ownerUserId: 'usr_owner',
    visibility: 'internal',
  });
  await activateSite(store, 'site_internal_then_owner', { visibility: 'owner' });

  const response = await worker.fetch(internalConsoleRequest('/.xd-pages/api/console/directory'), env(store));

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { sites: [] });
});

test('unauthenticated directory shows team owner display name without team id', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'department',
    name: 'XD/Platform/Web',
    departmentPath: 'XD/Platform/Web',
  });
  await seedSite(store, {
    id: 'site_team_internal',
    slug: 'team-internal',
    ownerUserId: 'usr_legacy_owner',
    ownerType: 'team',
    ownerId: team.id,
    visibility: 'internal',
  });

  const response = await worker.fetch(internalConsoleRequest('/.xd-pages/api/console/directory'), env(store));

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.sites, [
    {
      id: 'site_team_internal',
      slug: 'team-internal',
      hostname: 'team-internal.workers.xd.team',
      owner: { type: 'team', displayName: 'XD/Platform/Web', teamType: 'department' },
      visibility: 'internal',
      status: 'disabled',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(team.id));
  assertNoSensitiveConsoleFields(body);
});

test('workspace sites requires console session identity', async () => {
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/workspace/sites?owner=personal'),
    env(createTestPagesStore())
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'CONSOLE_AUTH_REQUIRED');
});

test('console auth session validates current user, session version, and admin grant', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await store.createUser({
    userId: 'usr_admin',
    email: 'admin@example.com',
    realname: '徐天麒',
    departmentPath: '心动/平台支撑部/Web',
    employeeStatus: 'active',
    sessionVersion: 3,
  });
  await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_admin',
    grantedByUserId: 'usr_root',
    grantReason: 'bootstrap',
  });
  await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_root',
    grantedByUserId: 'usr_root',
    grantReason: 'bootstrap',
  });

  const current = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/auth/session', {
      userId: 'usr_admin',
      email: 'cookie@example.com',
      admin: false,
      sessionVersion: 3,
    }),
    env(store)
  );
  assert.equal(current.status, 200, await current.clone().text());
  assert.deepEqual(await current.json(), {
    session: {
      userId: 'usr_admin',
      email: 'admin@example.com',
      realname: '徐天麒',
      departmentPath: '心动/平台支撑部/Web',
      employeeStatus: 'active',
      sessionVersion: 3,
      isPlatformAdmin: true,
    },
  });

  await store.revokePlatformAdmin({
    environment: 'production',
    userId: 'usr_admin',
    revokedByUserId: 'usr_root',
    revokeReason: 'rotation',
  });
  const revoked = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/auth/session', {
      userId: 'usr_admin',
      admin: true,
      sessionVersion: 3,
    }),
    env(store)
  );
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await revoked.json()).session.isPlatformAdmin, false);

  const stale = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/auth/session', {
      userId: 'usr_admin',
      admin: true,
      sessionVersion: 2,
    }),
    env(store)
  );
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error.code, 'CONSOLE_SESSION_STALE');
});

test('console auth session hydrates missing department team through pages-api XDS binding', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_member',
    email: 'member@xd.com',
    employeeStatus: 'active',
    sessionVersion: 1,
  });
  let xdsCalled = false;

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/auth/session', {
      userId: 'usr_member',
      email: 'member@xd.com',
      sessionVersion: 1,
    }),
    env(store, {
      XDS_OPENAI_TOKEN: 'secret-token',
      now: () => '2026-07-01T10:00:00.000Z',
      XD_OFFICE_NET: {
        fetch: async (url, init) => {
          xdsCalled = true;
          assert.equal(url, 'https://xds.xindong.com/xds-open-api/v1/oa-user/list-by-email');
          assert.equal(init.method, 'POST');
          return Response.json({
            code: 0,
            data: [{ email: 'member@xd.com', departmentPath: '心动/平台支撑部/Web' }],
          });
        },
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(xdsCalled, true);
  assert.equal((await store.getUser('usr_member')).departmentPath, '心动/平台支撑部/Web');
  assert.equal((await store.getUser('usr_member')).departmentCheckedAt, '2026-07-01T10:00:00.000Z');

  const teams = await store.listTeamsForUser({ environment: 'production', userId: 'usr_member' });
  assert.deepEqual(
    teams.map((team) => [team.name, team.teamType, team.currentUserRole]),
    [['心动/平台支撑部/Web', 'department', 'admin']]
  );
});

test('console auth session throttles unavailable department hydration attempts', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_member',
    email: 'member@xd.com',
    employeeStatus: 'active',
    sessionVersion: 1,
  });
  let xdsCalls = 0;
  let nowIso = '2026-07-01T10:00:00.000Z';

  const testEnv = () =>
    env(store, {
      XDS_OPENAI_TOKEN: 'secret-token',
      now: () => nowIso,
      XD_OFFICE_NET: {
        fetch: async () => {
          xdsCalls += 1;
          return Response.json({ code: 500, message: 'unavailable' }, { status: 503 });
        },
      },
    });

  const first = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/auth/session', {
      userId: 'usr_member',
      email: 'member@xd.com',
      sessionVersion: 1,
    }),
    testEnv()
  );
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(xdsCalls, 1);
  assert.equal((await store.getUser('usr_member')).departmentPath, null);
  assert.equal((await store.getUser('usr_member')).departmentCheckedAt, '2026-07-01T10:00:00.000Z');

  const second = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/auth/session', {
      userId: 'usr_member',
      email: 'member@xd.com',
      sessionVersion: 1,
    }),
    testEnv()
  );
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal(xdsCalls, 1);

  nowIso = '2026-07-01T10:11:00.000Z';
  const third = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/auth/session', {
      userId: 'usr_member',
      email: 'member@xd.com',
      sessionVersion: 1,
    }),
    testEnv()
  );
  assert.equal(third.status, 200, await third.clone().text());
  assert.equal(xdsCalls, 2);
});

test('workspace personal and team sites use owner model and team membership', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_me', { realname: '徐天麒' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await seedSite(store, {
    id: 'site_other',
    slug: 'other',
    ownerUserId: 'usr_other',
    visibility: 'internal',
  });
  const teamRecord = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_me',
  });
  await seedSite(store, {
    id: 'site_team',
    slug: 'team-owned',
    ownerUserId: 'usr_legacy_owner',
    ownerType: 'team',
    ownerId: teamRecord.id,
    visibility: 'org',
  });

  const personal = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/workspace/sites?owner=personal', { userId: 'usr_me' }),
    env(store)
  );
  const teamResponse = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/workspace/sites?owner=team', { userId: 'usr_me' }),
    env(store)
  );

  assert.equal(personal.status, 200, await personal.clone().text());
  assert.deepEqual(await personal.json(), {
    sites: [
      {
        id: 'site_mine',
        slug: 'mine',
        hostname: 'mine.workers.xd.team',
        owner: { type: 'user', displayName: '徐天麒' },
        visibility: 'org',
        status: 'disabled',
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    ],
  });
  assert.equal(teamResponse.status, 200, await teamResponse.clone().text());
  assert.deepEqual(await teamResponse.json(), {
    sites: [
      {
        id: 'site_team',
        slug: 'team-owned',
        hostname: 'team-owned.workers.xd.team',
        owner: { type: 'team', displayName: 'Console Team', teamType: 'custom' },
        visibility: 'org',
        status: 'disabled',
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    ],
  });
});

test('workspace team sites can be filtered by team id', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_me');
  const teamA = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Team A',
    description: null,
    createdByUserId: 'usr_me',
  });
  const teamB = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Team B',
    description: null,
    createdByUserId: 'usr_me',
  });
  await seedSite(store, {
    id: 'site_a',
    slug: 'team-a-site',
    ownerUserId: 'usr_legacy_owner',
    ownerType: 'team',
    ownerId: teamA.id,
    visibility: 'org',
  });
  await seedSite(store, {
    id: 'site_b',
    slug: 'team-b-site',
    ownerUserId: 'usr_legacy_owner',
    ownerType: 'team',
    ownerId: teamB.id,
    visibility: 'org',
  });

  const response = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/workspace/sites?owner=team&teamId=${encodeURIComponent(teamA.id)}`, {
      userId: 'usr_me',
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    (await response.json()).sites.map((site) => site.slug),
    ['team-a-site']
  );
});

test('console creates personal and team-owned sites without browser upload', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const testEnvironment = envWithSequencedIds(store);
  await seedConsoleUsers(store, ['usr_admin', 'usr_owner', 'usr_publisher', 'usr_viewer']);
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
    actorUserId: 'usr_admin',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_viewer',
    role: 'viewer',
    membershipSource: 'manual',
    actorUserId: 'usr_admin',
  });

  const personal = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/workspace/sites', {
      userId: 'usr_owner',
      body: {
        slug: 'personal-console',
        visibility: 'internal',
      },
    }),
    testEnvironment
  );
  assert.equal(personal.status, 201, await personal.clone().text());
  assert.deepEqual(await personal.json(), {
    site: {
      id: 'site_1',
      slug: 'personal-console',
      hostname: 'personal-console.workers.xd.team',
      owner: { type: 'user', displayName: 'usr_owner@example.com' },
      visibility: 'internal',
      status: 'disabled',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
  });

  const teamSite = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/workspace/sites', {
      userId: 'usr_publisher',
      body: {
        slug: 'team-console',
        ownerType: 'team',
        teamId: team.id,
        visibility: 'org',
      },
    }),
    testEnvironment
  );
  assert.equal(teamSite.status, 201, await teamSite.clone().text());
  assert.deepEqual(await teamSite.json(), {
    site: {
      id: 'site_2',
      slug: 'team-console',
      hostname: 'team-console.workers.xd.team',
      owner: { type: 'team', displayName: 'Console Team', teamType: 'custom' },
      visibility: 'org',
      status: 'disabled',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
  });

  const viewer = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/workspace/sites', {
      userId: 'usr_viewer',
      body: {
        slug: 'viewer-console',
        ownerType: 'team',
        teamId: team.id,
      },
    }),
    testEnvironment
  );
  assert.equal(viewer.status, 403);
  assert.equal((await viewer.json()).error.code, 'TEAM_PUBLISHER_REQUIRED');
});

test('site detail computes permissions from team role for team-owned site', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUsers(store, ['usr_admin', 'usr_publisher', 'usr_other']);
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
    actorUserId: 'usr_admin',
  });
  await seedSite(store, {
    id: 'site_team',
    slug: 'team-owned',
    ownerUserId: 'usr_legacy_owner',
    ownerType: 'team',
    ownerId: team.id,
    visibility: 'org',
  });

  const detail = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_team', { userId: 'usr_publisher' }),
    env(store)
  );
  const forbidden = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_team', { userId: 'usr_other' }),
    env(store)
  );

  assert.equal(detail.status, 200, await detail.clone().text());
  assert.equal(forbidden.status, 404);

  const body = await detail.json();
  assert.equal(body.site.owner.type, 'team');
  assert.equal(body.site.owner.displayName, 'Console Team');
  assert.equal(body.site.permissions.role, 'publisher');
  assert.equal(body.site.permissions.canManage, true);
  assert.equal(body.site.permissions.canManageAccess, true);
  assertNoSensitiveConsoleFields(body);
});

test('site detail and subresources are internal-only, permission checked, and redacted', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_other');
  await seedConsoleUser(store, 'usr_me', { realname: '徐天麒' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'acl',
  });

  const detail = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine', { userId: 'usr_me' }),
    env(store)
  );
  const deployments = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine/deployments', { userId: 'usr_me' }),
    env(store)
  );
  const access = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine/access', { userId: 'usr_me' }),
    env(store)
  );
  const config = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine/config', { userId: 'usr_me' }),
    env(store)
  );
  const forbidden = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine', { userId: 'usr_other' }),
    env(store)
  );

  assert.equal(detail.status, 200, await detail.clone().text());
  assert.equal(deployments.status, 200, await deployments.clone().text());
  assert.equal(access.status, 200, await access.clone().text());
  assert.equal(config.status, 200, await config.clone().text());
  assert.equal(forbidden.status, 404);

  const detailBody = await detail.json();
  assert.equal(detailBody.site.slug, 'mine');
  assert.equal(detailBody.site.hostname, 'mine.workers.xd.team');
  assert.deepEqual(detailBody.site.owner, { type: 'user', id: 'usr_me', displayName: '徐天麒' });
  assert.equal(detailBody.site.access.visibility, 'acl');
  assert.deepEqual(await deployments.json(), { deployments: [] });
  assert.deepEqual(await access.json(), { access: { visibility: 'acl', aclEntries: [] } });
  assert.deepEqual(await config.json(), { config: { vars: [], secrets: [] } });
  assertNoSensitiveConsoleFields(detailBody);
});

test('site deployments subresource limits deployment history for scan performance', async () => {
  let tick = 0;
  const store = createTestPagesStore({
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  });
  await seedConsoleUser(store, 'usr_me', { realname: '徐天麒' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  for (let index = 0; index < 105; index += 1) {
    await store.createDeploymentForIdempotency({
      id: `dep_${index}`,
      environment: 'production',
      actorId: 'usr_me',
      actorUserId: 'usr_me',
      actorType: 'user',
      source: 'cli',
      siteId: 'site_mine',
      operation: 'deploy',
      idempotencyKey: `idem_${index}`,
      requestHash: `hash_${index}`,
      visibility: 'org',
      status: 'succeeded',
    });
  }

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine/deployments', { userId: 'usr_me' }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const deployments = (await response.json()).deployments;
  assert.equal(deployments.length, 100);
  assert.equal(deployments[0].id, 'dep_104');
  assert.equal(deployments.at(-1).id, 'dep_5');
});

test('site config writes allow publisher access policy and runtime config', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUsers(store, ['usr_admin', 'usr_publisher']);
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
    actorUserId: 'usr_admin',
  });
  await seedSite(store, {
    id: 'site_team',
    slug: 'team-owned',
    ownerUserId: 'usr_legacy_owner',
    ownerType: 'team',
    ownerId: team.id,
    visibility: 'org',
  });

  const putVar = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_team/config/vars/API_BASE', {
      userId: 'usr_publisher',
      method: 'PUT',
      body: { value: 'https://api.example.com' },
    }),
    env(store)
  );
  const access = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_team/access', {
      userId: 'usr_publisher',
      method: 'PATCH',
      body: { visibility: 'internal' },
    }),
    env(store)
  );
  const putSecret = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_team/config/secrets/API_TOKEN', {
      userId: 'usr_publisher',
      method: 'PUT',
      body: { value: 'super-secret-value' },
    }),
    env(store)
  );
  const config = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_team/config', { userId: 'usr_publisher' }),
    env(store)
  );

  assert.equal(putVar.status, 200, await putVar.clone().text());
  assert.deepEqual((await putVar.json()).var, {
    name: 'API_BASE',
    value: 'https://api.example.com',
    revision: 1,
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  assert.equal(access.status, 200, await access.clone().text());
  assert.equal((await access.json()).access.visibility, 'internal');
  assert.equal(putSecret.status, 200, await putSecret.clone().text());
  const secretBody = await putSecret.json();
  assert.deepEqual(secretBody.secret, {
    name: 'API_TOKEN',
    revision: 1,
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(secretBody), /super-secret-value/);
  assert.deepEqual(await config.json(), {
    config: {
      vars: [
        {
          name: 'API_BASE',
          value: 'https://api.example.com',
          revision: 1,
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
      secrets: [
        {
          name: 'API_TOKEN',
          revision: 1,
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
    },
  });
});

test('site admin secret changes sync to active WFP worker', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { workerName: 'pages-v2-mine-ver-1' });
  const synced = [];
  const testEnvironment = env(store, {
    WFP_PROVIDER: {
      putSecret: async (input) => synced.push(['put', input.workerName, input.name, input.value]),
      deleteSecret: async (input) => synced.push(['delete', input.workerName, input.name]),
    },
  });

  const putSecret = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'super-secret-value' },
    }),
    testEnvironment
  );
  const deleteSecret = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    testEnvironment
  );

  assert.equal(putSecret.status, 200, await putSecret.clone().text());
  assert.equal(deleteSecret.status, 200, await deleteSecret.clone().text());
  assert.deepEqual(synced, [
    ['put', 'pages-v2-mine-ver-1', 'API_TOKEN', 'super-secret-value'],
    ['delete', 'pages-v2-mine-ver-1', 'API_TOKEN'],
  ]);
});

test('site admin secret update reports active WFP worker sync failures', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { workerName: 'pages-v2-mine-ver-1' });

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'super-secret-value' },
    }),
    env(store, {
      WFP_PROVIDER: {
        putSecret: async () => {
          throw new Error('cloudflare failed');
        },
      },
    })
  );

  assert.equal(response.status, 502, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SECRET_ACTIVE_WORKER_SYNC_FAILED');
  assert.equal((await store.listEnabledSiteSecrets('production', 'site_mine'))[0].name, 'API_TOKEN');
});

test('site admin can update access policy and delete runtime config entries', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_mine',
    vars: { API_BASE: 'https://api.example.com' },
    actorId: 'usr_me',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  await store.putSiteSecretWithAudit({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_mine',
    siteSlug: 'mine',
    name: 'API_TOKEN',
    value: 'super-secret-value',
    actorId: 'usr_me',
    actorType: 'user',
    routeId: 'route_site_mine',
    auditId: 'aud_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });

  const access = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/access', {
      userId: 'usr_me',
      method: 'PATCH',
      body: {
        visibility: 'acl',
        aclEntries: [{ subjectType: 'email', subjectValue: 'teammate@example.com', accessRole: 'viewer' }],
      },
    }),
    env(store)
  );
  const deleteVar = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/API_BASE', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store)
  );
  const deleteSecret = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store)
  );
  const config = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine/config', { userId: 'usr_me' }),
    env(store)
  );

  assert.equal(access.status, 200, await access.clone().text());
  assert.deepEqual(await access.json(), {
    access: {
      visibility: 'acl',
      aclEntries: [
        {
          id: 'acl_1',
          subjectType: 'email',
          subjectValue: 'teammate@example.com',
          accessRole: 'viewer',
          effect: 'allow',
          createdAt: '2026-06-15T00:00:00.000Z',
        },
      ],
    },
  });
  assert.equal(deleteVar.status, 200, await deleteVar.clone().text());
  assert.deepEqual(await deleteVar.json(), { var: { name: 'API_BASE', deleted: true } });
  assert.equal(deleteSecret.status, 200, await deleteSecret.clone().text());
  assert.deepEqual(await deleteSecret.json(), { secret: { name: 'API_TOKEN', deleted: true } });
  assert.deepEqual(await config.json(), { config: { vars: [], secrets: [] } });
});

test('site owner can delete a site from console settings', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.site.id, 'site_mine');
  assert.equal(body.site.status, 'deleted');
  const detail = await store.getConsoleSiteDetail({
    environment: 'production',
    userId: 'usr_me',
    siteId: 'site_mine',
  });
  assert.equal(detail, null);
});

test('site publisher can transfer site owner from console settings to an active user', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await seedConsoleUser(store, 'usr_target', {
    email: 'target@example.com',
    realname: '目标用户',
  });

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/settings', {
      userId: 'usr_me',
      method: 'PATCH',
      body: { ownerType: 'user', ownerId: 'usr_target' },
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.site.owner, {
    type: 'user',
    id: 'usr_target',
    email: 'target@example.com',
    displayName: '目标用户',
  });
  assert.equal(body.site.permissions.canManage, false);
  const site = await store.getSite('site_mine');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_target');
  assert.equal(site.ownerUserId, 'usr_target');
});

test('site publisher cannot transfer site owner from console settings to a disabled user', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_owner');
  await seedConsoleUser(store, 'usr_disabled', { employeeStatus: 'disabled' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_owner',
    visibility: 'org',
  });

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/settings', {
      userId: 'usr_owner',
      method: 'PATCH',
      body: { ownerType: 'user', ownerId: 'usr_disabled' },
    }),
    env(store)
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_TRANSFER_FORBIDDEN');
  const site = await store.getSite('site_mine');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_owner');
});

test('site publisher can transfer site owner from console settings to a manageable team', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await store.createTeam({
    id: 'team_console',
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    createdByUserId: 'usr_me',
  });
  await store.addTeamMember({
    teamId: 'team_console',
    userId: 'usr_me',
    role: 'publisher',
    membershipSource: 'manual',
  });

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/settings', {
      userId: 'usr_me',
      method: 'PATCH',
      body: { ownerType: 'team', teamId: 'team_console' },
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.site.owner, {
    type: 'team',
    id: 'team_console',
    displayName: 'Console Team',
    teamType: 'custom',
  });
  assert.equal(body.site.permissions.canManage, true);
  const site = await store.getSite('site_mine');
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, 'team_console');
  assert.equal(site.ownerUserId, 'usr_me');
});

test('site publisher can delete a team site from console settings', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_admin',
  });
  await seedSite(store, {
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_admin',
    ownerType: 'team',
    ownerId: 'team_1',
    visibility: 'org',
  });
  await store.createUser({
    userId: 'usr_publisher',
    email: 'publisher@example.com',
    employeeStatus: 'active',
  });
  await store.addTeamMember({
    teamId: 'team_1',
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_team', {
      userId: 'usr_publisher',
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).site.status, 'deleted');
  assert.equal(await store.getConsoleSiteDetail({ environment: 'production', userId: 'usr_admin', siteId: 'site_team' }), null);
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    nextId: (prefix) => `${prefix}_1`,
    now: () => '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

function envWithSequencedIds(store, overrides = {}) {
  const counters = new Map();
  return env(store, {
    nextId: (prefix) => {
      const next = (counters.get(prefix) || 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${next}`;
    },
    nextSiteUuid: () => {
      const next = (counters.get('uuid') || 0) + 1;
      counters.set('uuid', next);
      return `uuid_${next}`;
    },
    ...overrides,
  });
}

function internalConsoleRequest(
  path,
  { userId, email = 'user@example.com', admin = false, sessionVersion, method = 'GET' } = {}
) {
  const headers = {
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
  };
  if (userId) {
    headers['X-Console-User-Id'] = userId;
    headers['X-Console-Email'] = email;
    headers['X-Console-Admin'] = admin ? 'true' : 'false';
    if (sessionVersion !== undefined) headers['X-Console-Session-Version'] = String(sessionVersion);
  }
  return new Request(`https://pages-api.internal${path}`, { method, headers });
}

function internalConsoleJsonRequest(path, { userId, email = 'user@example.com', admin = false, method = 'POST', body } = {}) {
  const request = internalConsoleRequest(path, { userId, email, admin, method });
  const headers = Object.fromEntries(request.headers.entries());
  headers['Content-Type'] = 'application/json';
  return new Request(request.url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedSite(store, { id, slug, ownerUserId, ownerType, ownerId, visibility }) {
  if (ownerUserId && !(await store.getUser(ownerUserId))) await seedConsoleUser(store, ownerUserId);
  await store.createSite({
    id,
    slug,
    ownerUserId,
    ownerType,
    ownerId,
    siteUuid: `uuid_${id}`,
    defaultVisibility: visibility,
    environment: 'production',
    routeId: `route_${id}`,
    hostname: `${slug}.workers.xd.team`,
  });
}

async function seedConsoleUsers(store, userIds) {
  for (const userId of userIds) await seedConsoleUser(store, userId);
}

async function seedConsoleUser(store, userId, overrides = {}) {
  if (await store.getUser(userId)) return;
  await store.createUser({
    userId,
    email: `${userId}@example.com`,
    employeeStatus: 'active',
    sessionVersion: 1,
    ...overrides,
  });
}

async function activateSite(store, siteId, { workerName = 'pages-v2-site-ver-1', visibility = 'org' } = {}) {
  await store.createSiteVersion({
    id: `ver_${siteId}`,
    siteId,
    deploymentId: `dep_${siteId}`,
    workerName,
    runtime: 'wfp',
    artifactRef: `wfp://test/${workerName}`,
    contentHash: 'sha256:abc',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    createdBy: 'usr_me',
  });
  return store.activateSiteVersion(
    siteId,
    {
      activeVersionId: `ver_${siteId}`,
      workerName,
      visibility,
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
    'production'
  );
}

function assertNoSensitiveConsoleFields(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /ownerUserId/);
  assert.doesNotMatch(text, /route_/);
  assert.doesNotMatch(text, /siteUuid/);
  assert.doesNotMatch(text, /workerName/);
  assert.doesNotMatch(text, /dispatchBindingName/);
  assert.doesNotMatch(text, /token/i);
  assert.doesNotMatch(text, /secret/i);
}
