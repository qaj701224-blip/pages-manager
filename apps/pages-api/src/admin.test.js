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
        users: 1,
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

test('admin department team merge transfers assets and writes redacted audit metadata', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
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

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ...overrides,
  };
}

function internalConsoleRequest(path, { userId, email = 'user@example.com', admin = false, method = 'GET', body } = {}) {
  const headers = {
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
  };
  if (userId) {
    headers['X-Console-User-Id'] = userId;
    headers['X-Console-Email'] = email;
    headers['X-Console-Admin'] = admin ? 'true' : 'false';
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://pages-api.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
