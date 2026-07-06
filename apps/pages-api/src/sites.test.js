import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('creates a production site with owner membership and inactive route', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'guide',
      visibility: 'org',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.site.id, 'site_1');
  assert.equal(body.site.slug, 'guide');
  assert.equal(body.site.url, 'https://guide.workers.xd.team');
  assert.equal(body.site.defaultVisibility, 'org');
  assert.equal('token' in body.site, false);

  assert.equal((await store.getRouteBySiteId('site_1')).hostname, 'guide.workers.xd.team');
  assert.equal((await store.getRouteBySiteId('site_1')).routeStatus, 'disabled');
  assert.equal((await store.getSite('site_1')).siteUuid, '4b4c8e8361ef4b47b64f5c20a7db7c47');
  assert.equal((await store.listSiteMembers('site_1'))[0].role, 'owner');
});

test('create site returns conflict when hostname claim belongs to another owner', async () => {
  const store = await createSeededStore();
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'guide.pages.xd.team',
    normalizedSlug: 'guide',
    hostnameFamily: 'pages',
    ownerSystem: 'v1',
    ownerId: 'v1:production:guide',
    ownerRef: 'pages-guide',
    source: 'backfill_v1_sites',
  });

  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'guide',
      visibility: 'org',
    }),
    testEnv(store)
  );

  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.match(body.error.action, /换一个站点名|原站点/);
  assert.equal(await store.getSite('site_1'), null);
});

test('creates a site with internal visibility', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'guide',
      visibility: 'internal',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.site.defaultVisibility, 'internal');
  assert.equal(body.site.route.visibility, 'internal');
});

test('creates a team-owned site when the user is a team publisher', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_publisher',
    email: 'publisher@example.com',
    employeeStatus: 'active',
  });
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
  });

  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'team-guide',
      visibility: 'internal',
      ownerType: 'team',
      teamId: team.id,
    }),
    testEnv(store, {
      verifyCliToken: async () => ({
        sub: 'usr_publisher',
        purpose: 'cli_token',
        aud: 'pages-cli',
        env: 'production',
        jti: 'cli_publisher',
      }),
    })
  );

  assert.equal(response.status, 201, await response.clone().text());
  const site = await store.getSite('site_1');
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, team.id);
  assert.equal(site.ownerUserId, 'usr_publisher');
  assert.equal(site.defaultVisibility, 'internal');
});

test('rejects team-owned site creation when the user is only a team viewer', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'viewer',
    membershipSource: 'manual',
  });

  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'team-guide',
      visibility: 'org',
      ownerType: 'team',
      teamId: team.id,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'TEAM_PUBLISHER_REQUIRED');
  assert.equal(await store.getSite('site_1'), null);
});

test('lists only sites visible to the authenticated actor', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_2',
    email: 'other@example.com',
    realname: 'Other User',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_1',
    slug: 'mine',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'mine.pages.xd.team',
  });
  await store.createSite({
    id: 'site_2',
    slug: 'other',
    ownerUserId: 'usr_2',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other.pages.xd.team',
  });

  const response = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites'), testEnv(store));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.sites.map((site) => site.slug),
    ['mine']
  );
  assert.equal('token' in body.sites[0], false);
});

test('filters sites by the active API environment', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_prod',
    slug: 'prod',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_prod',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_prod',
    hostname: 'prod.pages.xd.team',
  });
  await store.createSite({
    id: 'site_staging',
    slug: 'staging',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_staging',
    defaultVisibility: 'org',
    environment: 'staging',
    routeId: 'route_staging',
    hostname: 'staging-staging.pages.xd.team',
  });

  const list = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites'), testEnv(store));
  const getStagingFromProduction = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_staging'),
    testEnv(store)
  );

  assert.deepEqual(
    (await list.json()).sites.map((site) => site.id),
    ['site_prod']
  );
  assert.equal(getStagingFromProduction.status, 404);
});

