import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('department hydration creates department team and default admin member', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

  const result = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Platform/Web',
  });

  assert.equal(result.team.teamType, 'department');
  assert.equal(result.team.departmentPath, 'XD/Platform/Web');
  assert.equal(result.member.role, 'admin');
  assert.equal(result.member.membershipSource, 'department_auto');
  assert.equal(result.member.departmentPath, 'XD/Platform/Web');
  assert.equal(result.member.removedAt, null);

  const teams = await store.listTeamsForUser({ environment: 'production', userId: 'usr_alice' });
  assert.deepEqual(
    teams.map((team) => ({
      id: team.id,
      teamType: team.teamType,
      role: team.currentUserRole,
      membershipSource: team.currentUserMembershipSource,
    })),
    [
      {
        id: result.team.id,
        teamType: 'department',
        role: 'admin',
        membershipSource: 'department_auto',
      },
    ]
  );

  const auditEvents = await store.listAuditEvents();
  assert.deepEqual(
    auditEvents.map((event) => ({
      eventType: event.eventType,
      actorType: event.actorType,
      actorUserId: event.actorUserId,
      metadata: event.metadata,
    })),
    [
      {
        eventType: 'system.department_team.create',
        actorType: 'system',
        actorUserId: 'system:xds',
        metadata: {
          environment: 'production',
          teamId: result.team.id,
          departmentPath: 'XD/Platform/Web',
        },
      },
      {
        eventType: 'system.department_membership.join',
        actorType: 'system',
        actorUserId: 'system:xds',
        metadata: {
          environment: 'production',
          userId: 'usr_alice',
          teamId: result.team.id,
          departmentPath: 'XD/Platform/Web',
        },
      },
    ]
  );
});

test('removed department auto member is not restored by same-department hydration', async () => {
  const store = createTestPagesStore({
    now: (() => {
      const values = ['2026-06-15T00:00:00.000Z', '2026-06-15T00:01:00.000Z', '2026-06-15T00:02:00.000Z'];
      return () => values.shift() || '2026-06-15T00:03:00.000Z';
    })(),
  });

  const initial = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Platform/Web',
  });
  await store.removeTeamMember({
    teamId: initial.team.id,
    userId: 'usr_alice',
    actorUserId: 'usr_admin',
  });

  const hydrated = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Platform/Web',
  });

  assert.equal(hydrated.member.removedAt, '2026-06-15T00:01:00.000Z');
  assert.equal(hydrated.member.removedByUserId, 'usr_admin');
  assert.equal(hydrated.restored, false);
  assert.deepEqual(await store.listTeamsForUser({ environment: 'production', userId: 'usr_alice' }), []);
});

test('same-department hydration restores a membership previously removed by XDS migration', async () => {
  const store = createTestPagesStore({
    now: (() => {
      const values = [
        '2026-06-15T00:00:00.000Z',
        '2026-06-15T00:01:00.000Z',
        '2026-06-15T00:02:00.000Z',
        '2026-06-15T00:03:00.000Z',
      ];
      return () => values.shift() || '2026-06-15T00:04:00.000Z';
    })(),
  });

  const oldDepartment = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Web',
  });
  await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Platform',
  });

  const restored = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Web',
  });

  assert.equal(restored.team.id, oldDepartment.team.id);
  assert.equal(restored.member.removedAt, null);
  assert.equal(restored.member.removedByUserId, null);
  assert.equal(restored.member.restoredAt, '2026-06-15T00:02:00.000Z');
  assert.equal(restored.member.restoredByUserId, 'system:xds');
  assert.equal(restored.restored, true);
  assert.deepEqual(
    (await store.listTeamsForUser({ environment: 'production', userId: 'usr_alice' })).map((team) => team.departmentPath),
    ['XD/Web']
  );
});

