import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
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

test('department hydration follows a merged department team to the target team', async () => {
  const store = createTestPagesStore({
    now: (() => {
      const values = ['2026-06-15T00:00:00.000Z', '2026-06-15T00:01:00.000Z', '2026-06-15T00:02:00.000Z'];
      return () => values.shift() || '2026-06-15T00:03:00.000Z';
    })(),
  });

  const source = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: 'XD/Old/Web',
  });
  const target = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: 'XD/New/Web',
  });
  await store.mergeDepartmentTeams({
    sourceTeamId: source.id,
    targetTeamId: target.id,
    actorUserId: 'usr_root',
    reason: 'department renamed',
    environment: 'production',
  });

  const hydrated = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_alice',
    departmentPath: 'XD/Old/Web',
  });

  assert.equal(hydrated.team.id, target.id);
  assert.equal(hydrated.team.status, 'active');
  assert.equal(hydrated.member.teamId, target.id);
  assert.equal(hydrated.member.departmentPath, 'XD/Old/Web');
  assert.equal(hydrated.member.removedAt, null);
  assert.deepEqual(
    (await store.listTeamsForUser({ environment: 'production', userId: 'usr_alice' })).map((team) => team.id),
    [target.id]
  );
});

test('department team id canonicalizes deep XDS paths by business department', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });

  const web = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_web',
    departmentPath: '心动/发行服务/平台支撑部/技术/Web',
  });
  const product = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_product',
    departmentPath: '心动/发行服务/平台支撑部/产品/PM',
  });
  const ops = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_ops',
    departmentPath: '心动/研发服务/平台支撑部/技术/Web',
  });

  assert.notEqual(web.team.id, 'team_department_unknown');
  assert.notEqual(ops.team.id, 'team_department_unknown');
  assert.equal(web.team.id, product.team.id);
  assert.notEqual(web.team.id, ops.team.id);
  assert.equal(web.team.name, '平台支撑部');
  assert.equal(web.team.departmentPath, '心动/发行服务/平台支撑部');
  assert.equal(web.member.departmentPath, '心动/发行服务/平台支撑部/技术/Web');
  assert.equal(product.member.departmentPath, '心动/发行服务/平台支撑部/产品/PM');
  assert.equal(ops.team.departmentPath, '心动/研发服务/平台支撑部');
});

test('department hydration updates full member path without migrating within the same canonical team', async () => {
  const store = createTestPagesStore({
    now: (() => {
      const values = ['2026-06-15T00:00:00.000Z', '2026-06-15T00:01:00.000Z'];
      return () => values.shift() || '2026-06-15T00:02:00.000Z';
    })(),
  });

  const initial = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_member',
    departmentPath: '心动/发行服务/平台支撑部/技术/Web',
  });
  const next = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_member',
    departmentPath: '心动/发行服务/平台支撑部/产品/PM',
  });

  assert.equal(next.team.id, initial.team.id);
  assert.equal(next.team.departmentPath, '心动/发行服务/平台支撑部');
  assert.equal(next.member.departmentPath, '心动/发行服务/平台支撑部/产品/PM');
  assert.equal(next.member.removedAt, null);
  assert.equal(next.restored, false);
  const hasMigrationAudit = (await store.listAuditEvents()).some(
    (event) => event.eventType === 'system.department_membership.migrate'
  );
  assert.equal(hasMigrationAudit, false);
});