test('gets a site by id for members and hides unknown sites', async () => {
  const store = await createSeededStore();
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

  const found = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1'), testEnv(store));
  const missing = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_missing'), testEnv(store));

  assert.equal(found.status, 200);
  assert.equal((await found.json()).site.slug, 'guide');
  assert.equal(missing.status, 404);
});

test('deletes owned site by soft-deleting site and holding hostname claim for reuse protection', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.workers.xd.team',
  });

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {}, { method: 'DELETE' }),
    testEnv(store, { now: () => '2026-06-15T00:00:00.000Z' })
  );
  const getAfterDelete = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1'), testEnv(store));
  const listAfterDelete = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites'), testEnv(store));
  const claim = await store.getHostnameClaim('guide.workers.xd.team');

  assert.equal(response.status, 200);
  assert.equal((await response.json()).site.deletedAt, '2026-06-15T00:00:00.000Z');
  assert.equal(getAfterDelete.status, 404);
  assert.deepEqual((await listAfterDelete.json()).sites, []);
  assert.equal((await store.getSite('site_1')).deletedAt, '2026-06-15T00:00:00.000Z');
  assert.equal((await store.getRouteBySiteId('site_1')).routeStatus, 'deleted');
  assert.equal(claim.status, 'held');
  assert.equal(claim.releaseReason, 'site_deleted');
  assert.equal(claim.reuseHoldUntil, '2026-06-15T00:05:00.000Z');
});

test('site delete rejects read-only access keys and non-owner members', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_2',
    email: 'member@example.com',
    realname: 'Member User',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.workers.xd.team',
  });
  await store.addSiteMember({
    siteId: 'site_1',
    userId: 'usr_2',
    role: 'viewer',
    createdBy: 'usr_1',
    createdAt: '2026-06-15T00:00:00.000Z',
  });
  const readKey = await seedAccessKey(store, 'ak_read', ['read:site'], 'site_1');

  const memberDelete = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {}, { method: 'DELETE' }),
    testEnv(store, {
      verifyCliToken: async () => ({
        sub: 'usr_2',
        purpose: 'cli_token',
        aud: 'pages-cli',
        env: 'production',
        jti: 'cli_2',
      }),
    })
  );
  const accessKeyDelete = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {
      Authorization: `Bearer ${readKey}`,
    }, { method: 'DELETE' }),
    testEnv(store)
  );

  assert.equal(memberDelete.status, 403);
  assert.equal((await memberDelete.json()).error.code, 'SITE_POLICY_FORBIDDEN');
  assert.equal(accessKeyDelete.status, 403);
  assert.equal((await accessKeyDelete.json()).error.code, 'SITE_POLICY_FORBIDDEN');
  assert.equal((await store.getSite('site_1')).deletedAt, null);
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).status, 'active');
});

test('team site creator cannot manage policy after losing team admin role', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'viewer',
    membershipSource: 'manual',
    actorUserId: 'usr_1',
  });
  await store.createSite({
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });

  const update = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_team', { visibility: 'disabled' }),
    testEnv(store)
  );
  const del = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_team', {}, { method: 'DELETE' }),
    testEnv(store)
  );

  assert.equal(update.status, 403, await update.clone().text());
  assert.equal((await update.json()).error.code, 'SITE_POLICY_FORBIDDEN');
  assert.equal(del.status, 403, await del.clone().text());
  assert.equal((await del.json()).error.code, 'SITE_POLICY_FORBIDDEN');
  assert.equal((await store.getSite('site_team')).defaultVisibility, 'org');
  assert.equal((await store.getSite('site_team')).deletedAt, null);
});

test('team publisher can manage team site policy and delete team sites', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_publisher',
    email: 'publisher@example.com',
    employeeStatus: 'active',
  });
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
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
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });

  const env = testEnv(store, {
    verifyCliToken: async () => ({
      sub: 'usr_publisher',
      purpose: 'cli_token',
      aud: 'pages-cli',
      env: 'production',
      jti: 'cli_publisher',
    }),
  });
  const update = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_team', { visibility: 'disabled' }),
    env
  );
  const del = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_team', {}, { method: 'DELETE' }),
    env
  );

  assert.equal(update.status, 200, await update.clone().text());
  assert.equal((await update.json()).site.route.visibility, 'disabled');
  assert.equal(del.status, 200, await del.clone().text());
  assert.equal((await store.getSite('site_team')).deletedAt, '2026-06-15T00:00:00.000Z');
});

