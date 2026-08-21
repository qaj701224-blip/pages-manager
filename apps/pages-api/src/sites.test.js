import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import worker from './index.js';
import { markRuntimeConfigError } from './runtime-config-diagnostics.js';
import { syncActiveWfpPlainTextBindings, syncActiveWfpSecret } from './sites.js';
import { createTestPagesStore } from './test-store.js';
import { seedLifecycleWebhook, TEST_WEBHOOK_URL_ENCRYPTION_KEY } from './lifecycle-webhook-test-fixtures.js';

const BEARER_USR_1 = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_1',
  bytes: new Uint8Array(24).fill(11),
});
const BEARER_USR_PUBLISHER = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_publisher',
  bytes: new Uint8Array(24).fill(12),
});
const BEARER_USR_2 = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_2',
  bytes: new Uint8Array(24).fill(13),
});
const BEARER_USR_VIEWER = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_viewer',
  bytes: new Uint8Array(24).fill(14),
});

async function seedCliLoginKey(store, userId, plaintext, environment = 'production') {
  await store.createAccessKey({
    id: `ak_cli_${userId}`,
    environment,
    ownerType: 'user',
    ownerId: userId,
    ownerUserId: userId,
    createdByUserId: userId,
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: `cli login ${userId}`,
    scopes: ['*'],
    issuedSource: 'cli_login',
    issuedSessionVersion: 1,
  });
}

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

test('create site takes over an email-matched v1 site before creating v2 state', async () => {
  const store = await createSeededStore();
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'guide.workers.xd.team',
    normalizedSlug: 'guide',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:guide',
    ownerRef: 'pages-guide',
    source: 'backfill_v1_sites',
  });
  const cloudflareCalls = [];
  const deletedKvKeys = [];

  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'guide',
      visibility: 'org',
    }),
    testEnv(store, {
      V1_SITES: {
        async get(slug, type) {
          assert.equal(slug, 'guide');
          assert.equal(type, 'json');
          return {
            name: 'guide',
            token: 'pages_user@example.com',
            scriptName: 'pages-guide',
            url: 'https://guide.workers.xd.team',
          };
        },
        async delete(slug) {
          deletedKvKeys.push(slug);
        },
      },
      V1_CLOUDFLARE_CLIENT: {
        async listRoutes() {
          cloudflareCalls.push('listRoutes');
          return [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' }];
        },
        async deleteRoute({ routeId }) {
          cloudflareCalls.push(`deleteRoute:${routeId}`);
        },
        async deleteScript({ scriptName }) {
          cloudflareCalls.push(`deleteScript:${scriptName}`);
        },
      },
      nextId: (prefix) => ({ site: 'site_1', route: 'route_1', aud: 'aud_1', cleanup: 'cleanup_1' })[prefix],
      nextSiteUuid: () => '4b4c8e8361ef4b47b64f5c20a7db7c47',
    })
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.site.slug, 'guide');
  assert.equal('token' in body.site, false);
  assert.doesNotMatch(JSON.stringify(body), /pages-user@example\.com|pages-guide|user@example\.com/);
  assert.deepEqual(cloudflareCalls, ['listRoutes', 'deleteRoute:route_cf_1', 'deleteScript:pages-guide']);
  assert.deepEqual(deletedKvKeys, ['guide']);
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v2');
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerId, 'site_1');
});

test('create site keeps v1 state and skips Cloudflare deletion when emails differ', async () => {
  const store = await createSeededStore();
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'guide.workers.xd.team',
    normalizedSlug: 'guide',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:guide',
    ownerRef: 'pages-guide',
    source: 'backfill_v1_sites',
  });
  let cloudflareCalls = 0;
  let deletedKvKeys = 0;

  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'guide',
      visibility: 'org',
    }),
    testEnv(store, {
      V1_SITES: {
        async get() {
          return {
            name: 'guide',
            token: 'pages_other@example.com',
            scriptName: 'pages-guide',
            url: 'https://guide.workers.xd.team',
          };
        },
        async delete() {
          deletedKvKeys += 1;
        },
      },
      V1_CLOUDFLARE_CLIENT: {
        async listRoutes() {
          cloudflareCalls += 1;
          return [];
        },
        async deleteRoute() {
          cloudflareCalls += 1;
        },
        async deleteScript() {
          cloudflareCalls += 1;
        },
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'HOSTNAME_CLAIM_CONFLICT');
  assert.equal(cloudflareCalls, 0);
  assert.equal(deletedKvKeys, 0);
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v1');
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
  await seedCliLoginKey(store, 'usr_publisher', BEARER_USR_PUBLISHER);

  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites',
      {
        slug: 'team-guide',
        visibility: 'internal',
        ownerType: 'team',
        teamId: team.id,
      },
      BEARER_USR_PUBLISHER
    ),
    testEnv(store)
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

test('lists team-owned sites for active team members', async () => {
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
    createdByUserId: 'usr_creator',
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

  const visible = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites'), testEnv(store));

  assert.equal(visible.status, 200, await visible.clone().text());
  assert.deepEqual(
    (await visible.json()).sites.map((site) => site.slug),
    ['team-guide']
  );

  await store.removeTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    actorUserId: 'usr_creator',
    removedAt: '2026-06-15T00:01:00.000Z',
  });
  const hidden = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites'), testEnv(store));

  assert.equal(hidden.status, 200, await hidden.clone().text());
  assert.deepEqual((await hidden.json()).sites, []);
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
  const requests = [];
  await seedLifecycleWebhook(store, 'site.deleted');
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
    testEnv(store, {
      now: () => '2026-06-15T00:00:00.000Z',
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
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
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.deleted');
  assert.equal(payload.actor.userId, 'usr_1');
  assert.equal(payload.site.status, 'deleted');
});

test('CLI missing and repeated deletes do not emit site.deleted', async () => {
  const store = await createSeededStore();
  const requests = [];
  await seedLifecycleWebhook(store, 'site.deleted');
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
  const deleteEnv = testEnv(store, {
    ROUTE_SNAPSHOTS: createSnapshotStore(),
    WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
  });

  const missing = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_missing', {}, { method: 'DELETE' }),
    deleteEnv
  );
  const first = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {}, { method: 'DELETE' }),
    deleteEnv
  );
  const repeated = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {}, { method: 'DELETE' }),
    deleteEnv
  );

  assert.equal(missing.status, 404, await missing.clone().text());
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(repeated.status, 404, await repeated.clone().text());
  assert.equal(requests.length, 1);
});

