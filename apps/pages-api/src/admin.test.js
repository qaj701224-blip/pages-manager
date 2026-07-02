import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('admin dashboard requires platform admin and returns governance counts', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    employeeStatus: 'active',
  });
  await seedConsoleUser(store, 'usr_user');
  await seedPlatformAdmin(store);
  await store.createTeam({
    id: 'team_console',
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    createdByUserId: 'usr_owner',
  });
  await seedTeamSite(store, {
    id: 'site_console',
    slug: 'console',
    teamId: 'team_console',
  });
  await store.createDeploymentForIdempotency({
    id: 'dep_failed',
    environment: 'production',
    siteId: 'site_console',
    actorId: 'usr_owner',
    actorUserId: 'usr_owner',
    actorType: 'user',
    source: 'cli',
    operation: 'publish',
    status: 'failed',
    idempotencyKey: 'dashboard-1',
    requestHash: 'hash-dashboard-1',
  });

  const forbidden = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/dashboard', { userId: 'usr_user', admin: false }),
    env(store)
  );
  const dashboard = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/dashboard', { userId: 'usr_root', admin: true }),
    env(store)
  );

  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'PLATFORM_ADMIN_REQUIRED');
  assert.equal(dashboard.status, 200, await dashboard.clone().text());
  assert.deepEqual(await dashboard.json(), {
    dashboard: {
      environment: 'production',
      counts: {
        sites: 1,
        users: 3,
        teams: 1,
        deployments: 1,
        failedDeployments: 1,
      },
      failedDeployments: [
        {
          id: 'dep_failed',
          siteId: 'site_console',
          status: 'failed',
          source: 'cli',
          operation: 'publish',
          createdAt: '2026-07-02T00:00:00.000Z',
        },
      ],
    },
  });
});

test('admin API ignores forged admin headers and uses platform admin grants', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await store.createUser({
    userId: 'usr_root',
    email: 'root@example.com',
    employeeStatus: 'active',
    sessionVersion: 1,
  });

  const forged = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/dashboard', { userId: 'usr_root', admin: true, sessionVersion: 1 }),
    env(store)
  );

  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error.code, 'PLATFORM_ADMIN_REQUIRED');

  await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_root',
    grantedByUserId: 'usr_bootstrap',
    grantReason: 'test',
  });

  const granted = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/dashboard', {
      userId: 'usr_root',
      admin: false,
      sessionVersion: 1,
    }),
    env(store)
  );

  assert.equal(granted.status, 200, await granted.clone().text());
});

test('admin platform grant requires an existing user', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);

  const missing = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/platform-admins', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: {
        userId: 'usr_missing',
        reason: 'bootstrap',
      },
    }),
    env(store)
  );

  assert.equal(missing.status, 404, await missing.clone().text());
  assert.equal((await missing.json()).error.code, 'ADMIN_USER_NOT_FOUND');
  assert.deepEqual(await store.listPlatformAdmins({ environment: 'production' }), [
    {
      environment: 'production',
      userId: 'usr_root',
      grantedByUserId: 'usr_bootstrap',
      grantReason: 'test',
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
  ]);
});