test('personal access token can transfer a managed team site to the token user', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_creator',
    email: 'creator@example.com',
    employeeStatus: 'active',
  });
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  await store.createSite({
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_creator',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });
  const key = await seedAccessKey(store, 'ak_publish', ['deploy:site'], null);

  const response = await worker.fetch(
    jsonMethodRequest('POST', 'https://api.pages.xd.team/.xd-pages/api/sites/site_team/transfer', {
      ownerType: 'user',
      ownerId: 'usr_1',
    }, { Authorization: `Bearer ${key}` }),
    testEnv(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.site.owner.type, 'user');
  assert.equal((await store.getSite('site_team')).ownerType, 'user');
  assert.equal((await store.getSite('site_team')).ownerId, 'usr_1');
  assert.equal((await store.getSite('site_team')).ownerUserId, 'usr_1');
  assert.equal(
    await store.getSiteForUser('site_team', 'usr_creator', { type: 'user', userId: 'usr_creator' }, 'production'),
    null
  );
});

test('personal access token can transfer a personal site to a team when the user is a team publisher', async () => {
  const store = await createSeededStore();
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
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const key = await seedAccessKey(store, 'ak_publish_team_transfer', ['deploy:site'], null);

  const response = await worker.fetch(
    jsonMethodRequest(
      'POST',
      'https://api.pages.xd.team/.xd-pages/api/sites/site_1/transfer',
      {
        ownerType: 'team',
        teamId: team.id,
      },
      { Authorization: `Bearer ${key}` }
    ),
    testEnv(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.site.owner.type, 'team');
  assert.equal((await store.getSite('site_1')).ownerType, 'team');
  assert.equal((await store.getSite('site_1')).ownerId, team.id);
  assert.equal((await store.getSite('site_1')).ownerUserId, 'usr_1');
  const transferEvents = (await store.listAuditEvents()).filter((event) => event.eventType === 'site.owner.transfer');
  assert.equal(transferEvents.length, 1);
  assert.deepEqual(transferEvents[0].metadata, {
    siteSlug: 'guide',
    fromOwner: { type: 'user', id: 'usr_1' },
    toOwner: { type: 'team', id: team.id },
    source: 'api',
  });
});

test('team access token cannot transfer a team site to a personal owner', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.createSite({
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });
  const key = await seedAccessKey(store, 'ak_team', ['deploy:site'], null, {
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
  });

  const response = await worker.fetch(
    jsonMethodRequest('POST', 'https://api.pages.xd.team/.xd-pages/api/sites/site_team/transfer', {
      ownerType: 'user',
      ownerId: 'usr_1',
    }, { Authorization: `Bearer ${key}` }),
    testEnv(store)
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_TRANSFER_FORBIDDEN');
  assert.equal((await store.getSite('site_team')).ownerType, 'team');
});

test('requires read:site scope for access key site reads', async () => {
  const store = await createSeededStore();
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
  const deployOnlyKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const readKey = await seedAccessKey(store, 'ak_read', ['read:site']);

  const deniedList = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      Authorization: `Bearer ${deployOnlyKey}`,
    }),
    testEnv(store)
  );
  const deniedGet = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {
      Authorization: `Bearer ${deployOnlyKey}`,
    }),
    testEnv(store)
  );
  const allowedGet = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {
      Authorization: `Bearer ${readKey}`,
    }),
    testEnv(store)
  );

  assert.equal(deniedList.status, 403);
  assert.equal((await deniedList.json()).error.code, 'SITE_READ_FORBIDDEN');
  assert.equal(deniedGet.status, 403);
  assert.equal((await deniedGet.json()).error.code, 'SITE_READ_FORBIDDEN');
  assert.equal(allowedGet.status, 200);
  assert.equal((await allowedGet.json()).site.id, 'site_1');
});