test('department path change moves department_auto membership immediately', async () => {
  const store = createTestPagesStore({
    now: (() => {
      const values = ['2026-06-15T00:00:00.000Z', '2026-06-15T00:01:00.000Z', '2026-06-15T00:02:00.000Z'];
      return () => values.shift() || '2026-06-15T00:03:00.000Z';
    })(),
  });

  const oldDepartment = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Web',
  });
  const nextDepartment = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Platform',
  });

  const oldMember = await store.getTeamMember({
    teamId: oldDepartment.team.id,
    userId: 'usr_alice',
    includeRemoved: true,
  });
  const nextMember = await store.getTeamMember({
    teamId: nextDepartment.team.id,
    userId: 'usr_alice',
  });

  assert.equal(oldMember.removedAt, '2026-06-15T00:01:00.000Z');
  assert.equal(oldMember.removedByUserId, 'system:xds');
  assert.equal(nextMember.role, 'admin');
  assert.equal(nextMember.removedAt, null);
  assert.deepEqual(
    (await store.listTeamsForUser({ environment: 'production', userId: 'usr_alice' })).map((team) => team.departmentPath),
    ['XD/Platform']
  );
  const migrationAudit = (await store.listAuditEvents()).find(
    (event) => event.eventType === 'system.department_membership.migrate'
  );
  assert.deepEqual(migrationAudit?.metadata, {
    environment: 'production',
    userId: 'usr_alice',
    oldTeamId: oldDepartment.team.id,
    newTeamId: nextDepartment.team.id,
    oldDepartmentPath: 'XD/Web',
    newDepartmentPath: 'XD/Platform',
  });
});

test('department team id remains stable and distinct for Chinese department paths', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

  const web = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_web',
    departmentPath: '心动/发行服务/平台支撑部/技术/Web',
  });
  const ops = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_ops',
    departmentPath: '心动/研发服务/平台支撑部/技术/Web',
  });

  assert.notEqual(web.team.id, 'team_department_unknown');
  assert.notEqual(ops.team.id, 'team_department_unknown');
  assert.notEqual(web.team.id, ops.team.id);
  assert.equal(web.team.departmentPath, '心动/发行服务/平台支撑部/技术/Web');
});

test('department team ids are scoped by environment and do not collide on ASCII separators', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

  const production = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_prod',
    departmentPath: 'XD/Platform/Web',
  });
  const staging = await store.hydrateDepartmentMembership({
    environment: 'staging',
    userId: 'usr_staging',
    departmentPath: 'XD/Platform/Web',
  });
  const underscore = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_underscore',
    departmentPath: 'XD/Platform_Web',
  });

  assert.notEqual(production.team.id, staging.team.id);
  assert.notEqual(production.team.id, underscore.team.id);
});

test('custom team deletion is blocked until team sites and active keys are cleared', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: 'Owners of console sites',
    createdByUserId: 'usr_admin',
  });

  await seedTeamSite(store, {
    id: 'site_team',
    slug: 'team-site',
    teamId: team.id,
  });

  await assert.rejects(store.deleteCustomTeam({ teamId: team.id, actorUserId: 'usr_admin' }), /TEAM_HAS_BLOCKING_ASSETS/);

  await store.deleteSite('site_team', {}, 'production');
  await store.createAccessKey({
    id: 'ak_team',
    ownerType: 'team',
    ownerId: team.id,
    createdByUserId: 'usr_admin',
    keyHash: 'hash',
    pepperId: 'pepper_1',
    name: 'team key',
    scopes: ['deploy:site'],
    siteId: null,
    expiresAt: '2026-07-15T00:00:00.000Z',
  });

  await assert.rejects(store.deleteCustomTeam({ teamId: team.id, actorUserId: 'usr_admin' }), /TEAM_HAS_BLOCKING_ASSETS/);

  await store.revokeAccessKey('ak_team', '2026-06-15T00:30:00.000Z');
  const deleted = await store.deleteCustomTeam({ teamId: team.id, actorUserId: 'usr_admin' });

  assert.equal(deleted.id, team.id);
  assert.equal(await store.getTeam(team.id), null);
  const deleteAudit = (await store.listAuditEvents()).find((event) => event.eventType === 'team.delete');
  assert.ok(deleteAudit);
  assert.equal(deleteAudit.actorUserId, 'usr_admin');
  assert.deepEqual(deleteAudit.metadata, {
    environment: 'production',
    teamId: team.id,
    teamName: 'Console Team',
    teamType: 'custom',
    blockingAssets: {
      sites: 0,
      accessKeys: 0,
    },
  });
});