test('admin department team merge transfers assets and writes redacted audit metadata', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const source = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: 'XD/Old/Web',
  });
  const target = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: 'XD/New/Web',
  });
  await store.addTeamMember({
    teamId: source.id,
    userId: 'usr_alice',
    role: 'admin',
    membershipSource: 'department_auto',
    departmentPath: source.departmentPath,
    actorUserId: 'system:xds',
  });
  await store.addTeamMember({
    teamId: target.id,
    userId: 'usr_alice',
    role: 'viewer',
    membershipSource: 'department_auto',
    departmentPath: target.departmentPath,
    actorUserId: 'system:xds',
  });
  await store.removeTeamMember({
    teamId: target.id,
    userId: 'usr_alice',
    actorUserId: 'system:xds',
  });
  await store.addTeamMember({
    teamId: source.id,
    userId: 'usr_manual',
    role: 'viewer',
    membershipSource: 'manual',
    actorUserId: 'usr_root',
  });
  await seedTeamSite(store, {
    id: 'site_old',
    slug: 'old-site',
    teamId: source.id,
  });
  await store.createAccessKey({
    id: 'ak_team',
    ownerType: 'team',
    ownerId: source.id,
    createdByUserId: 'usr_root',
    keyHash: 'secret-hash',
    pepperId: 'pepper_1',
    name: 'deploy',
    scopes: ['deploy:site'],
    siteId: null,
    expiresAt: '2026-10-01T00:00:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/admin/teams/${encodeURIComponent(source.id)}/merge`, {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: {
        targetTeamId: target.id,
        reason: 'department renamed',
      },
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.merge.counts, {
    sites: 1,
    accessKeys: 1,
    departmentMembers: 1,
  });
  assert.equal(body.merge.sourceTeam.status, 'merged');
  assert.equal(body.merge.sourceTeam.mergedIntoTeamId, target.id);
  assert.equal(body.merge.sourceTeam.mergedByUserId, 'usr_root');
  assert.equal(body.merge.sourceTeam.mergeReason, 'department renamed');

  const site = await store.getSite('site_old');
  const key = await store.getAccessKeyById('ak_team');
  const movedMember = await store.getTeamMember({ teamId: target.id, userId: 'usr_alice' });
  const manualMember = await store.getTeamMember({ teamId: target.id, userId: 'usr_manual' });
  const sourceMember = await store.getTeamMember({ teamId: source.id, userId: 'usr_alice', includeRemoved: true });

  assert.equal(site.ownerId, target.id);
  assert.equal(key.ownerId, target.id);
  assert.equal(movedMember.membershipSource, 'department_auto');
  assert.equal(movedMember.departmentPath, target.departmentPath);
  assert.equal(movedMember.removedAt, null);
  assert.equal(movedMember.restoredByUserId, 'usr_root');
  assert.equal(sourceMember.removedAt, '2026-07-02T00:00:00.000Z');
  assert.equal(manualMember, null);

  const auditEvents = await store.listAuditEvents({ environment: 'production' });
  const mergeAudit = auditEvents.find((event) => event.eventType === 'admin.department_team.merge');
  assert.ok(mergeAudit);
  assert.deepEqual(mergeAudit.metadata, {
    sourceTeamId: source.id,
    targetTeamId: target.id,
    counts: {
      sites: 1,
      accessKeys: 1,
      departmentMembers: 1,
    },
  });
  assert.doesNotMatch(JSON.stringify(auditEvents), /usr_alice|usr_manual|secret-hash|pepper_1|deploy/);
});

test('admin sites include readable user and team owner metadata', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createUser({
    userId: 'usr_alice',
    email: 'alice@xd.com',
    realname: 'Alice',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_personal',
    slug: 'alice-home',
    ownerUserId: 'usr_alice',
    ownerType: 'user',
    ownerId: 'usr_alice',
    siteUuid: 'uuid_site_personal',
    defaultVisibility: 'internal',
    environment: 'production',
    routeId: 'route_site_personal',
    hostname: 'alice-home.workers.xd.team',
  });
  const team = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: 'XD/Platform/Web',
  });
  await seedTeamSite(store, {
    id: 'site_team',
    slug: 'team-home',
    teamId: team.id,
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites', { userId: 'usr_root', admin: true }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const personalSite = body.sites.find((site) => site.id === 'site_personal');
  const teamSite = body.sites.find((site) => site.id === 'site_team');

  assert.deepEqual(personalSite.owner, {
    type: 'user',
    id: 'usr_alice',
    email: 'alice@xd.com',
    displayName: 'Alice',
    departmentPath: null,
    teamType: null,
  });
  assert.deepEqual(teamSite.owner, {
    type: 'team',
    id: team.id,
    email: null,
    displayName: team.name,
    departmentPath: 'XD/Platform/Web',
    teamType: 'department',
  });
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ...overrides,
  };
}

function internalConsoleRequest(
  path,
  { userId, email = 'user@example.com', admin = false, sessionVersion, method = 'GET', body } = {}
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
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://pages-api.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedConsoleUser(store, userId, overrides = {}) {
  await store.createUser({
    userId,
    email: `${userId}@example.com`,
    employeeStatus: 'active',
    sessionVersion: 1,
    ...overrides,
  });
}

async function seedPlatformAdmin(store, userId = 'usr_root') {
  await seedConsoleUser(store, userId, { email: 'root@example.com' });
  await store.grantPlatformAdmin({
    environment: 'production',
    userId,
    grantedByUserId: 'usr_bootstrap',
    grantReason: 'test',
  });
}

async function seedTeamSite(store, { id, slug, teamId, visibility = 'internal' }) {
  await store.createSite({
    id,
    slug,
    ownerUserId: 'usr_legacy_owner',
    ownerType: 'team',
    ownerId: teamId,
    siteUuid: `uuid_${id}`,
    defaultVisibility: visibility,
    environment: 'production',
    routeId: `route_${id}`,
    hostname: `${slug}.workers.xd.team`,
  });
}