test('updates site visibility and bumps policy version for active routes', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'disabled' }),
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.site.defaultVisibility, 'disabled');
  assert.equal(body.site.route.policyVersion, 2);
  assert.equal(body.site.route.visibility, 'disabled');
  assert.equal((await store.getRouteBySiteId('site_1')).cacheTier, 'strict');
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team').policyVersion, 2);
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team').routeGeneration, 1);
});

test('rolls back visibility changes when active route snapshot write fails', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'disabled' }),
    testEnv(store, { ROUTE_SNAPSHOTS: failingSnapshotStore() })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal((await store.getSite('site_1')).defaultVisibility, 'org');
  assert.equal((await store.getRouteBySiteId('site_1')).visibility, 'org');
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 1);
});

test('rolls back visibility changes when snapshot write fails after runtime config changes', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'disabled' }),
    testEnv(store, {
      ROUTE_SNAPSHOTS: {
        put: async () => {
          await store.putSiteSecret({
            id: 'sec_1',
            environment: 'production',
            siteId: 'site_1',
            name: 'API_TOKEN',
            value: 'changed-during-policy-update',
            actorId: 'usr_1',
            updatedAt: '2026-06-15T00:00:02.000Z',
          });
          throw new Error('snapshot write failed');
        },
      },
    })
  );
  const route = await store.getRouteBySiteId('site_1', 'production');

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal((await store.getSite('site_1')).defaultVisibility, 'org');
  assert.equal(route.visibility, 'org');
  assert.equal(route.policyVersion, previousRoute.policyVersion);
  assert.equal(route.runtimeConfigGeneration, previousRoute.runtimeConfigGeneration + 1);
});

test('secrets put updates current active WFP worker without changing active route', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');
  const providerCalls = [];

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
      value: 'secret-value',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        putSecret: async (input) => providerCalls.push(input),
      },
    })
  );

  const route = await store.getRouteBySiteId('site_1', 'production');
  assert.equal(response.status, 200);
  assert.deepEqual(providerCalls, [
    {
      workerName: 'pages-v2-guide-ver-1',
      name: 'API_TOKEN',
      value: 'secret-value',
    },
  ]);
  assert.equal(route.activeVersionId, previousRoute.activeVersionId);
  assert.equal(route.workerName, previousRoute.workerName);
  assert.equal(route.routeGeneration, previousRoute.routeGeneration);
  assert.equal(route.runtimeConfigGeneration, previousRoute.runtimeConfigGeneration + 1);
});

test('team publishers can manage runtime secrets for team-owned sites', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_publisher',
    email: 'publisher@example.com',
    employeeStatus: 'active',
  });
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const site = await store.createSite({
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });
  await activateSite(store, site.id, { workerName: 'pages-v2-team-guide-ver-1' });
  const providerCalls = [];
  const publisherEnv = testEnv(store, {
    WFP_PROVIDER: {
      putSecret: async (input) => providerCalls.push({ operation: 'put', ...input }),
      deleteSecret: async (input) => providerCalls.push({ operation: 'delete', ...input }),
    },
    verifyCliToken: async () => ({
      sub: 'usr_publisher',
      purpose: 'cli_token',
      aud: 'pages-cli',
      env: 'production',
      jti: 'cli_publisher',
    }),
  });

  const put = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/team-guide/secrets', {
      name: 'API_TOKEN',
      value: 'secret-value',
    }),
    publisherEnv
  );
  const del = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/team-guide/secrets', {
      name: 'API_TOKEN',
    }),
    publisherEnv
  );

  assert.equal(put.status, 200, await put.clone().text());
  assert.deepEqual(await put.json(), { secret: { site: 'team-guide', name: 'API_TOKEN', updated: true, deleted: false } });
  assert.equal(del.status, 200, await del.clone().text());
  assert.deepEqual(await del.json(), { secret: { site: 'team-guide', name: 'API_TOKEN', updated: false, deleted: true } });
  assert.deepEqual(providerCalls, [
    {
      operation: 'put',
      workerName: 'pages-v2-team-guide-ver-1',
      name: 'API_TOKEN',
      value: 'secret-value',
    },
    {
      operation: 'delete',
      workerName: 'pages-v2-team-guide-ver-1',
      name: 'API_TOKEN',
    },
  ]);
});