test('site deletion enqueues managed route and active-version Workers for cleanup without blocking deletion', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'governed',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_governed',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_governed',
    hostname: 'governed.workers.xd.team',
  });
  await activateSite(store, 'site_1', {
    workerName: 'pages-v2-route-worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
  });
  await store.createSiteVersion({
    id: 'ver_previous',
    siteId: 'site_1',
    deploymentId: 'dep_previous',
    workerName: 'pages-v2-previous-worker',
    runtime: 'wfp',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-previous-worker',
    contentHash: 'sha256:previous',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_1',
  });
  await store.createSiteVersion({
    id: 'ver_unmanaged',
    siteId: 'site_1',
    deploymentId: 'dep_unmanaged',
    workerName: 'normal-worker',
    runtime: 'wfp',
    artifactRef: 'wfp://test/normal-worker',
    contentHash: 'sha256:unmanaged',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_1',
  });
  await store.createSiteVersion({
    id: 'ver_normal_slot',
    siteId: 'site_1',
    deploymentId: 'dep_normal_slot',
    workerName: 'pages-v2-production-slot-1',
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    dispatchType: null,
    artifactRef: 'slot://test/pages-v2-production-slot-1',
    contentHash: 'sha256:slot',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_1',
  });

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {}, { method: 'DELETE' }),
    testEnv(store, { WFP_WORKER_CLEANUP_DRAIN_SECONDS: 300, ROUTE_SNAPSHOTS: createSnapshotStore() })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const tasks = await store.listDeploymentResourceCleanupTasks({ environment: 'production' });
  assert.deepEqual(
    tasks.map((task) => [task.resourceRef, task.cleanupReason, task.cleanupAfter]),
    [
      ['pages-v2-route-worker', 'site_deleted', '2026-06-15T00:05:00.000Z'],
      ['pages-v2-previous-worker', 'site_deleted', '2026-06-15T00:05:00.000Z'],
    ]
  );

  const failingStore = await createSeededStore();
  await failingStore.createSite({
    id: 'site_fail',
    slug: 'enqueue-failure',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_enqueue_failure',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_enqueue_failure',
    hostname: 'enqueue-failure.workers.xd.team',
  });
  await activateSite(failingStore, 'site_fail', { workerName: 'pages-v2-failure-worker' });
  failingStore.createDeploymentResourceCleanupTask = async () => {
    throw new Error('CLEANUP_ENQUEUE_FAILED');
  };
  const failureResponse = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_fail', {}, { method: 'DELETE' }),
    testEnv(failingStore, { ROUTE_SNAPSHOTS: createSnapshotStore() })
  );
  assert.equal(failureResponse.status, 200, await failureResponse.clone().text());
  assert.equal((await failingStore.getSite('site_fail')).deletedAt, '2026-06-15T00:00:00.000Z');
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
  await seedCliLoginKey(store, 'usr_2', BEARER_USR_2);

  const memberDelete = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {}, { method: 'DELETE' }, BEARER_USR_2),
    testEnv(store)
  );
  const accessKeyDelete = await worker.fetch(
    authRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/site_1',
      {
        Authorization: `Bearer ${readKey}`,
      },
      { method: 'DELETE' }
    ),
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
  await activateSite(store, 'site_team', { visibility: 'org' });
  await seedCliLoginKey(store, 'usr_publisher', BEARER_USR_PUBLISHER);

  const snapshots = createSnapshotStore();
  const env = testEnv(store, {
    ROUTE_SNAPSHOTS: snapshots,
  });
  const update = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_team', { visibility: 'disabled' }, BEARER_USR_PUBLISHER),
    env
  );
  const del = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_team', {}, { method: 'DELETE' }, BEARER_USR_PUBLISHER),
    env
  );

  assert.equal(update.status, 200, await update.clone().text());
  assert.equal((await update.json()).site.route.visibility, 'disabled');
  assert.equal(del.status, 200, await del.clone().text());
  assert.equal((await store.getSite('site_team')).deletedAt, '2026-06-15T00:00:00.000Z');
  const pointer = snapshots.read('production:route_pointer:team-guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.routeStatus, 'deleted');
  assert.equal(snapshot.runtime, 'disabled');
  assert.equal(snapshot.ownerUserId, null);
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
    jsonMethodRequest(
      'POST',
      'https://api.pages.xd.team/.xd-pages/api/sites/site_team/transfer',
      {
        ownerType: 'user',
        ownerId: 'usr_1',
      },
      { Authorization: `Bearer ${key}` }
    ),
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
  await activateSite(store, 'site_1', { visibility: 'org' });
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
  const snapshots = createSnapshotStore();

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
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.site.owner.type, 'team');
  assert.equal((await store.getSite('site_1')).ownerType, 'team');
  assert.equal((await store.getSite('site_1')).ownerId, team.id);
  assert.equal((await store.getSite('site_1')).ownerUserId, 'usr_1');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.visibility, 'org');
  assert.equal(snapshot.ownerUserId, null);
  const transferEvents = (await store.listAuditEvents()).filter((event) => event.eventType === 'site.owner.transfer');
  assert.equal(transferEvents.length, 1);
  assert.deepEqual(transferEvents[0].metadata, {
    siteSlug: 'guide',
    fromOwner: { type: 'user', id: 'usr_1' },
    toOwner: { type: 'team', id: team.id },
    source: 'api',
  });
});

test('personal access token cannot transfer owner-visible sites to teams', async () => {
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
  await activateSite(store, 'site_1', { visibility: 'owner' });
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

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_VISIBILITY_INVALID');
  assert.equal((await store.getSite('site_1')).ownerType, 'user');
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
    jsonMethodRequest(
      'POST',
      'https://api.pages.xd.team/.xd-pages/api/sites/site_team/transfer',
      {
        ownerType: 'user',
        ownerId: 'usr_1',
      },
      { Authorization: `Bearer ${key}` }
    ),
    testEnv(store)
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_TRANSFER_FORBIDDEN');
  assert.equal((await store.getSite('site_team')).ownerType, 'team');
});

test('allows deploy scope to read sites while keeping unrelated scopes read-only', async () => {
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
  const rollbackOnlyKey = await seedAccessKey(store, 'ak_rollback', ['rollback:site']);
  const deployOnlyKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const readKey = await seedAccessKey(store, 'ak_read', ['read:site']);

  const deniedList = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      Authorization: `Bearer ${rollbackOnlyKey}`,
    }),
    testEnv(store)
  );
  const deniedGet = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {
      Authorization: `Bearer ${rollbackOnlyKey}`,
    }),
    testEnv(store)
  );
  const allowedDeployGet = await worker.fetch(
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
  assert.equal(allowedDeployGet.status, 200);
  assert.equal(allowedGet.status, 200);
  assert.equal((await allowedGet.json()).site.id, 'site_1');
});

test('updates site visibility and bumps policy version for active routes', async () => {
  const store = await createSeededStore();
  const requests = [];
  await seedLifecycleWebhook(store, 'site.disabled');
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
    testEnv(store, {
      ROUTE_SNAPSHOTS: snapshots,
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.site.defaultVisibility, 'disabled');
  assert.equal(body.site.route.policyVersion, 2);
  assert.equal(body.site.route.visibility, 'disabled');
  assert.equal((await store.getRouteBySiteId('site_1')).cacheTier, 'strict');
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team').policyVersion, 2);
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team').routeGeneration, 1);

  const repeated = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'disabled' }),
    testEnv(store, {
      ROUTE_SNAPSHOTS: snapshots,
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.disabled');
  assert.deepEqual(payload.change, {
    field: 'visibility',
    previousValue: 'org',
    currentValue: 'disabled',
  });
});

test('regular visibility update uses the site lease and preserves an existing public exposure', async () => {
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
  const initialRoute = await activateSite(store, site.id, { visibility: 'org' });
  store.routes.get(initialRoute.id).exposure = 'public';
  store.sites.get(site.id).defaultExposure = 'public';
  const originalWithSiteCommitLock = store.withSiteCommitLock.bind(store);
  let lockCalls = 0;
  store.withSiteCommitLock = async (...args) => {
    lockCalls += 1;
    return originalWithSiteCommitLock(...args);
  };
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'internal' }),
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes('exposure'), false);
  assert.equal(lockCalls, 1);
  const route = await store.getRouteBySiteId(site.id, 'production');
  assert.equal(route.policyVersion, initialRoute.policyVersion + 1);
  assert.equal(route.exposure, 'public');
  assert.equal(route.accessMode, 'anonymous');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  assert.equal(pointer.policyVersion, route.policyVersion);
  assert.equal(snapshots.read(pointer.snapshotKey).exposure, 'public');
  assert.equal(snapshots.read(pointer.snapshotKey).accessMode, 'anonymous');
});