test('department hydration merges an existing leaf department team into the canonical team', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const legacy = seedLegacyDepartmentTeam(store, {
    id: 'team_legacy_leaf',
    departmentPath: '心动/发行服务/平台支撑部/技术/Web',
  });
  store.teamMembers.set(`${legacy.id}:usr_member`, {
    teamId: legacy.id,
    userId: 'usr_member',
    role: 'admin',
    membershipSource: 'department_auto',
    departmentPath: legacy.departmentPath,
    roleOverriddenAt: null,
    removedAt: null,
    removedByUserId: null,
    restoredAt: null,
    restoredByUserId: null,
    createdAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
  });
  store.teamMembers.set(`${legacy.id}:usr_other`, {
    teamId: legacy.id,
    userId: 'usr_other',
    role: 'publisher',
    membershipSource: 'department_auto',
    departmentPath: legacy.departmentPath,
    roleOverriddenAt: null,
    removedAt: null,
    removedByUserId: null,
    restoredAt: null,
    restoredByUserId: null,
    createdAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
  });
  await seedTeamSite(store, { id: 'site_legacy', slug: 'legacy', teamId: legacy.id });

  const hydrated = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_member',
    departmentPath: '心动/发行服务/平台支撑部/技术/Web',
  });

  assert.equal(hydrated.team.departmentPath, '心动/发行服务/平台支撑部');
  assert.equal(hydrated.member.teamId, hydrated.team.id);
  assert.equal(hydrated.member.departmentPath, '心动/发行服务/平台支撑部/技术/Web');
  const movedOtherMember = await store.getTeamMember({ teamId: hydrated.team.id, userId: 'usr_other' });
  assert.equal(movedOtherMember.departmentPath, '心动/发行服务/平台支撑部/技术/Web');
  assert.equal((await store.getSite('site_legacy')).ownerId, hydrated.team.id);
  assert.equal(store.teams.get(legacy.id).status, 'merged');
  const mergeAudit = (await store.listAuditEvents()).find((event) => event.eventType === 'admin.department_team.merge');
  assert.equal(mergeAudit?.actorType, 'system');
  assert.equal(mergeAudit?.actorUserId, 'system:xds');
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
  const customTeam = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  await seedTeamSite(store, { id: 'site_console_team', slug: 'console-team', teamId: customTeam.id });
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
    teams.map((team) => [team.name, team.teamType, team.currentUserRole, team.siteCount, team.memberCount]),
    [
      ['Console Team', 'custom', 'admin', 1, 1],
      ['XD/Platform/Web', 'department', 'admin', 0, 1],
    ]
  );
  assert.equal(deleteDepartment.status, 403);
  assert.equal((await deleteDepartment.json()).error.code, 'DEPARTMENT_TEAM_DELETE_FORBIDDEN');
});