test('team admins can manage runtime secrets for team-owned sites', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  const site = await store.createSite({
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });
  await activateSite(store, site.id, { workerName: 'pages-v2-team-guide-ver-1' });
  const providerCalls = [];
  const adminEnv = testEnv(store, {
    WFP_PROVIDER: {
      putSecret: async (input) => providerCalls.push({ operation: 'put', ...input }),
      deleteSecret: async (input) => providerCalls.push({ operation: 'delete', ...input }),
    },
  });

  const put = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/team-guide/secrets', {
      name: 'API_TOKEN',
      value: 'secret-value',
    }),
    adminEnv
  );
  const del = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/team-guide/secrets', {
      name: 'API_TOKEN',
    }),
    adminEnv
  );

  assert.equal(put.status, 200, await put.clone().text());
  assert.equal(del.status, 200, await del.clone().text());
  assert.deepEqual(providerCalls, [
    {
      operation: 'put',
      workerName: 'pages-v2-team-guide-ver-1',
      name: 'API_TOKEN',
      value: 'secret-value',
    },
    {
      operation: 'delete',
      workerName: 'pages-v2-team-guide-ver-1',
      name: 'API_TOKEN',
    },
  ]);
});

test('secrets put skips active worker sync for assets-only active versions', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id, {
    deploymentShape: 'assets-only',
    routingMode: 'assets-only',
    resolvedFallback: 'index',
  });
  const providerCalls = [];

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
      value: 'secret-value',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        putSecret: async (input) => providerCalls.push(input),
      },
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(providerCalls, []);
});

test('secrets delete removes secret from current active WFP worker', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'old-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');
  const providerCalls = [];

  const response = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        deleteSecret: async (input) => providerCalls.push(input),
      },
    })
  );

  const route = await store.getRouteBySiteId('site_1', 'production');
  assert.equal(response.status, 200);
  assert.deepEqual(providerCalls, [
    {
      workerName: 'pages-v2-guide-ver-1',
      name: 'API_TOKEN',
    },
  ]);
  assert.equal(route.activeVersionId, previousRoute.activeVersionId);
  assert.equal(route.workerName, previousRoute.workerName);
  assert.equal(route.routeGeneration, previousRoute.routeGeneration);
  assert.equal(route.runtimeConfigGeneration, previousRoute.runtimeConfigGeneration + 1);
});

test('secrets delete still cleans active worker when the store secret is already absent', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);
  const providerCalls = [];

  const response = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        deleteSecret: async (input) => providerCalls.push(input),
      },
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(providerCalls, [{ workerName: 'pages-v2-guide-ver-1', name: 'API_TOKEN' }]);
});

test('secrets delete treats missing active worker secret as already cleaned up', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);

  const response = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        deleteSecret: async () => {
          const error = new Error('not found');
          error.status = 404;
          throw error;
        },
      },
    })
  );

  assert.equal(response.status, 200);
});

test('secrets put reports when active WFP worker sync fails after saving secret', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await activateSite(store, site.id);

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
      value: 'secret-value',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        putSecret: async () => {
          throw new Error('cloudflare failed');
        },
      },
    })
  );

  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error.code, 'SECRET_ACTIVE_WORKER_SYNC_FAILED');
  assert.equal((await store.listEnabledSiteSecrets('production', 'site_1'))[0].name, 'API_TOKEN');
});