test('regular visibility update returns a stable conflict while the site lease is held', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_lease_conflict',
    slug: 'lease-conflict',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_lease_conflict',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_lease_conflict',
    hostname: 'lease-conflict.pages.xd.team',
  });
  await activateSite(store, site.id, { visibility: 'org' });
  const lease = await store.acquireSiteCommitLock('production', site.id, { lockId: 'held_by_other_writer' });
  assert.ok(lease);

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_lease_conflict', { visibility: 'acl' }),
    testEnv(store, { ROUTE_SNAPSHOTS: createSnapshotStore() })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_POLICY_CONFLICT');
  assert.equal((await store.getRouteBySiteId(site.id)).visibility, 'org');
  await store.releaseSiteCommitLock('production', site.id, lease.lockId);
});

test('regular site visibility API rejects explicit exposure changes', async () => {
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
  const route = await activateSite(store, 'site_1', { visibility: 'org' });
  store.routes.get(route.id).exposure = 'public';
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {
      visibility: 'acl',
      exposure: 'internal',
    }),
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_EXPOSURE_ADMIN_REQUIRED');
  assert.equal((await store.getRouteBySiteId('site_1')).exposure, 'public');
});

test('rolls back visibility changes when active route snapshot write fails', async () => {
  const store = await createSeededStore();
  const requests = [];
  await seedLifecycleWebhook(store, 'site.disabled');
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
    testEnv(store, {
      ROUTE_SNAPSHOTS: failingSnapshotStore(),
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_POLICY_REPAIR_REQUIRED');
  assert.equal((await store.getSite('site_1')).defaultVisibility, 'org');
  assert.equal((await store.getRouteBySiteId('site_1')).visibility, 'org');
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 3);
  assert.equal(requests.length, 0);
});

test('rolls back active site deletes when route snapshot write fails', async () => {
  const store = await createSeededStore();
  const requests = [];
  await seedLifecycleWebhook(store, 'site.deleted');
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
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {}, { method: 'DELETE' }),
    testEnv(store, {
      ROUTE_SNAPSHOTS: failingSnapshotStore(),
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal((await store.getSite('site_1')).deletedAt, null);
  assert.equal((await store.getRouteBySiteId('site_1')).routeStatus, 'active');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal((await store.getHostnameClaim('guide.pages.xd.team')).status, 'active');
  assert.equal(requests.length, 0);
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
  let injectedRuntimeChange = false;

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'disabled' }),
    testEnv(store, {
      ROUTE_SNAPSHOTS: {
        put: async () => {
          if (!injectedRuntimeChange) {
            injectedRuntimeChange = true;
            await store.putSiteSecret({
              id: 'sec_1',
              environment: 'production',
              siteId: 'site_1',
              name: 'API_TOKEN',
              value: 'changed-during-policy-update',
              actorId: 'usr_1',
              updatedAt: '2026-06-15T00:00:02.000Z',
            });
          }
          throw new Error('snapshot write failed');
        },
      },
    })
  );
  const route = await store.getRouteBySiteId('site_1', 'production');

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_POLICY_REPAIR_REQUIRED');
  assert.equal((await store.getSite('site_1')).defaultVisibility, 'org');
  assert.equal(route.visibility, 'org');
  assert.equal(route.policyVersion, previousRoute.policyVersion + 2);
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
        putSecret: async (input) => providerCalls.push(withoutSignal(input)),
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

test('secrets put reports a runtime binding name conflict without exposing the secret value', async () => {
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
  await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com',
    actorId: 'usr_1',
  });

  const lines = [];
  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_BASE',
      value: 'secret-value-conflict',
    }),
    testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) })
  );
  const text = await response.text();

  assert.equal(response.status, 400);
  assert.equal(JSON.parse(text).error.code, 'RUNTIME_BINDING_NAME_CONFLICT');
  assert.doesNotMatch(text, /secret-value-conflict/);
  assert.deepEqual(lines, []);
});

test('secrets put reports the shared runtime binding quota without exposing the secret value', async () => {
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

  const lines = [];
  const environment = testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) });
  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'DEPLOY_KEY',
      value: 'secret-value-over-limit',
    }),
    environment
  );
  store.putSiteSecretWithAudit = async () => {
    throw new Error('SITE_SECRET_REVISION_CONFLICT');
  };
  const conflict = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'DEPLOY_KEY',
      value: 'secret-value-conflict',
    }),
    environment
  );
  const text = await response.text();

  assert.equal(response.status, 413);
  assert.equal(JSON.parse(text).error.code, 'RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  assert.doesNotMatch(text, /secret-value-over-limit/);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(lines, []);
});

test('secrets put maps a historical over-limit vars state to the shared binding quota error', async () => {
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
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`VAR_${String(index).padStart(2, '0')}`, 'on'])),
    actorId: 'usr_1',
  });

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
      value: 'secret-value-over-limit',
    }),
    testEnv(store)
  );
  const text = await response.text();

  assert.equal(response.status, 413);
  assert.equal(JSON.parse(text).error.code, 'RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  assert.doesNotMatch(text, /secret-value-over-limit/);
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
  await seedCliLoginKey(store, 'usr_publisher', BEARER_USR_PUBLISHER);
  const publisherEnv = testEnv(store, {
    WFP_PROVIDER: {
      putSecret: async (input) => providerCalls.push({ operation: 'put', ...withoutSignal(input) }),
      deleteSecret: async (input) => providerCalls.push({ operation: 'delete', ...withoutSignal(input) }),
    },
  });

  const put = await worker.fetch(
    putJsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/team-guide/secrets',
      {
        name: 'API_TOKEN',
        value: 'secret-value',
      },
      BEARER_USR_PUBLISHER
    ),
    publisherEnv
  );
  const del = await worker.fetch(
    jsonMethodRequest(
      'DELETE',
      'https://api.pages.xd.team/.xd-pages/api/sites/team-guide/secrets',
      {
        name: 'API_TOKEN',
      },
      {},
      BEARER_USR_PUBLISHER
    ),
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
      putSecret: async (input) => providerCalls.push({ operation: 'put', ...withoutSignal(input) }),
      deleteSecret: async (input) => providerCalls.push({ operation: 'delete', ...withoutSignal(input) }),
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
        deleteSecret: async (input) => providerCalls.push(withoutSignal(input)),
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
        deleteSecret: async (input) => providerCalls.push(withoutSignal(input)),
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
  const lines = [];

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets', {
      name: 'API_TOKEN',
      value: 'provider-secret-private-value',
    }),
    testEnv(store, {
      logRuntimeConfigFailure: (line) => lines.push(line),
      WFP_PROVIDER: {
        putSecret: async () => {
          throw new Error('SENSITIVE_PROVIDER_SECRET_ERROR');
        },
      },
    })
  );

  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error.code, 'SECRET_ACTIVE_WORKER_SYNC_FAILED');
  assert.equal((await store.listEnabledSiteSecrets('production', 'site_1'))[0].name, 'API_TOKEN');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_sync',
        environment: 'production',
        siteId: 'site_1',
        stage: 'provider_sync',
        reason: 'provider_request_failed',
        errorCode: 'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      },
    ]
  );
  assert.doesNotMatch(lines[0], /private|SENSITIVE|API_TOKEN|guide/);
});

test('runtime provider setup failures log safe vars and secret diagnostics', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'sensitive-provider-slug',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'sensitive-provider-slug.pages.xd.team',
  });
  await activateSite(store, site.id);
  const lines = [];
  const environment = testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) });

  const varsResult = await syncActiveWfpPlainTextBindings(store, environment, { environment: 'production' }, site, {
    vars: [{ name: 'SENSITIVE_VAR_NAME', value: 'SENSITIVE_VAR_VALUE' }],
    generation: 1,
  });
  const secretResult = await syncActiveWfpSecret(store, environment, { environment: 'production' }, site, {
    operation: 'put',
    name: 'SENSITIVE_SECRET_NAME',
    value: 'SENSITIVE_SECRET_VALUE',
  });

  assert.equal(varsResult.status, 502);
  assert.equal((await varsResult.json()).error.code, 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED');
  assert.equal(secretResult.status, 502);
  assert.equal((await secretResult.json()).error.code, 'SECRET_ACTIVE_WORKER_SYNC_FAILED');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'plain_text_sync',
        environment: 'production',
        siteId: 'site_1',
        stage: 'provider_setup',
        reason: 'provider_configuration_failed',
        errorCode: 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_sync',
        environment: 'production',
        siteId: 'site_1',
        stage: 'provider_setup',
        reason: 'provider_configuration_failed',
        errorCode: 'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      },
    ]
  );
  assert.doesNotMatch(lines.join('\n'), /sensitive|SENSITIVE|VAR_NAME|SECRET_NAME|VALUE/);
});

