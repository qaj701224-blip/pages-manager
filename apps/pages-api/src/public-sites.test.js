import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTestPagesStore,
  insertTestRoute,
  updateTestRoute,
  updateTestSite,
  updateTestTeam,
} from '../test-support/pages-store-fixture.js';

const ENVIRONMENT = 'production';
const CREATED_AT = '2026-08-01T00:00:00.000Z';
const ROUTE_UPDATED_AT = '2026-08-02T00:00:00.000Z';

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

function testStore() {
  return createTestPagesStore({ now: () => CREATED_AT });
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