test('replaces site ACL with allow-only OR entries and rejects unsupported policy features', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });

  const put = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [
        { subjectType: 'email', subjectValue: 'bob@example.com' },
        { subjectType: 'email', subjectValue: 'Alice@Example.COM' },
        { subjectType: 'department', subjectValue: ' 心动/技术平台部 ' },
      ],
    }),
    testEnv(store)
  );
  const get = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl'), testEnv(store));
  const deny = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'email', subjectValue: 'bob@example.com', effect: 'deny' }],
    }),
    testEnv(store)
  );
  const user = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'user', subjectValue: 'usr_2' }],
    }),
    testEnv(store)
  );
  const group = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'group', subjectValue: 'grp_1' }],
    }),
    testEnv(store)
  );
  const departmentName = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'department_name', subjectValue: '平台' }],
    }),
    testEnv(store)
  );
  const invalidEmail = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'email', subjectValue: 'not-an-email' }],
    }),
    testEnv(store)
  );

  assert.equal(put.status, 200);
  assert.deepEqual(
    (await put.json()).aclEntries.map(({ subjectType, subjectValue, effect }) => ({ subjectType, subjectValue, effect })),
    [
      { subjectType: 'email', subjectValue: 'bob@example.com', effect: 'allow' },
      { subjectType: 'email', subjectValue: 'alice@example.com', effect: 'allow' },
      { subjectType: 'department', subjectValue: '心动/技术平台部', effect: 'allow' },
    ]
  );
  assert.deepEqual(
    (await get.json()).aclEntries.map(({ subjectType, subjectValue }) => ({ subjectType, subjectValue })),
    [
      { subjectType: 'email', subjectValue: 'bob@example.com' },
      { subjectType: 'email', subjectValue: 'alice@example.com' },
      { subjectType: 'department', subjectValue: '心动/技术平台部' },
    ]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 2);
  assert.equal(deny.status, 400);
  assert.equal((await deny.json()).error.code, 'ACL_EFFECT_UNSUPPORTED');
  assert.equal(user.status, 400);
  assert.equal((await user.json()).error.code, 'ACL_SUBJECT_TYPE_UNSUPPORTED');
  assert.equal(group.status, 400);
  assert.equal((await group.json()).error.code, 'ACL_SUBJECT_TYPE_UNSUPPORTED');
  assert.equal(departmentName.status, 400);
  assert.equal((await departmentName.json()).error.code, 'ACL_SUBJECT_TYPE_UNSUPPORTED');
  assert.equal(invalidEmail.status, 400);
  assert.equal((await invalidEmail.json()).error.code, 'ACL_SUBJECT_VALUE_INVALID');
});

test('grants and revokes site ACL entries incrementally', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await store.replaceSiteAclEntries(
    site.id,
    [{ id: 'acl_existing', subjectType: 'email', subjectValue: 'alice@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  await activateSite(store, site.id, { visibility: 'acl' });
  const snapshots = createSnapshotStore();

  const grant = await worker.fetch(
    jsonMethodRequest('POST', 'https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl/entries', {
      entries: [
        { subjectType: 'email', subjectValue: 'alice@example.com' },
        { subjectType: 'email', subjectValue: 'Bob@Example.COM' },
        { subjectType: 'department', subjectValue: '心动/技术平台部' },
      ],
    }),
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );
  const revoke = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl/entries', {
      entries: [
        { subjectType: 'email', subjectValue: 'alice@example.com' },
        { subjectType: 'department', subjectValue: '心动/技术平台部' },
      ],
    }),
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(grant.status, 200);
  assert.deepEqual(
    (await grant.json()).aclEntries.map(({ subjectType, subjectValue }) => ({ subjectType, subjectValue })),
    [
      { subjectType: 'email', subjectValue: 'alice@example.com' },
      { subjectType: 'email', subjectValue: 'bob@example.com' },
      { subjectType: 'department', subjectValue: '心动/技术平台部' },
    ]
  );
  assert.equal(revoke.status, 200);
  assert.deepEqual(
    (await revoke.json()).aclEntries.map(({ subjectType, subjectValue }) => ({ subjectType, subjectValue })),
    [{ subjectType: 'email', subjectValue: 'bob@example.com' }]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 4);
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team').policyVersion, 4);
});