test('runtime provider target read failures log safe vars and secret diagnostics', async () => {
  const store = await createSeededStore();
  store.getRouteBySiteId = async () => {
    throw new Error('SENSITIVE_ROUTE_READ_ERROR');
  };
  const site = { id: 'site_1' };
  const lines = [];
  const environment = testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) });

  const varsResult = await syncActiveWfpPlainTextBindings(store, environment, { environment: 'production' }, site, {
    vars: [{ name: 'SENSITIVE_VAR_NAME', value: 'SENSITIVE_VAR_VALUE' }],
    generation: 1,
  });
  const secretResult = await syncActiveWfpSecret(store, environment, { environment: 'production' }, site, {
    operation: 'put',
    name: 'SENSITIVE_SECRET_NAME',
    value: 'SENSITIVE_SECRET_VALUE',
  });

  assert.equal(varsResult.status, 502);
  assert.equal((await varsResult.json()).error.code, 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED');
  assert.equal(secretResult.status, 502);
  assert.equal((await secretResult.json()).error.code, 'SECRET_ACTIVE_WORKER_SYNC_FAILED');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'plain_text_sync',
        environment: 'production',
        siteId: 'site_1',
        stage: 'route_state_read',
        reason: 'store_operation_failed',
        errorCode: 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_sync',
        environment: 'production',
        siteId: 'site_1',
        stage: 'route_state_read',
        reason: 'store_operation_failed',
        errorCode: 'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      },
    ]
  );
  assert.doesNotMatch(lines.join('\n'), /sensitive|SENSITIVE|VAR_NAME|SECRET_NAME|VALUE|ROUTE_READ/);
});

test('runtime provider lock conflicts remain unlogged', async () => {
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
  store.withRuntimeConfigLock = async () => {
    throw new Error('RUNTIME_CONFIG_LOCKED');
  };
  const lines = [];
  const environment = testEnv(store, {
    logRuntimeConfigFailure: (line) => lines.push(line),
    WFP_PROVIDER: {
      replacePlainTextBindings: async () => {},
      putSecret: async () => {},
    },
  });

  const varsResult = await syncActiveWfpPlainTextBindings(store, environment, { environment: 'production' }, site, {
    vars: [],
    generation: 1,
  });
  const secretResult = await syncActiveWfpSecret(store, environment, { environment: 'production' }, site, {
    operation: 'put',
    name: 'API_TOKEN',
    value: 'secret-value',
  });

  assert.equal(varsResult.status, 409);
  assert.equal((await varsResult.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.equal(secretResult.status, 409);
  assert.equal((await secretResult.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(lines, []);
});

test('secret mutations log safe store and capability diagnostics', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'sensitive-secret-slug',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'sensitive-secret-slug.pages.xd.team',
  });
  const lines = [];
  const environment = testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) });
  const storeError = new Error('SENSITIVE_SECRET_VALUE SENSITIVE_SQL');
  storeError.cause = new Error('SENSITIVE_SECRET_CAUSE');
  const throwStoreError = async () => {
    throw markRuntimeConfigError(storeError, { stage: 'mutation_batch', reason: 'store_operation_failed' });
  };
  store.putSiteSecretWithAudit = throwStoreError;
  store.deleteSiteSecretWithAudit = throwStoreError;

  const putFailure = await worker.fetch(
    jsonMethodRequest('PUT', 'https://api.pages.xd.team/.xd-pages/api/sites/sensitive-secret-slug/secrets', {
      name: 'SENSITIVE_SECRET_NAME',
      value: 'SENSITIVE_SECRET_VALUE',
    }),
    environment
  );
  const deleteFailure = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/sensitive-secret-slug/secrets', {
      name: 'SENSITIVE_SECRET_NAME',
    }),
    environment
  );

  store.putSiteSecretWithAudit = undefined;
  store.deleteSiteSecretWithAudit = undefined;
  const putCapability = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/sensitive-secret-slug/secrets', {
      name: 'SENSITIVE_SECRET_NAME',
      value: 'SENSITIVE_SECRET_VALUE',
    }),
    environment
  );
  const deleteCapability = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/sensitive-secret-slug/secrets', {
      name: 'SENSITIVE_SECRET_NAME',
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
        siteId: 'site_1',
        stage: 'mutation_batch',
        reason: 'store_operation_failed',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_delete',
        environment: 'production',
        siteId: 'site_1',
        stage: 'mutation_batch',
        reason: 'store_operation_failed',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_put',
        environment: 'production',
        siteId: 'site_1',
        stage: 'capability_check',
        reason: 'capability_unavailable',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_delete',
        environment: 'production',
        siteId: 'site_1',
        stage: 'capability_check',
        reason: 'capability_unavailable',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      },
    ]
  );
  assert.doesNotMatch(lines.join('\n'), /sensitive|SENSITIVE|Authorization|Bearer|SQL/);
});

test('runtime vars put updates the active Worker without exposing the value', async () => {
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
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: ' API_BASE ',
      value: ' https://api.example.com ',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        replacePlainTextBindings: async (input) => providerCalls.push(withoutSignal(input)),
      },
    })
  );
  const text = await response.text();

  assert.equal(response.status, 200, text);
  assert.deepEqual(JSON.parse(text), {
    var: {
      site: 'guide',
      name: 'API_BASE',
      revision: 1,
      updated: true,
      appliesTo: 'active_worker',
    },
  });
  assert.doesNotMatch(text, /api\.example\.com/);
  assert.deepEqual(providerCalls, [
    {
      workerName: 'pages-v2-guide-ver-1',
      vars: { API_BASE: ' https://api.example.com ' },
    },
  ]);
  assert.deepEqual(
    (await store.listEnabledSiteVars('production', 'site_1')).map(({ name, value }) => ({ name, value })),
    [{ name: 'API_BASE', value: ' https://api.example.com ' }]
  );
});

test('runtime vars delete updates the active Worker without exposing the deleted value', async () => {
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
  await store.mutateSiteVar({
    environment: 'production',
    siteId: site.id,
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com/private',
    actorId: 'usr_1',
  });
  const providerCalls = [];

  const response = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: ' API_BASE ',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        replacePlainTextBindings: async (input) => providerCalls.push(withoutSignal(input)),
      },
    })
  );
  const text = await response.text();

  assert.equal(response.status, 200, text);
  assert.deepEqual(JSON.parse(text), {
    var: {
      site: 'guide',
      name: 'API_BASE',
      deleted: true,
      appliesTo: 'active_worker',
    },
  });
  assert.doesNotMatch(text, /api\.example\.com|private/);
  assert.deepEqual(providerCalls, [{ workerName: 'pages-v2-guide-ver-1', vars: {} }]);
  assert.deepEqual(await store.listEnabledSiteVars('production', site.id), []);
});

