import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { markRuntimeConfigError } from './runtime-config-diagnostics.js';
import { createTestPagesStore } from './test-store.js';
import { seedLifecycleWebhook, TEST_WEBHOOK_URL_ENCRYPTION_KEY } from './lifecycle-webhook-test-fixtures.js';

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
  await seedSite(store, {
    id: 'site_org',
    slug: 'org-demo',
    ownerUserId: 'usr_owner',
    visibility: 'org',
  });
  await seedSite(store, {
    id: 'site_acl',
    slug: 'acl-demo',
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await store.addSiteAclEntries(
    'site_acl',
    [{ id: 'acl_viewer', subjectType: 'email', subjectValue: 'viewer@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_owner', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );

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

test('authenticated directory includes org and ACL matched sites without requiring management access', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_viewer', {
    email: 'viewer@example.com',
    realname: 'Viewer Name',
    departmentPath: '心动/平台支撑部/Web',
    departmentCheckedAt: '2026-06-15T00:00:00.000Z',
  });
  await seedConsoleUser(store, 'usr_owner', {
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
    id: 'site_org',
    slug: 'org-demo',
    ownerUserId: 'usr_owner',
    visibility: 'org',
  });
  await activateSite(store, 'site_org', { visibility: 'org' });
  await seedSite(store, {
    id: 'site_acl_email',
    slug: 'acl-email-demo',
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await activateSite(store, 'site_acl_email', { visibility: 'acl' });
  await store.addSiteAclEntries(
    'site_acl_email',
    [{ id: 'acl_email', subjectType: 'email', subjectValue: 'viewer@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_owner', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  await seedSite(store, {
    id: 'site_acl_department',
    slug: 'acl-dept-demo',
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await activateSite(store, 'site_acl_department', { visibility: 'acl' });
  await store.addSiteAclEntries(
    'site_acl_department',
    [{ id: 'acl_dept', subjectType: 'department', subjectValue: '心动/平台支撑部', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_owner', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  await seedSite(store, {
    id: 'site_acl_miss',
    slug: 'acl-miss-demo',
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await activateSite(store, 'site_acl_miss', { visibility: 'acl' });
  await store.addSiteAclEntries(
    'site_acl_miss',
    [{ id: 'acl_miss', subjectType: 'email', subjectValue: 'blocked@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_owner', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  await seedSite(store, {
    id: 'site_owner_only',
    slug: 'owner-only-demo',
    ownerUserId: 'usr_owner',
    visibility: 'owner',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/directory', {
      userId: 'usr_viewer',
      email: 'viewer@example.com',
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(
    body.sites.map((site) => [site.id, site.slug, site.visibility, site.owner.displayName]),
    [
      ['site_acl_department', 'acl-dept-demo', 'acl', 'Owner Name'],
      ['site_acl_email', 'acl-email-demo', 'acl', 'Owner Name'],
      ['site_internal', 'internal-demo', 'internal', 'Owner Name'],
      ['site_org', 'org-demo', 'org', 'Owner Name'],
    ]
  );
  assertNoSensitiveConsoleFields(body);
});

test('authenticated directory does not match blank email ACL entries to viewers without email', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_viewer', {
    email: '',
    realname: 'Viewer Name',
  });
  await seedConsoleUser(store, 'usr_owner', {
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
    id: 'site_acl_blank_email',
    slug: 'acl-blank-email-demo',
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await activateSite(store, 'site_acl_blank_email', { visibility: 'acl' });
  await store.addSiteAclEntries(
    'site_acl_blank_email',
    [{ id: 'acl_blank_email', subjectType: 'email', subjectValue: '   ', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_owner', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/directory', {
      userId: 'usr_viewer',
      email: '',
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    (await response.json()).sites.map((site) => [site.id, site.slug, site.visibility]),
    [['site_internal', 'internal-demo', 'internal']]
  );
});

test('authenticated directory hydrates missing department before matching department ACL entries', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await seedConsoleUser(store, 'usr_viewer', {
    email: 'viewer@example.com',
    departmentPath: null,
  });
  await seedConsoleUser(store, 'usr_owner', {
    email: 'owner@example.com',
    realname: 'Owner Name',
  });
  await seedSite(store, {
    id: 'site_acl_department',
    slug: 'acl-dept-demo',
    ownerUserId: 'usr_owner',
    visibility: 'acl',
  });
  await activateSite(store, 'site_acl_department', { visibility: 'acl' });
  await store.addSiteAclEntries(
    'site_acl_department',
    [{ id: 'acl_dept', subjectType: 'department', subjectValue: '心动/平台支撑部', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_owner', updatedAt: '2026-07-01T10:00:00.000Z' },
    'production'
  );
  let xdsCalled = false;

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/directory', {
      userId: 'usr_viewer',
      email: 'viewer@example.com',
    }),
    env(store, {
      XDS_OPENAI_TOKEN: 'secret-token',
      now: () => '2026-07-01T10:00:00.000Z',
      XD_OFFICE_NET: {
        fetch: async () => {
          xdsCalled = true;
          return Response.json({
            code: 0,
            data: [{ email: 'viewer@example.com', departmentPath: '心动/平台支撑部/Web' }],
          });
        },
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(xdsCalled, true);
  assert.deepEqual(
    (await response.json()).sites.map((site) => [site.id, site.slug, site.visibility]),
    [['site_acl_department', 'acl-dept-demo', 'acl']]
  );
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
  await seedConsoleUser(store, 'usr_root');
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

test('console auth session ensures stored department path has canonical department membership', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_member',
    email: 'member@xd.com',
    employeeStatus: 'active',
    sessionVersion: 1,
    departmentPath: '心动/发行服务/平台支撑部/技术/Web',
    departmentCheckedAt: '2026-07-01T09:59:00.000Z',
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
        fetch: async () => {
          xdsCalled = true;
          return Response.json({ code: 0, data: [] });
        },
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(xdsCalled, false);

  const teams = await store.listTeamsForUser({ environment: 'production', userId: 'usr_member' });
  assert.deepEqual(
    teams.map((team) => [team.name, team.departmentPath, team.teamType, team.currentUserRole]),
    [['平台支撑部', '心动/发行服务/平台支撑部', 'department', 'admin']]
  );
  const member = await store.getTeamMember({ teamId: teams[0].id, userId: 'usr_member' });
  assert.equal(member.departmentPath, '心动/发行服务/平台支撑部/技术/Web');
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

test('console auth session does not refresh a stale department path when hydration is unavailable', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_member',
    email: 'member@xd.com',
    employeeStatus: 'active',
    sessionVersion: 1,
    departmentPath: '心动/旧部门',
    departmentCheckedAt: '2026-06-29T10:00:00.000Z',
  });

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
        fetch: async () => Response.json({ code: 500, message: 'unavailable' }, { status: 503 }),
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const user = await store.getUser('usr_member');
  assert.equal(user.departmentPath, null);
  assert.equal(user.departmentCheckedAt, '2026-07-01T10:00:00.000Z');
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
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/workspace/sites?owner=team&teamId=${encodeURIComponent(teamA.id)}`, {
      userId: 'usr_me',
    }),
    env(store, { ROUTE_SNAPSHOTS: snapshots })
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

test('console rejects creating team-owned sites for deleted teams', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const testEnvironment = envWithSequencedIds(store);
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
  const originalGetTeam = store.getTeam.bind(store);
  store.getTeam = async (teamId) => {
    const record = await originalGetTeam(teamId);
    return record ? { ...record, deletedAt: '2026-06-15T00:00:00.000Z' } : null;
  };

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/workspace/sites', {
      userId: 'usr_publisher',
      body: {
        slug: 'deleted-team-site',
        ownerType: 'team',
        teamId: team.id,
        visibility: 'org',
      },
    }),
    testEnvironment
  );

  assert.equal(response.status, 404, await response.clone().text());
  assert.equal((await response.json()).error.code, 'TEAM_NOT_FOUND');
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
  await activateSite(store, 'site_mine', { visibility: 'owner' });
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
    appliesTo: 'next_deployment',
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

test('Console access emits site.disabled only for the visibility transition', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const requests = [];
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { visibility: 'org' });
  await seedLifecycleWebhook(store, 'site.disabled');
  const testEnvironment = env(store, {
    ROUTE_SNAPSHOTS: createSnapshotStore(),
    WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
  });

  const aclOnly = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/access', {
      userId: 'usr_me',
      method: 'PATCH',
      body: {
        visibility: 'org',
        aclEntries: [{ subjectType: 'email', subjectValue: 'viewer@example.com', accessRole: 'viewer' }],
      },
    }),
    testEnvironment
  );
  assert.equal(aclOnly.status, 200, await aclOnly.clone().text());
  assert.equal(requests.length, 0);

  const disabled = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/access', {
      userId: 'usr_me',
      method: 'PATCH',
      body: { visibility: 'disabled' },
    }),
    testEnvironment
  );
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.disabled');
  assert.equal(payload.actor.userId, 'usr_me');
  assert.deepEqual(payload.change, {
    field: 'visibility',
    previousValue: 'org',
    currentValue: 'disabled',
  });
});

test('Console runtime vars accept long runtime var names without deriving record ids from them', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_me');
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const mutateSiteVar = store.mutateSiteVar.bind(store);
  store.mutateSiteVar = async (input) => {
    input.createId?.(input.name);
    return mutateSiteVar(input);
  };

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/LONG_RUNTIME_CONFIGURATION_NAME', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'enabled' },
    }),
    env(store, {
      nextId: (prefix) => {
        if (prefix !== 'var') throw new Error('INVALID_RUNTIME_VAR_ID_PREFIX');
        return 'var_1';
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).var, {
    name: 'LONG_RUNTIME_CONFIGURATION_NAME',
    value: 'enabled',
    revision: 1,
    updatedAt: '2026-06-15T00:00:00.000Z',
    appliesTo: 'next_deployment',
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

test('site admin var changes sync to active WFP worker plain text bindings', async () => {
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
      replacePlainTextBindings: async (input) => {
        const vars = Object.fromEntries(Object.entries(input.vars).sort());
        synced.push(['replacePlainTextBindings', input.workerName, vars]);
      },
    },
  });

  const putVar = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/API_BASE', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'https://api.example.com' },
    }),
    testEnvironment
  );
  const deleteVar = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/API_BASE', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    testEnvironment
  );

  assert.equal(putVar.status, 200, await putVar.clone().text());
  assert.equal(deleteVar.status, 200, await deleteVar.clone().text());
  assert.deepEqual((await putVar.json()).var.appliesTo, 'active_worker');
  assert.deepEqual(await deleteVar.json(), { var: { name: 'API_BASE', deleted: true, appliesTo: 'active_worker' } });
  assert.deepEqual(synced, [
    ['replacePlainTextBindings', 'pages-v2-mine-ver-1', { API_BASE: 'https://api.example.com' }],
    ['replacePlainTextBindings', 'pages-v2-mine-ver-1', {}],
  ]);
});

test('site admin concurrent var puts preserve both runtime bindings', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const testEnvironment = env(store);

  const [apiBase, featureFlag] = await Promise.all([
    worker.fetch(
      internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/API_BASE', {
        userId: 'usr_me',
        method: 'PUT',
        body: { value: 'https://api.example.com' },
      }),
      testEnvironment
    ),
    worker.fetch(
      internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/FEATURE_FLAG', {
        userId: 'usr_me',
        method: 'PUT',
        body: { value: 'on' },
      }),
      testEnvironment
    ),
  ]);

  assert.equal(apiBase.status, 200, await apiBase.clone().text());
  assert.equal(featureFlag.status, 200, await featureFlag.clone().text());
  assert.deepEqual(
    (await store.listEnabledSiteVars('production', 'site_mine')).map(({ name, value }) => ({ name, value })),
    [
      { name: 'API_BASE', value: 'https://api.example.com' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ]
  );
});

test('site admin var mutations map binding and revision conflicts to stable errors', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await store.putSiteSecret({
    id: 'sec_api_base',
    environment: 'production',
    siteId: 'site_mine',
    name: 'API_BASE',
    value: 'existing-secret-private-value',
    actorId: 'usr_me',
  });

  const conflict = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/API_BASE', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'new-var-private-value' },
    }),
    env(store)
  );
  for (let index = 1; index < 64; index += 1) {
    const name = `SECRET_${String(index).padStart(2, '0')}`;
    store.siteSecrets.set(`production:site_mine:${name}`, {
      id: `sec_${index}`,
      environment: 'production',
      siteId: 'site_mine',
      name,
      value: `secret-${index}`,
      revision: 1,
      createdBy: 'usr_me',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    });
  }
  const quota = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/FEATURE_FLAG', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'quota-private-value' },
    }),
    env(store)
  );
  store.mutateSiteVar = async () => {
    throw new Error('SITE_VAR_REVISION_CONFLICT');
  };
  const revision = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/FEATURE_FLAG', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store)
  );
  const conflictText = await conflict.text();
  const quotaText = await quota.text();

  assert.equal(conflict.status, 400);
  assert.equal(JSON.parse(conflictText).error.code, 'RUNTIME_BINDING_NAME_CONFLICT');
  assert.doesNotMatch(conflictText, /existing-secret-private-value|new-var-private-value/);
  assert.equal(quota.status, 413);
  assert.equal(JSON.parse(quotaText).error.code, 'RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  assert.doesNotMatch(quotaText, /quota-private-value|secret-\d/);
  assert.equal(revision.status, 409);
  assert.equal((await revision.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
});

test('site admin var mutations log one safe diagnostic for unexpected store failures', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'sensitive-console-slug',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const error = new Error('SENSITIVE_ERROR_MESSAGE SENSITIVE_SQL');
  error.name = 'SENSITIVE_ERROR_NAME';
  error.code = 'SENSITIVE_ERROR_CODE';
  error.stack = 'SENSITIVE_ERROR_STACK';
  error.cause = new Error('SENSITIVE_ERROR_CAUSE');
  store.mutateSiteVar = async () => {
    throw markRuntimeConfigError(error, { stage: 'mutation_batch', reason: 'store_operation_failed' });
  };
  const lines = [];

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/SENSITIVE_VAR_NAME', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'SENSITIVE_VAR_VALUE' },
    }),
    env(store, { logRuntimeConfigFailure: (line) => lines.push(line) })
  );
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(text), {
    error: {
      code: 'RUNTIME_CONFIG_UNSUPPORTED',
      message: 'Runtime config store is unavailable.',
      action: 'Check runtime config store configuration.',
    },
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'pages_runtime_config_failure',
    operation: 'var_put',
    environment: 'production',
    siteId: 'site_mine',
    stage: 'mutation_batch',
    reason: 'store_operation_failed',
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
  assert.doesNotMatch(lines[0], /sensitive|SENSITIVE|Authorization|Bearer|SQL/);
});

test('site admin var mutations log capability failures', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  store.mutateSiteVar = undefined;
  const lines = [];

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/FEATURE_FLAG', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store, { logRuntimeConfigFailure: (line) => lines.push(line) })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'pages_runtime_config_failure',
    operation: 'var_delete',
    environment: 'production',
    siteId: 'site_mine',
    stage: 'capability_check',
    reason: 'capability_unavailable',
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
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
  const lines = [];

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'super-secret-value' },
    }),
    env(store, {
      logRuntimeConfigFailure: (line) => lines.push(line),
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
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_sync',
        environment: 'production',
        siteId: 'site_mine',
        stage: 'provider_sync',
        reason: 'provider_request_failed',
        errorCode: 'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      },
    ]
  );
});

test('site admin secret writes map binding conflicts and quotas to stable errors', async () => {
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
    vars: { FEATURE_FLAG: 'on' },
    actorId: 'usr_me',
  });

  const lines = [];
  const environment = env(store, { logRuntimeConfigFailure: (line) => lines.push(line) });
  const conflict = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/FEATURE_FLAG', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'conflicting-secret-value' },
    }),
    environment
  );
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_mine',
    vars: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`VAR_${String(index).padStart(2, '0')}`, 'on'])),
    actorId: 'usr_me',
  });
  const quota = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'quota-secret-value' },
    }),
    environment
  );
  store.putSiteSecretWithAudit = async () => {
    throw new Error('SITE_SECRET_REVISION_CONFLICT');
  };
  const revision = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'revision-secret-value' },
    }),
    environment
  );
  const conflictText = await conflict.text();
  const quotaText = await quota.text();

  assert.equal(conflict.status, 400);
  assert.equal(JSON.parse(conflictText).error.code, 'RUNTIME_BINDING_NAME_CONFLICT');
  assert.doesNotMatch(conflictText, /conflicting-secret-value/);
  assert.equal(quota.status, 413);
  assert.equal(JSON.parse(quotaText).error.code, 'RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  assert.doesNotMatch(quotaText, /quota-secret-value/);
  assert.equal(revision.status, 409);
  assert.equal((await revision.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(lines, []);
});

test('site admin secret mutations log safe store and capability diagnostics', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'sensitive-console-secret-slug',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const lines = [];
  const environment = env(store, { logRuntimeConfigFailure: (line) => lines.push(line) });
  const storeError = new Error('SENSITIVE_SECRET_VALUE SENSITIVE_SQL');
  storeError.cause = new Error('SENSITIVE_SECRET_CAUSE');
  const throwStoreError = async () => {
    throw markRuntimeConfigError(storeError, { stage: 'mutation_batch', reason: 'store_operation_failed' });
  };
  store.putSiteSecretWithAudit = throwStoreError;
  store.deleteSiteSecretWithAudit = throwStoreError;

  const putFailure = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/SENSITIVE_SECRET_NAME', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'SENSITIVE_SECRET_VALUE' },
    }),
    environment
  );
  const deleteFailure = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/SENSITIVE_SECRET_NAME', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    environment
  );

  store.putSiteSecretWithAudit = undefined;
  store.deleteSiteSecretWithAudit = undefined;
  const putCapability = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/SENSITIVE_SECRET_NAME', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'SENSITIVE_SECRET_VALUE' },
    }),
    environment
  );
  const deleteCapability = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/SENSITIVE_SECRET_NAME', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    environment
  );

  assert.deepEqual(
    [putFailure, deleteFailure, putCapability, deleteCapability].map((response) => response.status),
    [503, 503, 503, 503]
  );
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_put',
        environment: 'production',
        siteId: 'site_mine',
        stage: 'mutation_batch',
        reason: 'store_operation_failed',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_delete',
        environment: 'production',
        siteId: 'site_mine',
        stage: 'mutation_batch',
        reason: 'store_operation_failed',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_put',
        environment: 'production',
        siteId: 'site_mine',
        stage: 'capability_check',
        reason: 'capability_unavailable',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_delete',
        environment: 'production',
        siteId: 'site_mine',
        stage: 'capability_check',
        reason: 'capability_unavailable',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
    ]
  );
  assert.doesNotMatch(lines.join('\n'), /sensitive|SENSITIVE|Authorization|Bearer|SQL/);
});

test('site admin secret writes map store failures to runtime config errors', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z', failAuditWrites: true });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const lines = [];

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'PUT',
      body: { value: 'super-secret-value' },
    }),
    env(store, { logRuntimeConfigFailure: (line) => lines.push(line) })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_CONFIG_UNSUPPORTED');
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_mine'), []);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_put',
        environment: 'production',
        siteId: 'site_mine',
        stage: 'unknown',
        reason: 'store_operation_failed',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
    ]
  );
});

test('site admin secret deletes map store failures to runtime config errors', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
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
  store.failAuditWrites = true;
  const lines = [];

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/secrets/API_TOKEN', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store, { logRuntimeConfigFailure: (line) => lines.push(line) })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_CONFIG_UNSUPPORTED');
  assert.equal((await store.listEnabledSiteSecrets('production', 'site_mine'))[0].name, 'API_TOKEN');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_delete',
        environment: 'production',
        siteId: 'site_mine',
        stage: 'unknown',
        reason: 'store_operation_failed',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
    ]
  );
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
  assert.deepEqual(await deleteVar.json(), { var: { name: 'API_BASE', deleted: true, appliesTo: 'next_deployment' } });
  assert.equal(deleteSecret.status, 200, await deleteSecret.clone().text());
  assert.deepEqual(await deleteSecret.json(), { secret: { name: 'API_TOKEN', deleted: true } });
  assert.deepEqual(await config.json(), { config: { vars: [], secrets: [] } });
});

test('console access update commits visibility and ACL once while preserving public exposure', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const initialRoute = await activateSite(store, 'site_mine', { visibility: 'org' });
  store.routes.get(initialRoute.id).exposure = 'public';
  store.sites.get('site_mine').defaultExposure = 'public';
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/access', {
      userId: 'usr_me',
      method: 'PATCH',
      body: {
        visibility: 'acl',
        aclEntries: [{ subjectType: 'email', subjectValue: 'teammate@example.com', accessRole: 'viewer' }],
      },
    }),
    env(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
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
  const route = await store.getRouteBySiteId('site_mine', 'production');
  assert.equal(route.policyVersion, initialRoute.policyVersion + 1);
  assert.equal(route.exposure, 'public');
  assert.equal(route.accessMode, 'acl');
  const pointer = snapshots.read('production:route_pointer:mine.workers.xd.team');
  assert.equal(pointer.policyVersion, route.policyVersion);
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.exposure, 'public');
  assert.equal(snapshot.accessMode, 'acl');
  assert.deepEqual(snapshot.acl, [{ effect: 'allow', subjectType: 'email', subjectValue: 'teammate@example.com' }]);
});

test('console access update returns a stable conflict while the site lease is held', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_me');
  await seedSite(store, {
    id: 'site_console_lease_conflict',
    slug: 'console-lease-conflict',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const site = await store.getSite('site_console_lease_conflict');
  await activateSite(store, site.id, { visibility: 'org' });
  const lease = await store.acquireSiteCommitLock('production', site.id, { lockId: 'held_by_other_writer' });
  assert.ok(lease);

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_console_lease_conflict/access', {
      userId: 'usr_me',
      method: 'PATCH',
      body: { visibility: 'acl', aclEntries: [] },
    }),
    env(store, { ROUTE_SNAPSHOTS: createSnapshotStore() })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_POLICY_CONFLICT');
  assert.equal((await store.getRouteBySiteId(site.id)).visibility, 'org');
  await store.releaseSiteCommitLock('production', site.id, lease.lockId);
});

test('console access snapshot failure compensates visibility and ACL while preserving public exposure', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_me');
  await seedSite(store, {
    id: 'site_console_repair',
    slug: 'console-repair',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const site = await store.getSite('site_console_repair');
  await store.replaceSiteAclEntries(
    site.id,
    [{ id: 'acl_existing', subjectType: 'email', subjectValue: 'existing@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_me', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  const initialRoute = await activateSite(store, site.id, { visibility: 'org' });
  store.routes.get(initialRoute.id).exposure = 'public';
  store.sites.get(site.id).defaultExposure = 'public';

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_console_repair/access', {
      userId: 'usr_me',
      method: 'PATCH',
      body: {
        visibility: 'acl',
        aclEntries: [{ subjectType: 'email', subjectValue: 'new@example.com', accessRole: 'viewer' }],
      },
    }),
    env(store, { ROUTE_SNAPSHOTS: failingSnapshotStore() })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_POLICY_REPAIR_REQUIRED');
  const route = await store.getRouteBySiteId(site.id, 'production');
  assert.equal(route.visibility, 'org');
  assert.equal(route.exposure, 'public');
  assert.equal(route.policyVersion, initialRoute.policyVersion + 2);
  assert.deepEqual(await store.listSiteAclEntries(site.id), [
    {
      id: 'acl_existing',
      siteId: site.id,
      subjectType: 'email',
      subjectValue: 'existing@example.com',
      accessRole: 'viewer',
      effect: 'allow',
      createdBy: 'usr_me',
      createdAt: '2026-06-15T00:00:00.000Z',
    },
  ]);
});

test('regular console access API rejects explicit exposure changes', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_me');
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  const route = await activateSite(store, 'site_mine', { visibility: 'org' });
  store.routes.get(route.id).exposure = 'public';
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/access', {
      userId: 'usr_me',
      method: 'PATCH',
      body: { visibility: 'acl', exposure: 'internal' },
    }),
    env(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_EXPOSURE_ADMIN_REQUIRED');
  assert.equal((await store.getRouteBySiteId('site_mine')).exposure, 'public');
});

test('site owner can delete a site from console settings', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const requests = [];
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { visibility: 'org' });
  await seedLifecycleWebhook(store, 'site.deleted');

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store, {
      ROUTE_SNAPSHOTS: createSnapshotStore(),
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
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
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.deleted');
  assert.equal(payload.actor.userId, 'usr_me');
  assert.equal(payload.site.status, 'deleted');
});

test('console delete does not emit site.deleted when the deleted route snapshot fails', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const requests = [];
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { visibility: 'org' });
  await seedLifecycleWebhook(store, 'site.deleted');

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    env(store, {
      ROUTE_SNAPSHOTS: failingSnapshotStore(),
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(requests.length, 0);
});

test('console missing and repeated deletes do not emit site.deleted', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const requests = [];
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { visibility: 'org' });
  await seedLifecycleWebhook(store, 'site.deleted');
  const deleteEnv = env(store, {
    ROUTE_SNAPSHOTS: createSnapshotStore(),
    WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
  });

  const missing = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_missing', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    deleteEnv
  );
  const first = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    deleteEnv
  );
  const repeated = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_mine', {
      userId: 'usr_me',
      method: 'DELETE',
    }),
    deleteEnv
  );

  assert.equal(missing.status, 404, await missing.clone().text());
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(repeated.status, 404, await repeated.clone().text());
  assert.equal(requests.length, 1);
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

test('site publisher owner transfer rolls back when route snapshot cannot refresh', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { visibility: 'org' });
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
    env(store, { ROUTE_SNAPSHOTS: failingSnapshotStore() })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  const site = await store.getSite('site_mine');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_me');
  assert.equal(site.ownerUserId, 'usr_me');
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
  await activateSite(store, 'site_mine', { visibility: 'org' });
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
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/settings', {
      userId: 'usr_me',
      method: 'PATCH',
      body: { ownerType: 'team', teamId: 'team_console' },
    }),
    env(store, { ROUTE_SNAPSHOTS: snapshots })
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
  const pointer = snapshots.read('production:route_pointer:mine.workers.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.visibility, 'org');
  assert.equal(snapshot.ownerUserId, null);
});

test('console rejects transferring owner-visible sites to teams', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedSite(store, {
    id: 'site_mine',
    slug: 'mine',
    ownerUserId: 'usr_me',
    visibility: 'org',
  });
  await activateSite(store, 'site_mine', { visibility: 'owner' });
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

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_VISIBILITY_INVALID');
  assert.equal((await store.getSite('site_mine')).ownerType, 'user');
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
  await activateSite(store, 'site_team', { visibility: 'org' });
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
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/sites/site_team', {
      userId: 'usr_publisher',
      method: 'DELETE',
    }),
    env(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).site.status, 'deleted');
  const pointer = snapshots.read('production:route_pointer:team-guide.workers.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.routeStatus, 'deleted');
  assert.equal(snapshot.runtime, 'disabled');
  assert.equal(snapshot.ownerUserId, null);
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

function createSnapshotStore() {
  const values = new Map();
  return {
    put: async (key, value) => values.set(key, JSON.parse(value)),
    read: (key) => values.get(key),
  };
}

function failingSnapshotStore() {
  return {
    put: async () => {
      throw new Error('snapshot write failed');
    },
  };
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