test('public teams API lists current user teams for CLI tokens only', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_member', { email: 'member@example.com' });
  const customTeam = await store.createTeam({
    id: 'team_docs',
    environment: 'production',
    teamType: 'custom',
    name: 'Docs Team',
    description: null,
    createdByUserId: 'usr_member',
  });
  await store.addTeamMember({
    teamId: customTeam.id,
    userId: 'usr_member',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const department = await store.hydrateDepartmentMembership({
    environment: 'production',
    userId: 'usr_member',
    departmentPath: '心动/平台支撑部/Web',
  });
  await store.hydrateDepartmentMembership({
    environment: 'staging',
    userId: 'usr_member',
    departmentPath: '心动/平台支撑部/Web',
  });

  const listed = await worker.fetch(apiRequest('/.xd-pages/api/teams'), env(store, {
    verifyCliToken: async () => ({
      sub: 'usr_member',
      purpose: 'cli_token',
      aud: 'pages-cli',
      env: 'production',
      jti: 'cli_member',
    }),
  }));
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.deepEqual(await listed.json(), {
    environment: 'production',
    teams: [
      {
        id: customTeam.id,
        name: 'Docs Team',
        description: null,
        teamType: 'custom',
        departmentPath: null,
        status: 'active',
        currentUserRole: 'publisher',
        currentUserMembershipSource: 'manual',
        siteCount: 0,
        memberCount: 1,
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
      {
        id: department.team.id,
        name: '心动/平台支撑部/Web',
        description: null,
        teamType: 'department',
        departmentPath: '心动/平台支撑部/Web',
        status: 'active',
        currentUserRole: 'admin',
        currentUserMembershipSource: 'department_auto',
        siteCount: 0,
        memberCount: 1,
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
    ],
  });

  const accessKey = await seedAccessKey(store, 'ak_user_team_list', 'usr_member');
  const forbidden = await worker.fetch(
    apiRequest('/.xd-pages/api/teams', {
      Authorization: `Bearer ${accessKey}`,
    }),
    env(store)
  );
  assert.equal(forbidden.status, 403, await forbidden.clone().text());
  assert.equal((await forbidden.json()).error.code, 'TEAM_LIST_FORBIDDEN');
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
  await seedConsoleUser(store, 'usr_admin', { realname: '管理员', email: 'admin@xd.com' });
  await seedConsoleUser(store, 'usr_viewer', { realname: '成员用户', email: 'viewer@xd.com' });
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
    user: {
      id: 'usr_viewer',
      email: 'viewer@xd.com',
      realname: '成员用户',
      account: null,
      departmentPath: null,
      employeeStatus: 'active',
    },
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

test('team member list includes user profile summary', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin', { realname: '管理员', email: 'admin@xd.com' });
  await seedConsoleUser(store, 'usr_viewer', {
    realname: '徐天麒',
    email: 'xutianqi@xd.com',
    account: 'xutianqi',
    departmentPath: 'XD/Platform',
  });
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

  const response = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/teams/${team.id}/members`, { userId: 'usr_admin' }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const viewer = body.members.find((member) => member.userId === 'usr_viewer');
  assert.deepEqual(viewer.user, {
    id: 'usr_viewer',
    email: 'xutianqi@xd.com',
    realname: '徐天麒',
    account: 'xutianqi',
    departmentPath: 'XD/Platform',
    employeeStatus: 'active',
  });
});

test('console user search returns persisted users for team member picker', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin', { realname: '管理员', email: 'admin@xd.com' });
  await seedConsoleUser(store, 'usr_xutianqi', { realname: '徐天麒', email: 'xutianqi@xd.com', account: 'xutianqi' });
  await seedConsoleUser(store, 'usr_other', { realname: '其他用户', email: 'other@xd.com', account: 'other' });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/users?query=xutian', { userId: 'usr_admin' }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    users: [
      {
        id: 'usr_xutianqi',
        email: 'xutianqi@xd.com',
        realname: '徐天麒',
        account: 'xutianqi',
        departmentPath: null,
        employeeStatus: 'active',
      },
    ],
  });
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

test('team member APIs preserve the final custom team admin', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin');
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });

  const demote = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/members/usr_admin`, {
      userId: 'usr_admin',
      method: 'PATCH',
      body: { role: 'publisher' },
    }),
    env(store)
  );
  const remove = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/teams/${team.id}/members/usr_admin`, {
      userId: 'usr_admin',
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(demote.status, 409, await demote.clone().text());
  assert.equal((await demote.json()).error.code, 'TEAM_LAST_ADMIN');
  assert.equal(remove.status, 409, await remove.clone().text());
  assert.equal((await remove.json()).error.code, 'TEAM_LAST_ADMIN');
  assert.equal((await store.getTeamMember({ teamId: team.id, userId: 'usr_admin' })).role, 'admin');
});

test('team member APIs do not count inactive users as another admin', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin');
  await seedConsoleUser(store, 'usr_inactive', { employeeStatus: 'disabled' });
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_inactive',
    role: 'admin',
    membershipSource: 'manual',
    actorUserId: 'usr_admin',
  });

  const demote = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/members/usr_admin`, {
      userId: 'usr_admin',
      method: 'PATCH',
      body: { role: 'publisher' },
    }),
    env(store)
  );
  const remove = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/teams/${team.id}/members/usr_admin`, {
      userId: 'usr_admin',
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(demote.status, 409, await demote.clone().text());
  assert.equal((await demote.json()).error.code, 'TEAM_LAST_ADMIN');
  assert.equal(remove.status, 409, await remove.clone().text());
  assert.equal((await remove.json()).error.code, 'TEAM_LAST_ADMIN');
  assert.equal((await store.getTeamMember({ teamId: team.id, userId: 'usr_admin' })).role, 'admin');
});

test('team member APIs reject deleted teams even when membership still exists', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin');
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    description: null,
    createdByUserId: 'usr_admin',
  });
  const originalGetTeam = store.getTeam.bind(store);
  store.getTeam = async (teamId) => {
    const record = await originalGetTeam(teamId);
    return record ? { ...record, deletedAt: '2026-06-15T00:00:00.000Z' } : null;
  };

  const response = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/teams/${team.id}/members`, { userId: 'usr_admin' }),
    env(store)
  );

  assert.equal(response.status, 404, await response.clone().text());
  assert.equal((await response.json()).error.code, 'TEAM_NOT_FOUND');
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    ...overrides,
  };
}

function apiRequest(path, headers = {}) {
  return new Request(`https://api.pages.xd.team${path}`, {
    headers: {
      Authorization: 'Bearer cli-token',
      'CF-Connecting-IP': '10.1.2.3',
      ...headers,
    },
  });
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

async function seedAccessKey(store, keyId, ownerUserId) {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId,
    bytes: new Uint8Array(24).fill(7),
  });
  await store.createAccessKey({
    id: keyId,
    environment: 'production',
    ownerUserId,
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes: ['read:site'],
    siteId: null,
    expiresAt: '2026-07-15T00:00:00.000Z',
  });
  return plaintext;
}

function seedLegacyDepartmentTeam(store, { id, departmentPath }) {
  const now = '2026-06-14T00:00:00.000Z';
  const team = {
    id,
    environment: 'production',
    name: departmentPath,
    description: null,
    teamType: 'department',
    departmentPath,
    status: 'active',
    createdByType: 'system',
    createdByUserId: null,
    mergedIntoTeamId: null,
    mergedAt: null,
    mergedByUserId: null,
    mergeReason: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.teams.set(team.id, team);
  return team;
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