test('runtime vars reject request bodies with extra fields without mutating the store', async () => {
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

  const put = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'API_BASE',
      value: 'https://api.example.com',
      unexpected: true,
    }),
    testEnv(store)
  );
  const del = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'API_BASE',
      unexpected: true,
    }),
    testEnv(store)
  );

  assert.equal(put.status, 400);
  assert.equal((await put.json()).error.code, 'RUNTIME_VAR_INVALID');
  assert.equal(del.status, 400);
  assert.equal((await del.json()).error.code, 'RUNTIME_VAR_INVALID');
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), []);
});

test('runtime vars return stable validation errors for names, values, and limits', async () => {
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
  const cases = [
    { body: { name: 'ASSETS', value: 'value' }, status: 400, code: 'RUNTIME_BINDING_NAME_RESERVED' },
    { body: { name: 'API_TOKEN', value: 'value' }, status: 400, code: 'RUNTIME_VAR_INVALID' },
    { body: { name: 'api_base', value: 'value' }, status: 400, code: 'RUNTIME_VAR_INVALID' },
    { body: { name: 'API_BASE', value: 123 }, status: 400, code: 'RUNTIME_VAR_INVALID' },
    { body: { name: 'API_BASE', value: 'x'.repeat(8 * 1024 + 1) }, status: 413, code: 'RUNTIME_VARS_LIMIT_EXCEEDED' },
  ];

  for (const entry of cases) {
    const response = await worker.fetch(
      putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', entry.body),
      testEnv(store)
    );
    assert.equal(response.status, entry.status, JSON.stringify(entry.body));
    assert.equal((await response.json()).error.code, entry.code);
  }
  const reservedDelete = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', { name: 'XD_PAGES_KV_GATEWAY' }),
    testEnv(store)
  );
  assert.equal(reservedDelete.status, 400);
  assert.equal((await reservedDelete.json()).error.code, 'RUNTIME_BINDING_NAME_RESERVED');
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), []);
});

test('runtime vars accept an escaped JSON value at the decoded 8 KiB limit', async () => {
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
  const escapedValue = '\\u0041'.repeat(8 * 1024);

  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER_USR_1}` },
      body: `{"name":"FEATURE_FLAG","value":"${escapedValue}"}`,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await store.listEnabledSiteVars('production', 'site_1'))[0].value, 'A'.repeat(8 * 1024));
});

test('runtime vars return the dedicated var limit error for the 65th var', async () => {
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
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`VAR_${String(index).padStart(2, '0')}`, 'on'])),
    actorId: 'usr_1',
  });

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'VAR_64',
      value: 'on',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'RUNTIME_VARS_LIMIT_EXCEEDED');
});

test('runtime vars put reports a site secret name conflict without exposing either value', async () => {
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
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_BASE',
    value: 'existing-secret-value',
    actorId: 'usr_1',
  });

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'API_BASE',
      value: 'new-var-value',
    }),
    testEnv(store)
  );
  const text = await response.text();

  assert.equal(response.status, 400, text);
  assert.equal(JSON.parse(text).error.code, 'RUNTIME_BINDING_NAME_CONFLICT');
  assert.doesNotMatch(text, /existing-secret-value|new-var-value/);
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), []);
});

test('runtime vars fallback resynchronizes the latest generation when provider calls finish in reverse order', async () => {
  const store = await createSeededStore();
  store.withRuntimeConfigLock = undefined;
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
  let notifyFirstStarted;
  const firstStarted = new Promise((resolve) => {
    notifyFirstStarted = resolve;
  });
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const providerCalls = [];
  let activeBindings = null;
  const env = testEnv(store, {
    WFP_PROVIDER: {
      replacePlainTextBindings: async ({ workerName, vars }) => {
        providerCalls.push({ workerName, vars });
        if (providerCalls.length === 1) {
          notifyFirstStarted();
          await firstBlocked;
        }
        activeBindings = { ...vars };
      },
    },
  });

  const firstResponse = worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'API_BASE',
      value: 'https://api.example.com',
    }),
    env
  );
  await firstStarted;
  const secondResponse = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'FEATURE_FLAG',
      value: 'on',
    }),
    env
  );
  releaseFirst();
  const first = await firstResponse;

  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  assert.deepEqual(providerCalls, [
    { workerName: 'pages-v2-guide-ver-1', vars: { API_BASE: 'https://api.example.com' } },
    {
      workerName: 'pages-v2-guide-ver-1',
      vars: { API_BASE: 'https://api.example.com', FEATURE_FLAG: 'on' },
    },
  ]);
  assert.deepEqual(activeBindings, { API_BASE: 'https://api.example.com', FEATURE_FLAG: 'on' });
});

test('runtime vars legacy provider fallback receives a timeout signal', async () => {
  const store = await createSeededStore();
  store.withRuntimeConfigLock = undefined;
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
  let receivedSignal;
  const environment = testEnv(store, {
    WFP_PROVIDER: {
      replacePlainTextBindings: async ({ signal }) => {
        receivedSignal = signal;
      },
    },
  });

  const result = await syncActiveWfpPlainTextBindings(store, environment, { environment: 'production' }, site, {
    API_BASE: 'https://api.example.com',
  });

  assert.deepEqual(result, { appliesTo: 'active_worker' });
  assert.equal(receivedSignal instanceof globalThis.AbortSignal, true);
});

test('runtime provider sync serializes a real WFP settings PATCH with secret PUT', async () => {
  const result = await runRuntimeProviderSecretRace('put');

  assert.equal(result.interleaving, 'secret_waiting_for_site');
  assert.deepEqual(result.bindings, [
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
    { type: 'secret_text', name: 'API_TOKEN' },
  ]);
});

test('runtime provider sync serializes a real WFP settings PATCH with secret DELETE', async () => {
  const result = await runRuntimeProviderSecretRace('delete');

  assert.equal(result.interleaving, 'secret_waiting_for_site');
  assert.deepEqual(result.bindings, [
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
  ]);
});

test('runtime secret sync treats a stale put as the latest idempotent delete', async () => {
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
  const calls = [];

  const result = await syncActiveWfpSecret(
    store,
    testEnv(store, {
      WFP_PROVIDER: {
        putSecret: async () => calls.push('put'),
        deleteSecret: async () => {
          calls.push('delete');
          throw Object.assign(new Error('missing'), { status: 404 });
        },
      },
    }),
    { environment: 'production' },
    site,
    { operation: 'put', name: 'API_TOKEN', value: 'stale-secret-value' }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, ['delete']);
});

test('runtime secret sync does not hide a put failure when a stale delete converges to the latest secret', async () => {
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
  await store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: site.id,
    siteSlug: site.slug,
    name: 'API_TOKEN',
    value: 'latest-secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });
  const lines = [];

  const result = await syncActiveWfpSecret(
    store,
    testEnv(store, {
      logRuntimeConfigFailure: (line) => lines.push(line),
      WFP_PROVIDER: {
        putSecret: async () => {
          throw Object.assign(new Error('SENSITIVE_PUT_NOT_FOUND'), { status: 404 });
        },
      },
    }),
    { environment: 'production' },
    site,
    { operation: 'delete', name: 'API_TOKEN' }
  );

  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.code, 'SECRET_ACTIVE_WORKER_SYNC_FAILED');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'secret_sync',
        environment: 'production',
        siteId: 'site_1',
        stage: 'provider_sync',
        reason: 'provider_request_failed',
        errorCode: 'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      },
    ]
  );
  assert.doesNotMatch(lines[0], /SENSITIVE|API_TOKEN|latest-secret-value/);
});

test('runtime provider sync passes the lease abort signal to vars and secret operations', async () => {
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
  const mutation = await store.mutateSiteVar({
    environment: 'production',
    siteId: site.id,
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com',
    actorId: 'usr_1',
  });
  await store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: site.id,
    siteSlug: site.slug,
    name: 'API_TOKEN',
    value: 'secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });
  const controller = new globalThis.AbortController();
  const signals = [];
  store.withRuntimeConfigLock = async (_environment, _siteId, callback) => callback({ signal: controller.signal });
  const environment = testEnv(store, {
    WFP_PROVIDER: {
      replacePlainTextBindings: async (input) => signals.push(input.signal),
      putSecret: async (input) => signals.push(input.signal),
    },
  });

  const varsResult = await syncActiveWfpPlainTextBindings(store, environment, { environment: 'production' }, site, mutation);
  const secretResult = await syncActiveWfpSecret(store, environment, { environment: 'production' }, site, {
    operation: 'put',
    name: 'API_TOKEN',
    value: 'secret-value',
  });

  assert.deepEqual(varsResult, { appliesTo: 'active_worker' });
  assert.equal(secretResult, null);
  assert.equal(signals.length, 2);
  assert.equal(
    signals.every((signal) => signal instanceof globalThis.AbortSignal),
    true
  );
  assert.notEqual(signals[0], controller.signal);
  assert.notEqual(signals[1], controller.signal);
});

test('runtime plain-text sync acquires the site lease before the runtime settings lock and re-reads the active Worker', async () => {
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

  const originalSiteLock = store.withSiteCommitLock.bind(store);
  const originalRuntimeLock = store.withRuntimeConfigLock.bind(store);
  let siteLockHeld = false;
  let siteLockCalls = 0;
  let runtimeLockCalls = 0;
  const workerNames = [];
  store.withSiteCommitLock = async (...args) => {
    siteLockCalls += 1;
    return originalSiteLock(
      args[0],
      args[1],
      async (lease) => {
        siteLockHeld = true;
        try {
          return await args[2](lease);
        } finally {
          siteLockHeld = false;
        }
      },
      args[3]
    );
  };
  store.withRuntimeConfigLock = async (...args) => {
    runtimeLockCalls += 1;
    assert.equal(siteLockHeld, true);
    return originalRuntimeLock(
      args[0],
      args[1],
      async (lock) => {
        assert.equal(siteLockHeld, true);
        return args[2](lock);
      },
      args[3]
    );
  };

  const environment = testEnv(store, {
    WFP_PROVIDER: {
      replacePlainTextBindings: async ({ workerName }) => workerNames.push(workerName),
    },
  });
  const result = await syncActiveWfpPlainTextBindings(store, environment, { environment: 'production' }, site, {
    vars: [{ name: 'API_BASE', value: 'https://api.example.com' }],
    generation: 1,
  });

  assert.deepEqual(result, { appliesTo: 'active_worker' });
  assert.equal(siteLockCalls, 1);
  assert.equal(runtimeLockCalls, 1);
  assert.deepEqual(workerNames, ['pages-v2-guide-ver-1']);
});

test('runtime vars mutations are idempotent and apply on the next deployment without an active Worker', async () => {
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
  const env = testEnv(store);
  const body = { name: 'FEATURE_FLAG', value: 'on' };

  const created = await worker.fetch(putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', body), env);
  const repeated = await worker.fetch(putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', body), env);
  const missingDelete = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', { name: 'MISSING_VAR' }),
    env
  );

  assert.deepEqual(await created.json(), {
    var: {
      site: 'guide',
      name: 'FEATURE_FLAG',
      revision: 1,
      updated: true,
      appliesTo: 'next_deployment',
    },
  });
  assert.deepEqual(await repeated.json(), {
    var: {
      site: 'guide',
      name: 'FEATURE_FLAG',
      revision: 1,
      updated: true,
      appliesTo: 'next_deployment',
    },
  });
  assert.deepEqual(await missingDelete.json(), {
    var: {
      site: 'guide',
      name: 'MISSING_VAR',
      deleted: true,
      appliesTo: 'next_deployment',
    },
  });
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).runtimeConfigGeneration, 1);
});

test('runtime vars use the next deployment for assets-only active versions', async () => {
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
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'FEATURE_FLAG',
      value: 'on',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        replacePlainTextBindings: async (input) => providerCalls.push(input),
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).var.appliesTo, 'next_deployment');
  assert.deepEqual(providerCalls, []);
});

test('runtime vars reject malformed bodies and do not expose stored values through GET', async () => {
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
  await store.mutateSiteVar({
    environment: 'production',
    siteId: 'site_1',
    operation: 'put',
    name: 'API_BASE',
    value: 'stored-private-value',
    actorId: 'usr_1',
  });
  const env = testEnv(store);
  const malformed = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER_USR_1}` },
      body: '{',
    }),
    env
  );
  const array = await worker.fetch(jsonMethodRequest('PUT', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', []), env);
  const missingValue = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', { name: 'API_BASE' }),
    env
  );
  const missingName = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {}),
    env
  );
  const get = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars'), env);
  const getText = await get.text();

  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  assert.equal(array.status, 400);
  assert.equal((await array.json()).error.code, 'INVALID_JSON');
  assert.equal(missingValue.status, 400);
  assert.equal((await missingValue.json()).error.code, 'RUNTIME_VAR_INVALID');
  assert.equal(missingName.status, 400);
  assert.equal((await missingName.json()).error.code, 'RUNTIME_VAR_INVALID');
  assert.equal(get.status, 405);
  assert.doesNotMatch(getText, /stored-private-value|API_BASE/);
});