test('rejects deploy-only access keys from reading site ACL entries', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_1', subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  const accessKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      Authorization: `Bearer ${accessKey}`,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SITE_POLICY_FORBIDDEN');
});

test('rolls back ACL changes when active route snapshot write fails', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_existing', subjectType: 'email', subjectValue: 'existing@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  await activateSite(store, site.id, { visibility: 'acl' });

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'email', subjectValue: 'new@example.com' }],
    }),
    testEnv(store, { ROUTE_SNAPSHOTS: failingSnapshotStore() })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.deepEqual(
    (await store.listSiteAclEntries('site_1')).map(({ id, subjectValue }) => ({ id, subjectValue })),
    [{ id: 'acl_existing', subjectValue: 'existing@example.com' }]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 2);
});

test('rolls back ACL changes when snapshot write fails after runtime config changes', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_existing', subjectType: 'email', subjectValue: 'existing@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  await activateSite(store, site.id, { visibility: 'acl' });
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'email', subjectValue: 'new@example.com' }],
    }),
    testEnv(store, {
      ROUTE_SNAPSHOTS: {
        put: async () => {
          await store.putSiteSecret({
            id: 'sec_1',
            environment: 'production',
            siteId: 'site_1',
            name: 'API_TOKEN',
            value: 'changed-during-acl-update',
            actorId: 'usr_1',
            updatedAt: '2026-06-15T00:00:02.000Z',
          });
          throw new Error('snapshot write failed');
        },
      },
    })
  );
  const route = await store.getRouteBySiteId('site_1', 'production');

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.deepEqual(
    (await store.listSiteAclEntries('site_1')).map(({ id, subjectValue }) => ({ id, subjectValue })),
    [{ id: 'acl_existing', subjectValue: 'existing@example.com' }]
  );
  assert.equal(route.policyVersion, previousRoute.policyVersion);
  assert.equal(route.runtimeConfigGeneration, previousRoute.runtimeConfigGeneration + 1);
});

test('rejects invalid visibility, duplicate slugs, reserved slugs, and invalid slug shape', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_existing',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_existing',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_existing',
    hostname: 'guide.pages.xd.team',
  });

  const invalidVisibility = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'new-site',
      visibility: 'private',
    }),
    testEnv(store)
  );
  const publicVisibility = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'public-site',
      visibility: 'public',
    }),
    testEnv(store)
  );
  const duplicate = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'guide',
      visibility: 'org',
    }),
    testEnv(store)
  );
  const stagingSuffix = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'guide-staging',
      visibility: 'org',
    }),
    testEnv(store)
  );
  const reserved = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'kv-gateway',
      visibility: 'org',
    }),
    testEnv(store)
  );
  const platformDocs = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'docs',
      visibility: 'org',
    }),
    testEnv(store)
  );
  const platformPrefix = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'pages-v2-production-slot-001',
      visibility: 'org',
    }),
    testEnv(store)
  );
  const tooLong = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: `a${'b'.repeat(49)}1`,
      visibility: 'org',
    }),
    testEnv(store)
  );
  const tooShort = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'a',
      visibility: 'org',
    }),
    testEnv(store)
  );

  assert.equal(invalidVisibility.status, 400);
  assert.equal((await invalidVisibility.json()).error.code, 'SITE_VISIBILITY_INVALID');
  const publicVisibilityBody = await publicVisibility.json();
  assert.equal(publicVisibility.status, 400);
  assert.equal(publicVisibilityBody.error.code, 'SITE_VISIBILITY_INVALID');
  assert.match(publicVisibilityBody.error.action, /internal、org、acl、owner 或 disabled/);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'SITE_SLUG_CONFLICT');
  assert.equal(stagingSuffix.status, 400);
  assert.equal((await stagingSuffix.json()).error.code, 'SITE_SLUG_RESERVED');
  assert.equal(reserved.status, 400);
  assert.equal((await reserved.json()).error.code, 'SITE_SLUG_RESERVED');
  const platformDocsBody = await platformDocs.json();
  assert.equal(platformDocs.status, 400);
  assert.equal(platformDocsBody.error.code, 'SITE_SLUG_RESERVED');
  assert.match(platformDocsBody.error.action, /平台保留/);
  assert.equal(platformPrefix.status, 400);
  assert.equal((await platformPrefix.json()).error.code, 'SITE_SLUG_RESERVED');
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error.code, 'SITE_SLUG_INVALID');
  assert.equal(tooShort.status, 400);
  assert.equal((await tooShort.json()).error.code, 'SITE_SLUG_INVALID');
});