test('team APIs list teams and block department team deletion', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin');
  await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_admin',
    departmentPath: 'XD/Platform/Web',
  });

  const list = await worker.fetch(internalConsoleRequest('/.xd-pages/api/console/teams', { userId: 'usr_admin' }), env(store));
  assert.equal(list.status, 200, await list.clone().text());
  const teams = (await list.json()).teams;
  const departmentTeam = teams.find((team) => team.teamType === 'department');
  const deleteDepartment = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/teams/${encodeURIComponent(departmentTeam.id)}`, {
      userId: 'usr_admin',
      method: 'DELETE',
    }),
    env(store)
  );

  assert.deepEqual(
    teams.map((team) => [team.name, team.teamType, team.currentUserRole]),
    [
      ['Console Team', 'custom', 'admin'],
      ['XD/Platform/Web', 'department', 'admin'],
    ]
  );
  assert.equal(deleteDepartment.status, 403);
  assert.equal((await deleteDepartment.json()).error.code, 'DEPARTMENT_TEAM_DELETE_FORBIDDEN');
});

test('team API creates custom team with current user as admin', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin');

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/teams', {
      userId: 'usr_admin',
      body: {
        name: 'Console Team',
        description: 'Console owners',
      },
    }),
    env(store)
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.team.name, 'Console Team');
  assert.equal(body.team.description, 'Console owners');
  assert.equal(body.team.teamType, 'custom');
  assert.equal(body.team.currentUserRole, 'admin');

  const member = await store.getTeamMember({ teamId: body.team.id, userId: 'usr_admin' });
  assert.equal(member.role, 'admin');
  assert.equal(member.membershipSource, 'manual');
});

test('team member APIs require team admin and update roles', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUsers(store, ['usr_admin', 'usr_viewer']);
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_viewer',
    role: 'viewer',
    membershipSource: 'manual',
    actorUserId: 'usr_admin',
  });

  const forbidden = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/members/usr_viewer`, {
      userId: 'usr_viewer',
      method: 'PATCH',
      body: { role: 'publisher' },
    }),
    env(store)
  );
  const updated = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/members/usr_viewer`, {
      userId: 'usr_admin',
      method: 'PATCH',
      body: { role: 'publisher' },
    }),
    env(store)
  );
  const removed = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/teams/${team.id}/members/usr_viewer`, {
      userId: 'usr_admin',
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'TEAM_ADMIN_REQUIRED');
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.deepEqual((await updated.json()).member, {
    teamId: team.id,
    userId: 'usr_viewer',
    role: 'publisher',
    membershipSource: 'manual',
    departmentPath: null,
    removedAt: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  assert.equal(removed.status, 200, await removed.clone().text());
  const removedBody = await removed.json();
  assert.equal(removedBody.member.userId, 'usr_viewer');
  assert.equal(removedBody.member.removedAt, '2026-06-15T00:00:00.000Z');
});

test('team member APIs decode user ids captured from the path', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUsers(store, ['usr_admin']);
  await seedConsoleUser(store, 'alice@example.com', { email: 'alice@example.com' });
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  const encodedUserId = encodeURIComponent('alice@example.com');

  const updated = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/members/${encodedUserId}`, {
      userId: 'usr_admin',
      method: 'PATCH',
      body: { role: 'publisher' },
    }),
    env(store)
  );
  const removed = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/teams/${team.id}/members/${encodedUserId}`, {
      userId: 'usr_admin',
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await updated.json()).member.userId, 'alice@example.com');
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await removed.json()).member.userId, 'alice@example.com');
  assert.equal(await store.getTeamMember({ teamId: team.id, userId: encodedUserId }), null);
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ...overrides,
  };
}

function internalConsoleRequest(path, { userId, email = 'user@example.com', admin = false, method = 'GET' } = {}) {
  const headers = {
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
  };
  if (userId) {
    headers['X-Console-User-Id'] = userId;
    headers['X-Console-Email'] = email;
    headers['X-Console-Admin'] = admin ? 'true' : 'false';
  }
  return new Request(`https://pages-api.internal${path}`, { method, headers });
}

function internalConsoleJsonRequest(path, { userId, email, admin, method = 'POST', body } = {}) {
  return new Request(`https://pages-api.internal${path}`, {
    method,
    headers: {
      Host: 'pages-api.internal',
      'Content-Type': 'application/json',
      'X-Console-BFF': 'pages-console',
      ...(userId
        ? {
            'X-Console-User-Id': userId,
            'X-Console-Email': email || 'user@example.com',
            'X-Console-Admin': admin ? 'true' : 'false',
          }
        : {}),
    },
    body: JSON.stringify(body || {}),
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