test('runtime vars report active Worker provider failures after preserving the committed value', async () => {
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
  const lines = [];

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'API_BASE',
      value: 'provider-failure-private-value',
    }),
    testEnv(store, {
      logRuntimeConfigFailure: (line) => lines.push(line),
      WFP_PROVIDER: {
        replacePlainTextBindings: async () => {
          throw new Error('SENSITIVE_PROVIDER_VAR_ERROR');
        },
      },
    })
  );
  const text = await response.text();

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(text).error.code, 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED');
  assert.doesNotMatch(text, /provider-failure-private-value|SENSITIVE_PROVIDER_VAR_ERROR/);
  assert.equal((await store.listEnabledSiteVars('production', 'site_1'))[0].value, 'provider-failure-private-value');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      {
        event: 'pages_runtime_config_failure',
        operation: 'plain_text_sync',
        environment: 'production',
        siteId: 'site_1',
        stage: 'provider_sync',
        reason: 'provider_request_failed',
        errorCode: 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
      },
    ]
  );
  assert.doesNotMatch(lines[0], /private|SENSITIVE|API_BASE|guide/);
});

test('runtime vars return a conflict after three unstable active Worker synchronization attempts', async () => {
  const store = await createSeededStore();
  store.withRuntimeConfigLock = undefined;
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
  let attempt = 0;

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'API_BASE',
      value: 'unstable-private-value',
    }),
    testEnv(store, {
      WFP_PROVIDER: {
        replacePlainTextBindings: async () => {
          attempt += 1;
          await store.mutateSiteVar({
            environment: 'production',
            siteId: 'site_1',
            operation: 'put',
            name: `RACE_${attempt}`,
            value: String(attempt),
            actorId: 'usr_1',
          });
        },
      },
    })
  );
  const text = await response.text();

  assert.equal(attempt, 3);
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(text).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.doesNotMatch(text, /unstable-private-value/);
});