test('sites API rejects legacy X-Pages-Token', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: {
        Authorization: 'Bearer cli-token',
        'X-Pages-Token': 'legacy',
      },
    }),
    testEnv(store)
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'LEGACY_TOKEN_UNSUPPORTED');
});

function jsonRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer cli-token',
      'CF-Connecting-IP': '10.1.2.3',
    },
    body: JSON.stringify(body),
  });
}

function patchJsonRequest(url, body) {
  return jsonMethodRequest('PATCH', url, body);
}

function putJsonRequest(url, body) {
  return jsonMethodRequest('PUT', url, body);
}

function jsonMethodRequest(method, url, body, headers = {}) {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer cli-token',
      'CF-Connecting-IP': '10.1.2.3',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authRequest(url, headers = {}, init = {}) {
  return new Request(url, {
    ...init,
    headers: { Authorization: 'Bearer cli-token', 'CF-Connecting-IP': '10.1.2.3', ...headers },
  });
}

async function createSeededStore() {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  return store;
}

async function activateSite(store, siteId, overrides = {}) {
  const workerName = overrides.workerName || 'pages-v2-guide-ver-1';
  await store.createSiteVersion({
    id: 'ver_1',
    siteId,
    deploymentId: 'dep_1',
    workerName,
    runtime: 'wfp',
    artifactRef: `wfp://test/${workerName}`,
    contentHash: 'sha256:abc',
    deploymentShape: overrides.deploymentShape || 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: overrides.resolvedFallback ?? null,
    routingMode: overrides.routingMode || 'worker-only',
    createdBy: 'usr_1',
  });
  return store.activateSiteVersion(
    siteId,
    {
      activeVersionId: 'ver_1',
      workerName,
      visibility: overrides.visibility || 'org',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
    'production'
  );
}

function failingSnapshotStore() {
  return {
    put: async () => {
      throw new Error('snapshot write failed');
    },
  };
}

function createSnapshotStore() {
  const values = new Map();
  return {
    put: async (key, value) => values.set(key, JSON.parse(value)),
    read: (key) => values.get(key),
  };
}

async function seedAccessKey(store, keyId, scopes, siteId = 'site_1', options = {}) {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId,
    bytes: new Uint8Array(24).fill(3),
  });
  const ownerType = options.ownerType || 'user';
  const ownerUserId = options.ownerUserId || 'usr_1';
  await store.createAccessKey({
    id: keyId,
    environment: 'production',
    ownerType,
    ownerId: options.ownerId || (ownerType === 'user' ? ownerUserId : undefined),
    ownerUserId,
    createdByUserId: options.createdByUserId || ownerUserId,
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes,
    siteId,
    expiresAt: '2026-07-15T00:00:00.000Z',
  });
  return plaintext;
}

function testEnv(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: (prefix) =>
      ({
        site: 'site_1',
        route: 'route_1',
      })[prefix],
    nextSiteUuid: () => '4b4c8e8361ef4b47b64f5c20a7db7c47',
    verifyCliToken: async () => ({
      sub: 'usr_1',
      purpose: 'cli_token',
      aud: 'pages-cli',
      env: 'production',
      jti: 'cli_1',
    }),
    ...overrides,
  };
}