test('team publishers and admins can manage runtime vars while viewers are forbidden', async () => {
  const store = await createSeededStore();
  await store.createUser({ userId: 'usr_publisher', email: 'publisher@example.com', employeeStatus: 'active' });
  await store.createUser({ userId: 'usr_viewer', email: 'viewer@example.com', employeeStatus: 'active' });
  await seedCliLoginKey(store, 'usr_publisher', BEARER_USR_PUBLISHER);
  await seedCliLoginKey(store, 'usr_viewer', BEARER_USR_VIEWER);
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
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_viewer',
    role: 'viewer',
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
  const publisher = await worker.fetch(
    putJsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/team-guide/vars',
      {
        name: 'FEATURE_FLAG',
        value: 'on',
      },
      BEARER_USR_PUBLISHER
    ),
    testEnv(store)
  );
  const viewer = await worker.fetch(
    putJsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/team-guide/vars',
      {
        name: 'VIEWER_ATTEMPT',
        value: 'blocked',
      },
      BEARER_USR_VIEWER
    ),
    testEnv(store)
  );
  const admin = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/team-guide/vars', {
      name: 'FEATURE_FLAG',
    }),
    testEnv(store)
  );

  assert.equal(publisher.status, 200, await publisher.clone().text());
  assert.equal(viewer.status, 403);
  assert.equal((await viewer.json()).error.code, 'DEPLOY_FORBIDDEN');
  assert.equal(admin.status, 200, await admin.clone().text());
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_team'), []);
});

test('runtime vars enforce deploy scope and access key owner and site boundaries', async () => {
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
  await store.createSite({
    id: 'site_2',
    slug: 'other-guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other-guide.pages.xd.team',
  });
  const deployKey = await seedAccessKey(store, 'ak_deploy_vars', ['deploy:site']);
  const readKey = await seedAccessKey(store, 'ak_read_vars', ['read:site']);
  const wrongSiteKey = await seedAccessKey(store, 'ak_wrong_site_vars', ['deploy:site'], 'site_2');
  const ownerKey = await seedAccessKey(store, 'ak_owner_vars', ['deploy:site'], null);
  const requestWithKey = (key, body, method = 'PUT') =>
    jsonMethodRequest(method, 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', body, {
      Authorization: `Bearer ${key}`,
    });

  const deploy = await worker.fetch(requestWithKey(deployKey, { name: 'FEATURE_FLAG', value: 'on' }), testEnv(store));
  const readOnly = await worker.fetch(requestWithKey(readKey, { name: 'READ_ATTEMPT', value: 'blocked' }), testEnv(store));
  const wrongSite = await worker.fetch(
    requestWithKey(wrongSiteKey, { name: 'WRONG_SITE_ATTEMPT', value: 'blocked' }),
    testEnv(store)
  );
  const ownerWide = await worker.fetch(requestWithKey(ownerKey, { name: 'FEATURE_FLAG' }, 'DELETE'), testEnv(store));

  assert.equal(deploy.status, 200, await deploy.clone().text());
  assert.equal(readOnly.status, 403);
  assert.equal((await readOnly.json()).error.code, 'DEPLOY_FORBIDDEN');
  assert.equal(wrongSite.status, 404);
  assert.equal((await wrongSite.json()).error.code, 'SITE_NOT_FOUND');
  assert.equal(ownerWide.status, 200, await ownerWide.clone().text());
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), []);
});

test('public runtime vars accept long runtime var names without deriving record ids from them', async () => {
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
  const mutateSiteVar = store.mutateSiteVar.bind(store);
  store.mutateSiteVar = async (input) => {
    input.createId?.(input.name);
    return mutateSiteVar(input);
  };

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'CODEX_STAGING_VARS_DIAG_20260719_02',
      value: 'runtime-vars-diagnostic',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).var, {
    site: 'guide',
    name: 'CODEX_STAGING_VARS_DIAG_20260719_02',
    revision: 1,
    updated: true,
    appliesTo: 'next_deployment',
  });
});

test('runtime vars log one safe diagnostic for unexpected store failures', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'sensitive-slug',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'sensitive-slug.pages.xd.team',
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
    jsonMethodRequest('PUT', 'https://api.pages.xd.team/.xd-pages/api/sites/sensitive-slug/vars', {
      name: 'SENSITIVE_VAR_NAME',
      value: 'SENSITIVE_VAR_VALUE',
    }),
    testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) })
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
    siteId: 'site_1',
    stage: 'mutation_batch',
    reason: 'store_operation_failed',
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
  assert.doesNotMatch(lines[0], /sensitive|SENSITIVE|Authorization|Bearer|SQL/);
});

test('runtime vars log capability failures and isolate logger exceptions', async () => {
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
  store.mutateSiteVar = undefined;
  const lines = [];

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'FEATURE_FLAG',
      value: 'on',
    }),
    testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) })
  );
  const responseWithBrokenLogger = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'FEATURE_FLAG',
      value: 'on',
    }),
    testEnv(store, {
      logRuntimeConfigFailure() {
        throw new Error('LOGGER_FAILED');
      },
    })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'pages_runtime_config_failure',
    operation: 'var_put',
    environment: 'production',
    siteId: 'site_1',
    stage: 'capability_check',
    reason: 'capability_unavailable',
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
  assert.equal(responseWithBrokenLogger.status, 503);
  assert.deepEqual(await response.clone().json(), await responseWithBrokenLogger.json());
});

test('runtime vars map shared binding quotas and store revision conflicts to stable public errors', async () => {
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
  for (let index = 0; index < 64; index += 1) {
    const name = `SECRET_${String(index).padStart(2, '0')}`;
    store.siteSecrets.set(`production:site_1:${name}`, {
      id: `sec_${index}`,
      environment: 'production',
      siteId: 'site_1',
      name,
      value: `value-${index}`,
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    });
  }

  const lines = [];
  const environment = testEnv(store, { logRuntimeConfigFailure: (line) => lines.push(line) });
  const quota = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'FEATURE_FLAG',
      value: 'quota-private-value',
    }),
    environment
  );
  store.mutateSiteVar = async () => {
    throw new Error('SITE_VAR_REVISION_CONFLICT');
  };
  const conflict = await worker.fetch(
    jsonMethodRequest('DELETE', 'https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
      name: 'FEATURE_FLAG',
    }),
    environment
  );
  const quotaText = await quota.text();

  assert.equal(quota.status, 413);
  assert.equal(JSON.parse(quotaText).error.code, 'RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  assert.doesNotMatch(quotaText, /quota-private-value|value-\d/);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(lines, []);
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

test('regular ACL replacement uses the site lease and preserves public exposure in the snapshot', async () => {
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
  const initialRoute = await activateSite(store, site.id, { visibility: 'acl' });
  store.routes.get(initialRoute.id).exposure = 'public';
  store.sites.get(site.id).defaultExposure = 'public';
  const originalWithSiteCommitLock = store.withSiteCommitLock.bind(store);
  let lockCalls = 0;
  store.withSiteCommitLock = async (...args) => {
    lockCalls += 1;
    return originalWithSiteCommitLock(...args);
  };
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'email', subjectValue: 'reader@example.com' }],
    }),
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(lockCalls, 1);
  assert.equal(JSON.stringify(await response.clone().json()).includes('exposure'), false);
  const route = await store.getRouteBySiteId(site.id, 'production');
  assert.equal(route.policyVersion, initialRoute.policyVersion + 1);
  assert.equal(route.exposure, 'public');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.exposure, 'public');
  assert.deepEqual(snapshot.acl, [{ effect: 'allow', subjectType: 'email', subjectValue: 'reader@example.com' }]);
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

test('incremental ACL grants reject a merged collection above the platform limit', async () => {
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
    Array.from({ length: 200 }, (_, index) => ({
      id: `acl_${index}`,
      subjectType: 'email',
      subjectValue: `reader-${index}@example.com`,
      accessRole: 'viewer',
      effect: 'allow',
    })),
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  const route = await activateSite(store, site.id, { visibility: 'acl' });

  const response = await worker.fetch(
    jsonMethodRequest('POST', 'https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl/entries', {
      entries: [{ subjectType: 'email', subjectValue: 'overflow@example.com' }],
    }),
    testEnv(store, { ROUTE_SNAPSHOTS: createSnapshotStore() })
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ACL_ENTRIES_INVALID');
  assert.equal((await store.listSiteAclEntries(site.id)).length, 200);
  assert.equal((await store.getRouteBySiteId(site.id)).policyVersion, route.policyVersion);
});

test('allows deploy-capable access keys to read ACL entries for manageable sites', async () => {
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

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    (await response.json()).aclEntries.map(({ id, subjectType, subjectValue, effect, accessRole }) => ({
      id,
      subjectType,
      subjectValue,
      effect,
      accessRole,
    })),
    [
      {
        id: 'acl_1',
        subjectType: 'email',
        subjectValue: 'user@example.com',
        effect: 'allow',
        accessRole: 'viewer',
      },
    ]
  );
});

test('rejects read-only access keys from reading site ACL entries', async () => {
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
  const accessKey = await seedAccessKey(store, 'ak_read', ['read:site']);

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      Authorization: `Bearer ${accessKey}`,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SITE_POLICY_FORBIDDEN');
});

test('allows team deploy access keys to read ACL entries for their team sites', async () => {
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
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });
  await store.replaceSiteAclEntries(
    'site_team',
    [{ id: 'acl_team', subjectType: 'email', subjectValue: 'team@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  const accessKey = await seedAccessKey(store, 'ak_team', ['deploy:site'], null, {
    ownerType: 'team',
    ownerId: team.id,
  });

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_team/acl', {
      Authorization: `Bearer ${accessKey}`,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).aclEntries[0].subjectValue, 'team@example.com');
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
  assert.equal((await response.json()).error.code, 'ROUTE_POLICY_REPAIR_REQUIRED');
  assert.deepEqual(
    (await store.listSiteAclEntries('site_1')).map(({ id, subjectValue }) => ({ id, subjectValue })),
    [{ id: 'acl_existing', subjectValue: 'existing@example.com' }]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 4);
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
  let injectedRuntimeChange = false;

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'email', subjectValue: 'new@example.com' }],
    }),
    testEnv(store, {
      ROUTE_SNAPSHOTS: {
        put: async () => {
          if (!injectedRuntimeChange) {
            injectedRuntimeChange = true;
            await store.putSiteSecret({
              id: 'sec_1',
              environment: 'production',
              siteId: 'site_1',
              name: 'API_TOKEN',
              value: 'changed-during-acl-update',
              actorId: 'usr_1',
              updatedAt: '2026-06-15T00:00:02.000Z',
            });
          }
          throw new Error('snapshot write failed');
        },
      },
    })
  );
  const route = await store.getRouteBySiteId('site_1', 'production');

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_POLICY_REPAIR_REQUIRED');
  assert.deepEqual(
    (await store.listSiteAclEntries('site_1')).map(({ id, subjectValue }) => ({ id, subjectValue })),
    [{ id: 'acl_existing', subjectValue: 'existing@example.com' }]
  );
  assert.equal(route.policyVersion, previousRoute.policyVersion + 2);
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

function jsonRequest(url, body, token = BEARER_USR_1) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'CF-Connecting-IP': '10.1.2.3',
    },
    body: JSON.stringify(body),
  });
}

function patchJsonRequest(url, body, token = BEARER_USR_1) {
  return jsonMethodRequest('PATCH', url, body, {}, token);
}

function putJsonRequest(url, body, token = BEARER_USR_1) {
  return jsonMethodRequest('PUT', url, body, {}, token);
}

function jsonMethodRequest(method, url, body, headers = {}, token = BEARER_USR_1) {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'CF-Connecting-IP': '10.1.2.3',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authRequest(url, headers = {}, init = {}, token = BEARER_USR_1) {
  return new Request(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '10.1.2.3', ...headers },
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
  await seedCliLoginKey(store, 'usr_1', BEARER_USR_1);
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
      executionProvider: overrides.executionProvider,
      dispatchType: overrides.dispatchType,
      visibility: overrides.visibility || 'org',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
    'production'
  );
}

async function runRuntimeProviderSecretRace(operation) {
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
  const varMutation = await store.mutateSiteVar({
    environment: 'production',
    siteId: site.id,
    operation: 'put',
    name: 'API_BASE',
    value: 'https://api.example.com',
    actorId: 'usr_1',
  });
  await store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_secret_put',
    environment: 'production',
    siteId: site.id,
    siteSlug: site.slug,
    name: 'API_TOKEN',
    value: 'secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  });
  if (operation === 'delete') {
    await store.deleteSiteSecretWithAudit({
      auditId: 'aud_secret_delete',
      environment: 'production',
      siteId: site.id,
      siteSlug: site.slug,
      name: 'API_TOKEN',
      actorId: 'usr_1',
      actorType: 'user',
      routeId: 'route_1',
    });
  }

  let runtimeQueue = Promise.resolve();
  store.withRuntimeConfigLock = async (_environment, _siteId, callback) => {
    const previous = runtimeQueue;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    runtimeQueue = previous.then(() => gate);
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };

  let bindings = [
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    ...(operation === 'delete' ? [{ type: 'secret_text', name: 'API_TOKEN' }] : []),
  ];
  let notifyFirstSettingsGet;
  const firstSettingsGet = new Promise((resolve) => {
    notifyFirstSettingsGet = resolve;
  });
  let releaseFirstSettingsGet;
  const firstSettingsGetBlocked = new Promise((resolve) => {
    releaseFirstSettingsGet = resolve;
  });
  let settingsGetCount = 0;
  const environment = testEnv(store, {
    CF_ACCOUNT_ID: 'test-account',
    CF_API_TOKEN: 'test-token',
    WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname.endsWith('/settings')) {
        const snapshot = cloneBindings(bindings);
        settingsGetCount += 1;
        if (settingsGetCount === 1) {
          notifyFirstSettingsGet();
          await firstSettingsGetBlocked;
        }
        return cloudflareResult({ bindings: snapshot });
      }
      if (request.method === 'PATCH' && url.pathname.endsWith('/settings')) {
        const form = await request.formData();
        const settings = JSON.parse(await form.get('settings').text());
        bindings = cloneBindings(settings.bindings);
        return cloudflareResult({ id: 'pages-v2-guide-ver-1' });
      }
      if (request.method === 'PUT' && url.pathname.endsWith('/secrets')) {
        const secret = await request.json();
        bindings = [...bindings.filter((binding) => binding.name !== secret.name), { type: 'secret_text', name: secret.name }];
        return cloudflareResult({ id: secret.name });
      }
      if (request.method === 'DELETE' && url.pathname.endsWith('/secrets/API_TOKEN')) {
        bindings = bindings.filter((binding) => binding.name !== 'API_TOKEN');
        return cloudflareResult({ id: 'API_TOKEN' });
      }
      throw new Error(`Unexpected WFP request: ${request.method} ${url.pathname}`);
    },
  });
  const config = { environment: 'production' };
  const varSync = syncActiveWfpPlainTextBindings(store, environment, config, site, varMutation);
  await firstSettingsGet;
  const secretSync = syncActiveWfpSecret(store, environment, config, site, {
    operation,
    name: 'API_TOKEN',
    ...(operation === 'put' ? { value: 'secret-value' } : {}),
  });
  let secretCompleted = false;
  void secretSync.then(() => {
    secretCompleted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const interleaving = secretCompleted ? 'secret_completed' : 'secret_waiting_for_site';
  releaseFirstSettingsGet();
  const [varResult, secretResult] = await Promise.all([varSync, secretSync]);

  assert.deepEqual(varResult, { appliesTo: 'active_worker' });
  assert.equal(secretResult, null);
  return { interleaving, bindings };
}

function cloudflareResult(result) {
  return Response.json({ success: true, result });
}

function cloneBindings(bindings) {
  return JSON.parse(JSON.stringify(bindings));
}

function withoutSignal({ signal, ...input }) {
  void signal;
  return input;
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
    ...overrides,
  };
}
