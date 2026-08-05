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
      resourceCleanup: {
        pendingTasks: 0,
        failedTasks: 0,
        oldestPendingAt: null,
        oldestPendingAgeSeconds: null,
        orphanCandidates: null,
        v1Sites: null,
      },
      failedDeployments: [
        {
          id: 'dep_failed',
          siteId: 'site_console',
          siteSlug: 'console',
          owner: {
            type: 'team',
            id: 'team_console',
            email: null,
            displayName: 'Console Team',
            departmentPath: null,
            teamType: 'custom',
          },
          status: 'failed',
          source: 'cli',
          operation: 'publish',
          createdAt: '2026-07-02T00:00:00.000Z',
        },
      ],
    },
  });
});

test('admin dashboard exposes lightweight cleanup backlog counts without scanning external resources', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_pending',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-pending',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:00:00.000Z',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_failed',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-failed',
    cleanupReason: 'blue_green_previous_worker',
    status: 'failed',
    cleanupAfter: '2026-07-01T22:00:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/dashboard', { userId: 'usr_root', admin: true }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        listWorkers: async () => {
          throw new Error('dashboard must not scan WFP');
        },
      },
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => {
          throw new Error('dashboard must not scan v1 KV');
        },
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).dashboard.resourceCleanup, {
    pendingTasks: 1,
    failedTasks: 1,
    oldestPendingAt: '2026-07-01T23:00:00.000Z',
    oldestPendingAgeSeconds: 3600,
    orphanCandidates: null,
    v1Sites: null,
  });
});

test('admin worker orphan scan classifies managed WFP scripts without deciding deletion', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await seedTeamSite(store, { id: 'site_active', slug: 'active', teamId: 'team_console' });
  await activateSite(store, 'site_active', { workerName: 'pages-v2-active' });
  await seedTeamSite(store, { id: 'site_rollback', slug: 'rollback', teamId: 'team_console' });
  await store.createSiteVersion({
    id: 'ver_rollback',
    siteId: 'site_rollback',
    deploymentId: 'dep_rollback',
    workerName: 'pages-v2-rollback',
    runtime: 'wfp',
    artifactRef: 'wfp://test/pages-v2-rollback',
    contentHash: 'sha256:rollback',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  await seedTeamSite(store, { id: 'site_stale', slug: 'stale', teamId: 'team_console' });
  await store.createSiteVersion({
    id: 'ver_stale',
    siteId: 'site_stale',
    deploymentId: 'dep_stale',
    workerName: 'pages-v2-stale',
    runtime: 'wfp',
    artifactRef: 'wfp://test/pages-v2-stale',
    contentHash: 'sha256:stale',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'retired',
    createdBy: 'usr_root',
  });
  await seedTeamSite(store, { id: 'site_deleted', slug: 'deleted', teamId: 'team_console' });
  await store.createSiteVersion({
    id: 'ver_deleted',
    siteId: 'site_deleted',
    deploymentId: 'dep_deleted',
    workerName: 'pages-v2-deleted',
    runtime: 'wfp',
    artifactRef: 'wfp://test/pages-v2-deleted',
    contentHash: 'sha256:deleted',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  await store.deleteSite(
    'site_deleted',
    { deletedAt: '2026-07-01T00:00:00.000Z', reuseHoldUntil: '2026-07-01T00:05:00.000Z' },
    'production'
  );
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_pending',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-pending',
    cleanupReason: 'blue_green_previous_worker',
    status: 'failed',
    cleanupAfter: '2026-07-01T00:00:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/worker-orphan-scan', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        listWorkers: async () => ({
          workers: [
            'pages-v2-active',
            'pages-v2-rollback',
            'pages-v2-pending',
            'pages-v2-unknown',
            'pages-v2-deleted',
            'pages-v2-stale',
            'pages-v2-staging-ignore',
          ].map((name) => ({
            name,
            created_on: '2026-06-01T00:00:00.000Z',
            modified_on: '2026-06-02T00:00:00.000Z',
          })),
          completeness: 'complete',
          scannedCount: 7,
          namespaceScriptCount: 7,
        }),
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const scan = (await response.json()).scan;
  assert.equal(scan.completeness, 'complete');
  assert.equal(scan.scannedCount, 7);
  assert.equal(scan.namespaceScriptCount, 7);
  assert.deepEqual(scan.summary, {
    total: 6,
    referencedByActiveRoute: 1,
    rollbackEligibleVersion: 2,
    hasPendingCleanupTask: 1,
    orphanCandidates: 4,
    orphanReasons: {
      noD1Reference: 1,
      deletedSite: 1,
      stalePreviousVersion: 2,
    },
  });
  assert.deepEqual(
    scan.workers.map((item) => [
      item.name,
      item.referencedByActiveRoute,
      item.rollbackEligibleVersion,
      item.hasPendingCleanupTask,
      item.orphanCandidate,
      item.orphanReason,
    ]),
    [
      ['pages-v2-active', true, true, false, false, null],
      ['pages-v2-rollback', false, true, false, true, 'stale_previous_version'],
      ['pages-v2-pending', false, false, true, false, null],
      ['pages-v2-unknown', false, false, false, true, 'no_d1_reference'],
      ['pages-v2-deleted', false, false, false, true, 'deleted_site'],
      ['pages-v2-stale', false, false, false, true, 'stale_previous_version'],
    ]
  );
});

test('admin worker orphan scan rejects inventories above the configured safety limit', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/worker-orphan-scan', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store, {
      PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS: '1',
      WFP_RESOURCE_ADMIN_CLIENT: {
        listWorkers: async () => ({
          workers: [
            { name: 'pages-v2-one' },
            { name: 'pages-v2-two' },
          ],
          completeness: 'complete',
          scannedCount: 2,
          namespaceScriptCount: 2,
        }),
      },
    })
  );

  assert.equal(response.status, 413, await response.clone().text());
  assert.deepEqual(await response.json(), {
    error: {
      code: 'WORKER_ORPHAN_SCAN_LIMIT_EXCEEDED',
      message: 'Worker orphan scan exceeds the configured inventory limit.',
      action: 'Increase PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS or narrow the upstream inventory before retrying.',
    },
  });
});

test('admin v1 sites inventory strips token metadata and joins workers plus v2 migration candidates', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await seedTeamSite(store, { id: 'site_docs_v2', slug: 'docs', teamId: 'team_console' });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites', { userId: 'usr_root', admin: true }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          {
            name: 'docs',
            metadata: {
              url: 'https://docs.workers.xd.team',
              preset: 'spa',
              scriptName: 'pages-docs',
              ipRestrict: true,
              updatedAt: '2025-12-01T00:00:00.000Z',
              token: 'v1-owner-token-placeholder',
              siteUuid: 'internal-site-uuid',
            },
          },
          {
            name: 'legacy',
            metadata: {
              url: 'https://legacy.workers.xd.team',
              preset: 'worker',
              scriptName: 'pages-legacy',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          },
        ],
        listWorkers: async () => [
          { name: 'pages-docs', modified_on: '2026-01-02T00:00:00.000Z' },
          { name: 'pages-staging-docs', modified_on: '2026-01-03T00:00:00.000Z' },
          { name: 'pages-v2-docs-ver-1', modified_on: '2026-01-04T00:00:00.000Z' },
        ],
      },
    })
  );

  const text = await response.clone().text();
  assert.equal(response.status, 200, text);
  assert.doesNotMatch(text, /v1-owner-token-placeholder/);
  assert.doesNotMatch(text, /token/i);
  assert.doesNotMatch(text, /internal-site-uuid|siteUuid/i);
  assert.deepEqual(await response.json(), {
    sites: [
      {
        name: 'docs',
        url: 'https://docs.workers.xd.team',
        preset: 'spa',
        ipRestrict: true,
        updatedAt: '2025-12-01T00:00:00.000Z',
        workerName: 'pages-docs',
        workerModifiedOn: '2026-01-02T00:00:00.000Z',
        migratedCandidate: true,
        canRetire: true,
      },
      {
        name: 'legacy',
        url: 'https://legacy.workers.xd.team',
        preset: 'worker',
        ipRestrict: null,
        updatedAt: '2026-06-01T00:00:00.000Z',
        workerName: null,
        workerModifiedOn: null,
        migratedCandidate: false,
        canRetire: false,
        retireBlockedReason: 'worker_missing',
      },
    ],
    unregisteredWorkers: [],
  });
});

test('admin v1 sites inventory reports unknown and platform-reserved Workers separately', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites', { userId: 'usr_root', admin: true }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          { name: 'legacy', metadata: { scriptName: 'pages-legacy' } },
          { name: 'api', metadata: { scriptName: 'pages-api', url: 'https://api.workers.xd.team' } },
        ],
        listWorkers: async () => [
          { name: 'pages-legacy', modified_on: '2026-06-01T00:00:00.000Z' },
          { name: 'pages-orphan', modified_on: '2026-06-02T00:00:00.000Z' },
          { name: 'pages-api', modified_on: '2026-06-03T00:00:00.000Z' },
          { name: 'pages-console', modified_on: '2026-06-04T00:00:00.000Z' },
        ],
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.sites.find((site) => site.name === 'api'), {
    name: 'api',
    url: 'https://api.workers.xd.team',
    preset: null,
    ipRestrict: null,
    updatedAt: null,
    workerName: 'pages-api',
    workerModifiedOn: '2026-06-03T00:00:00.000Z',
    migratedCandidate: false,
    platformReserved: true,
    canRetire: false,
    retireBlockedReason: 'platform_reserved',
    classification: 'platform_reserved',
  });
  assert.deepEqual(body.unregisteredWorkers, [
    {
      workerName: 'pages-console',
      modifiedOn: '2026-06-04T00:00:00.000Z',
      classification: 'platform_reserved',
      platformReserved: true,
      canRetire: false,
      retireBlockedReason: 'platform_reserved',
    },
    {
      workerName: 'pages-orphan',
      modifiedOn: '2026-06-02T00:00:00.000Z',
      classification: 'unknown',
      platformReserved: false,
      canRetire: false,
      retireBlockedReason: 'unknown_worker',
    },
  ]);
});

test('admin can retire a v1 site only from KV metadata and releases its hostname claim', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'legacy.workers.xd.team',
    normalizedSlug: 'legacy',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:legacy',
    ownerRef: 'pages-legacy',
    source: 'v1_deploy',
    status: 'pending',
  });
  await store.confirmHostnameClaim({
    environment: 'production',
    hostname: 'legacy.workers.xd.team',
    ownerSystem: 'v1',
    ownerId: 'v1:production:legacy',
  });
  const actions = [];
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          {
            name: 'legacy',
            metadata: { scriptName: 'pages-legacy', url: 'https://legacy.workers.xd.team' },
          },
        ],
        deleteWorker: async ({ workerName }) => actions.push(['deleteWorker', workerName]),
        unbindRoute: async ({ hostname, expectedScriptName }) => actions.push(['unbindRoute', hostname, expectedScriptName]),
        deleteSite: async (name) => actions.push(['deleteSite', name]),
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(actions, [
    ['deleteWorker', 'pages-legacy'],
    ['unbindRoute', 'legacy.workers.xd.team', 'pages-legacy'],
    ['deleteSite', 'legacy'],
  ]);
  const claim = await store.getHostnameClaim('legacy.workers.xd.team');
  assert.equal(claim.status, 'held');
  assert.equal(claim.ownerSystem, 'v1');
  assert.equal(claim.releaseReason, 'site_retired');
  const audits = await store.listAuditEvents({ environment: 'production' });
  assert.ok(audits.some((event) => event.eventType === 'admin.v1_site_retire' && event.metadata?.stage === 'kv_delete'));
});

test('admin v1 retirement hard-refuses reserved Worker names before Cloudflare deletion', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  let deleteCalls = 0;
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/api', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [{ name: 'api', metadata: { scriptName: 'pages-api', url: 'https://api.workers.xd.team' } }],
        deleteWorker: async () => {
          deleteCalls += 1;
        },
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'V1_SITE_PLATFORM_RESERVED');
  assert.equal(deleteCalls, 0);
  const audits = await store.listAuditEvents({ environment: 'production' });
  assert.ok(
    audits.some(
      (event) =>
        event.eventType === 'admin.v1_site_retire' &&
        event.decision === 'deny' &&
        event.metadata?.stage === 'platform_reserved'
    )
  );
});

test('admin v1 retirement rejects malformed or cross-site script metadata before destructive calls', async () => {
  for (const scriptName of ['pages-../legacy', 'pages-other']) {
    const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
    await seedPlatformAdmin(store);
    const actions = [];
    const response = await worker.fetch(
      internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
        userId: 'usr_root',
        admin: true,
        method: 'DELETE',
      }),
      env(store, {
        V1_SITES_ADMIN_CLIENT: {
          listSites: async () => [
            { name: 'legacy', metadata: { scriptName, url: 'https://legacy.workers.xd.team' } },
          ],
          deleteWorker: async () => actions.push('worker'),
          unbindRoute: async () => actions.push('route'),
          deleteSite: async () => actions.push('kv'),
        },
      })
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).error.code, 'V1_SITE_SCRIPT_INVALID');
    assert.deepEqual(actions, []);
    const audits = await store.listAuditEvents({ environment: 'production' });
    assert.ok(
      audits.some(
        (event) =>
          event.eventType === 'admin.v1_site_retire' &&
          event.decision === 'deny' &&
          event.metadata?.stage === 'metadata_read'
      )
    );
  }
});

test('admin v1 retirement redacts invalid script metadata from deny audit', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const invalidWorkerName = 'pages-foreign-worker-placeholder';
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          { name: 'legacy', metadata: { scriptName: invalidWorkerName, url: 'https://legacy.workers.xd.team' } },
        ],
        deleteWorker: async () => assert.fail('invalid metadata must not reach deletion'),
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.doesNotMatch(await response.clone().text(), new RegExp(invalidWorkerName));
  assert.doesNotMatch(JSON.stringify(await store.listAuditEvents({ environment: 'production' })), new RegExp(invalidWorkerName));
});

test('admin v1 retirement refuses missing route configuration before inventory or deletion', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const requests = [];
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      CF_ACCOUNT_ID: 'account_1',
      CF_API_TOKEN: 'runtime-secret-placeholder',
      PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
      fetch: async (url, init = {}) => {
        requests.push({ url: String(url), method: init.method || 'GET' });
        return Response.json({ success: true, result: [] });
      },
    })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'V1_SITES_UNSUPPORTED');
  assert.deepEqual(requests, []);
});

test('admin v1 retirement retries safely when the Worker and hostname claim are already absent', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const actions = [];
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          { name: 'legacy', metadata: { scriptName: 'pages-legacy', url: 'https://legacy.workers.xd.team' } },
        ],
        deleteWorker: async () => {
          actions.push('worker');
          return null;
        },
        unbindRoute: async () => actions.push('route'),
        deleteSite: async () => actions.push('kv'),
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(actions, ['worker', 'route', 'kv']);
  assert.equal((await response.json()).result.status, 'retired');
});

for (const failure of [
  { action: 'worker', stage: 'worker_delete', code: 'V1_SITE_WORKER_DELETE_FAILED' },
  { action: 'route', stage: 'route_unbind', code: 'V1_SITE_ROUTE_UNBIND_FAILED' },
  { action: 'kv', stage: 'kv_delete', code: 'V1_SITE_KV_DELETE_FAILED' },
]) {
  test(`admin v1 retirement fails closed when an injected client throws an unnormalized 404 at ${failure.stage}`, async () => {
    const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
    await seedPlatformAdmin(store);
    const actions = [];
    const runAction = async (action) => {
      actions.push(action);
      if (action === failure.action) {
        const missing = new Error('unexpected client contract');
        missing.status = 404;
        throw missing;
      }
      return null;
    };
    const response = await worker.fetch(
      internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
        userId: 'usr_root',
        admin: true,
        method: 'DELETE',
      }),
      env(store, {
        V1_SITES_ADMIN_CLIENT: {
          listSites: async () => [
            { name: 'legacy', metadata: { scriptName: 'pages-legacy', url: 'https://legacy.workers.xd.team' } },
          ],
          deleteWorker: async () => runAction('worker'),
          unbindRoute: async () => runAction('route'),
          deleteSite: async () => runAction('kv'),
        },
      })
    );

    assert.equal(response.status, 502, await response.clone().text());
    const body = await response.json();
    assert.equal(body.error.code, failure.code);
    assert.equal(body.error.stage, failure.stage);
    assert.deepEqual(actions, ['worker', 'route', 'kv'].slice(0, actions.indexOf(failure.action) + 1));
  });
}

test('admin v1 retirement does not fail after a destructive step solely because stage audit writing fails', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const originalRecordAuditEvent = store.recordAuditEvent.bind(store);
  let auditWrites = 0;
  store.recordAuditEvent = async (input) => {
    auditWrites += 1;
    if (auditWrites > 1) throw new Error('AUDIT_WRITE_FAILED');
    return originalRecordAuditEvent(input);
  };
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          { name: 'legacy', metadata: { scriptName: 'pages-legacy', url: 'https://legacy.workers.xd.team' } },
        ],
        deleteWorker: async () => null,
        unbindRoute: async () => null,
        deleteSite: async () => null,
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).result.status, 'retired');
});

test('admin v1 retirement fails closed with a hostname claim release stage', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.acquireHostnameClaim({
    id: 'hcl_v1_legacy',
    environment: 'production',
    hostname: 'legacy.workers.xd.team',
    normalizedSlug: 'legacy',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:legacy',
    ownerRef: 'pages-legacy',
    status: 'active',
    source: 'v1',
  });
  store.releaseHostnameClaim = async () => {
    throw new Error('CLAIM_STORE_FAILED');
  };
  const actions = [];
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          { name: 'legacy', metadata: { scriptName: 'pages-legacy', url: 'https://legacy.workers.xd.team' } },
        ],
        deleteWorker: async () => actions.push('worker'),
        unbindRoute: async () => actions.push('route'),
        deleteSite: async () => actions.push('kv'),
      },
    })
  );

  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'V1_SITE_HOSTNAME_CLAIM_RELEASE_FAILED');
  assert.equal(body.error.stage, 'hostname_claim_release');
  assert.deepEqual(actions, ['worker', 'route', 'kv']);
});

test('admin v1 retirement reports the failing stage and stops before later destructive steps', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const actions = [];
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/legacy', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [
          { name: 'legacy', metadata: { scriptName: 'pages-legacy', url: 'https://legacy.workers.xd.team' } },
        ],
        deleteWorker: async () => {
          actions.push('worker_delete');
          throw new Error('cloudflare delete failed');
        },
        unbindRoute: async () => actions.push('route_unbind'),
        deleteSite: async () => actions.push('kv_delete'),
      },
    })
  );

  assert.equal(response.status, 502, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'V1_SITE_WORKER_DELETE_FAILED');
  assert.equal(body.error.stage, 'worker_delete');
  assert.deepEqual(actions, ['worker_delete']);
});

test('admin v1 bulk retirement validates and caps a batch at 100 sites', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/bulk-retire', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: { names: Array.from({ length: 101 }, (_, index) => `site-${index + 1}`) },
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => [],
      },
    })
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'V1_SITE_BATCH_TOO_LARGE');
});

test('admin v1 bulk retirement rejects a null JSON body without reading inventory', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  let inventoryReads = 0;
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites/bulk-retire', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: null,
    }),
    env(store, {
      V1_SITES_ADMIN_CLIENT: {
        listSites: async () => {
          inventoryReads += 1;
          return [];
        },
      },
    })
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'INVALID_JSON');
  assert.equal(inventoryReads, 0);
});

test('admin v1 sites inventory degrades when Cloudflare configuration is missing', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/v1-sites', { userId: 'usr_root', admin: true }),
    env(store)
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'V1_SITES_UNSUPPORTED');
});

test('admin orphan backfill revalidates managed names and creates only unreferenced cleanup tasks', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  store.listWorkerOrphanScanReferences = async () => ({
    activeRoutes: [
      {
        workerName: 'pages-v2-active',
        siteId: 'site_active',
        versionId: 'ver_active',
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
      },
    ],
    versions: [
      {
        id: 'ver_deleted',
        workerName: 'pages-v2-deleted',
        siteId: 'site_deleted',
        siteDeletedAt: '2026-07-01T00:00:00.000Z',
        artifactAvailability: 'active',
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'ver_rollback',
        workerName: 'pages-v2-rollback',
        siteId: 'site_rollback',
        siteDeletedAt: null,
        artifactAvailability: 'active',
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
        createdAt: '2026-07-01T01:00:00.000Z',
      },
      {
        id: 'ver_normal_slot',
        workerName: 'pages-v2-production-slot-1',
        siteId: 'site_slot',
        artifactAvailability: 'active',
        executionProvider: 'normal-worker-slot',
        dispatchType: null,
        createdAt: '2026-07-01T02:00:00.000Z',
      },
    ],
    cleanupTasks: [{ id: 'cln_existing', resourceRef: 'pages-v2-existing', status: 'failed' }],
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/worker-orphan-scan/backfill', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: {
        workerNames: [
          'pages-v2-orphan',
          'pages-v2-active',
          'pages-v2-existing',
          'pages-staging-nope',
          'pages-v2-deleted',
          'pages-v2-rollback',
          'pages-v2-production-slot-1',
        ],
      },
    }),
    env(store, {
      WFP_WORKER_CLEANUP_DRAIN_SECONDS: 300,
      WFP_RESOURCE_ADMIN_CLIENT: {
        listWorkers: async () => ({
          workers: [
            'pages-v2-orphan',
            'pages-v2-active',
            'pages-v2-existing',
            'pages-staging-nope',
            'pages-v2-deleted',
            'pages-v2-rollback',
            'pages-v2-production-slot-1',
          ].map((name) => ({ name })),
          completeness: 'complete',
          scannedCount: 7,
          namespaceScriptCount: 7,
        }),
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.results.map((item) => [item.workerName, item.status, item.reason || null]), [
    ['pages-v2-orphan', 'created', null],
    ['pages-v2-active', 'skipped', 'active_route_reference'],
    ['pages-v2-existing', 'skipped', 'cleanup_task_exists'],
    ['pages-staging-nope', 'skipped', 'worker_not_managed'],
    ['pages-v2-deleted', 'created', null],
    ['pages-v2-rollback', 'created', null],
    ['pages-v2-production-slot-1', 'skipped', 'worker_not_managed'],
  ]);
  const tasks = await store.listDeploymentResourceCleanupTasks({ environment: 'production' });
  assert.deepEqual(tasks.map((task) => [task.resourceRef, task.cleanupReason, task.siteId, task.versionId]), [
    ['pages-v2-orphan', 'orphan_backfill', null, null],
    ['pages-v2-deleted', 'site_deleted_backfill', 'site_deleted', 'ver_deleted'],
    ['pages-v2-rollback', 'orphan_backfill', 'site_rollback', 'ver_rollback'],
  ]);
  assert.equal(body.results.find((item) => item.workerName === 'pages-v2-rollback').rollbackEligible, true);
});

test('admin orphan backfill rejects an incomplete server-side inventory before creating tasks', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/worker-orphan-scan/backfill', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: { workerNames: ['pages-v2-orphan'] },
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        listWorkers: async () => ({
          workers: [{ name: 'pages-v2-orphan' }],
          completeness: 'incomplete',
          scannedCount: 1,
          namespaceScriptCount: 2,
        }),
      },
    })
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'WORKER_ORPHAN_SCAN_INCOMPLETE');
  assert.deepEqual(await store.listDeploymentResourceCleanupTasks({ environment: 'production' }), []);
});

test('admin cleanup run-due endpoint returns the existing runner summary', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_due',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-due',
    cleanupReason: 'orphan_backfill',
    cleanupAfter: '2026-07-01T23:00:00.000Z',
  });
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/run-due', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: { limit: 50 },
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: { deleteWorker: async () => null },
    })
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).summary, { processed: 1, succeeded: 1, failed: 0, skipped: 0 });
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

test('admin site deployment list exposes redacted failure diagnostics for review', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createTeam({
    id: 'team_console',
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    createdByUserId: 'usr_root',
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
    actorId: 'usr_root',
    actorUserId: 'usr_root',
    actorType: 'user',
    source: 'cli',
    operation: 'deploy',
    status: 'failed',
    idempotencyKey: 'diagnostics-1',
    requestHash: 'hash-diagnostics-1',
    errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
    errorMessage: 'Route snapshot write failed.',
    failureStage: 'write_route_snapshot',
    failureDiagnostics: {
      schemaVersion: 1,
      stage: 'write_route_snapshot',
      executionProvider: 'wfp',
      routePointerCommitted: false,
      previousRouteRestored: true,
      trafficImpact: 'old_version_retained',
      retryable: true,
      operatorAction: 'retry_deploy',
      cause: {
        code: 'ROUTE_SNAPSHOT_WRITE_FAILED',
        class: 'route_snapshot_store_error',
      },
    },
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_console/deployments', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    deployments: [
      {
        id: 'dep_failed',
        siteId: 'site_console',
        siteSlug: 'console',
        owner: {
          type: 'team',
          id: 'team_console',
          email: null,
          displayName: 'Console Team',
          departmentPath: null,
          teamType: 'custom',
        },
        status: 'failed',
        source: 'cli',
        operation: 'deploy',
        errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
        errorMessage: 'Route snapshot write failed.',
        failureStage: 'write_route_snapshot',
        failureDiagnostics: {
          schemaVersion: 1,
          stage: 'write_route_snapshot',
          executionProvider: 'wfp',
          routePointerCommitted: false,
          previousRouteRestored: true,
          trafficImpact: 'old_version_retained',
          retryable: true,
          operatorAction: 'retry_deploy',
          cause: {
            code: 'ROUTE_SNAPSHOT_WRITE_FAILED',
            class: 'route_snapshot_store_error',
          },
        },
        createdAt: '2026-07-02T00:00:00.000Z',
      },
    ],
  });
});

test('admin users can be searched by persisted profile fields', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await seedConsoleUser(store, 'usr_target', { realname: '目标用户', email: 'target@example.com' });
  await seedConsoleUser(store, 'usr_other', { realname: '其他用户', email: 'other@example.com' });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/users?query=%E7%9B%AE%E6%A0%87', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.pagination, { total: 1, limit: 50, offset: 0 });
  assert.deepEqual(
    body.users.map((user) => user.id),
    ['usr_target']
  );
});

test('admin users list applies the default limit without a search query', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index).padStart(2, '0');
    await seedConsoleUser(store, `usr_${suffix}`, { email: `user-${suffix}@example.com` });
  }

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/users', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.users.length, 50);
  assert.deepEqual(body.pagination, { total: 56, limit: 50, offset: 0 });
  assert.equal(body.users[0].id, 'usr_root');
  assert.equal(body.users.at(-1).id, 'usr_48');
});

test('admin users list supports sanitized pagination and server-side filters', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await seedConsoleUser(store, 'usr_admin_1', { email: 'admin-1@example.com' });
  await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_admin_1',
    grantedByUserId: 'usr_root',
    grantReason: 'test',
  });
  await seedConsoleUser(store, 'usr_disabled', { email: 'disabled@example.com', employeeStatus: 'disabled' });
  await seedConsoleUser(store, 'usr_active_2', { email: 'active-2@example.com' });

  const page = await worker.fetch(
    internalConsoleRequest(
      '/.xd-pages/api/console/admin/users?limit=bogus&offset=-4&admin=admin&status=active',
      { userId: 'usr_root', admin: true }
    ),
    env(store)
  );
  assert.equal(page.status, 200, await page.clone().text());
  const pageBody = await page.json();
  assert.deepEqual(pageBody.users.map((user) => user.id), ['usr_admin_1', 'usr_root']);
  assert.deepEqual(pageBody.pagination, { total: 2, limit: 50, offset: 0 });

  const outOfRange = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/users?limit=1&offset=99', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );
  assert.equal(outOfRange.status, 200, await outOfRange.clone().text());
  const outOfRangeBody = await outOfRange.json();
  assert.deepEqual(outOfRangeBody.users, []);
  assert.deepEqual(outOfRangeBody.pagination, { total: 4, limit: 1, offset: 99 });
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
  assert.equal(movedMember.departmentPath, source.departmentPath);
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

test('admin team list defaults to active teams and keeps merged teams behind an explicit filter', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const source = {
    id: 'team_department_legacy_leaf',
    environment: 'production',
    name: '平台支撑部',
    description: null,
    teamType: 'department',
    departmentPath: '心动/发行服务/平台支撑部/技术/Web',
    status: 'active',
    createdByType: 'system',
    createdByUserId: null,
    mergedIntoTeamId: null,
    mergedAt: null,
    mergedByUserId: null,
    mergeReason: null,
    deletedAt: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
  store.teams.set(source.id, source);
  const target = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: '心动/发行服务/平台支撑部',
  });
  await store.mergeDepartmentTeams({
    sourceTeamId: source.id,
    targetTeamId: target.id,
    actorUserId: 'usr_root',
    reason: 'canonicalize department',
    environment: 'production',
  });

  const defaultList = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );
  const mergedList = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams?status=merged', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );

  assert.equal(defaultList.status, 200, await defaultList.clone().text());
  assert.deepEqual(
    (await defaultList.json()).teams.map((team) => [team.id, team.status]),
    [[target.id, 'active']]
  );
  assert.equal(mergedList.status, 200, await mergedList.clone().text());
  assert.deepEqual(
    (await mergedList.json()).teams.map((team) => [team.id, team.status, team.mergedIntoTeamId]),
    [[source.id, 'merged', target.id]]
  );
});

test('admin department team merge cannot mutate teams from another environment', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.grantPlatformAdmin({
    environment: 'staging',
    userId: 'usr_root',
    grantedByUserId: 'usr_bootstrap',
    grantReason: 'test',
  });
  const source = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: 'XD/Old/Web',
  });
  const target = await store.findOrCreateDepartmentTeam({
    environment: 'production',
    departmentPath: 'XD/New/Web',
  });
  await seedTeamSite(store, {
    id: 'site_old',
    slug: 'old-site',
    teamId: source.id,
  });

  const response = await worker.fetch(
    internalConsoleRequest(`/.xd-pages/api/console/admin/teams/${encodeURIComponent(source.id)}/merge`, {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: {
        targetTeamId: target.id,
        reason: 'staging should not touch production',
      },
    }),
    env(store, { PAGES_ENV: 'staging' })
  );

  assert.equal(response.status, 404, await response.clone().text());
  assert.equal((await response.json()).error.code, 'TEAM_NOT_FOUND');
  assert.equal((await store.getSite('site_old')).ownerId, source.id);
  assert.equal((await store.getTeam(source.id)).status, 'active');
  assert.equal(
    (await store.listAuditEvents({ environment: 'production' })).some(
      (event) => event.eventType === 'admin.department_team.merge'
    ),
    false
  );
});

test('admin normal workers list classifies idle and active legacy workers', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createWorkerSlot({
    id: 'slot_production_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_production_003',
    environment: 'production',
    slotNumber: 3,
    workerName: 'pages-v2-production-slot-003',
    bindingName: 'SITE_SLOT_003',
    status: 'assigned',
    assignedSiteId: 'site_orphaned',
    assignedRouteId: 'route_orphaned',
    assignedVersionId: 'ver_orphaned',
    assignedAt: '2026-06-17T12:00:00.000Z',
  });
  await seedActiveNormalWorkerSite(store);

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers', { userId: 'usr_root', admin: true }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    workers: [
      {
        id: 'slot_production_001',
        environment: 'production',
        slotNumber: 1,
        workerName: 'pages-v2-production-slot-001',
        bindingName: 'SITE_SLOT_001',
        status: 'available',
        lifecycle: 'idle',
        canDelete: true,
        activeRoute: null,
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
      {
        id: 'slot_production_003',
        environment: 'production',
        slotNumber: 3,
        workerName: 'pages-v2-production-slot-003',
        bindingName: 'SITE_SLOT_003',
        status: 'assigned',
        lifecycle: 'idle',
        canDelete: true,
        activeRoute: null,
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
      {
        id: 'slot_production_007',
        environment: 'production',
        slotNumber: 7,
        workerName: 'pages-v2-production-slot-007',
        bindingName: 'SITE_SLOT_007',
        status: 'assigned',
        lifecycle: 'active',
        canDelete: false,
        activeRoute: {
          siteId: 'site_normal_active',
          routeId: 'route_site_normal_active',
          activeVersionId: 'ver_site_normal_active',
          hostname: 'normal-active.pages.xd.team',
        },
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
    ],
  });
});

test('admin can retire an idle normal worker but cannot delete an active one', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await store.createWorkerSlot({
    id: 'slot_production_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });
  await seedActiveNormalWorkerSite(store);

  const retired = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/slot_production_001', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: { reason: 'legacy drain' },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => {
          deletedWorkers.push(workerName);
        },
      },
    })
  );
  const active = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/slot_production_007', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: { reason: 'legacy drain' },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => {
          deletedWorkers.push(workerName);
        },
      },
    })
  );

  assert.equal(retired.status, 200, await retired.clone().text());
  assert.equal((await retired.json()).worker.status, 'retired');
  assert.equal((await store.getWorkerSlot('slot_production_001')).status, 'retired');
  assert.deepEqual(deletedWorkers, ['pages-v2-production-slot-001']);
  assert.equal(active.status, 409, await active.clone().text());
  assert.equal((await active.json()).error.code, 'NORMAL_WORKER_ACTIVE');
  assert.equal((await store.getWorkerSlot('slot_production_007')).status, 'assigned');
});

test('admin can bulk retire idle and orphaned assigned normal workers', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await store.createWorkerSlot({
    id: 'slot_production_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_production_003',
    environment: 'production',
    slotNumber: 3,
    workerName: 'pages-v2-production-slot-003',
    bindingName: 'SITE_SLOT_003',
    status: 'assigned',
    assignedSiteId: 'site_orphaned',
    assignedRouteId: 'route_orphaned',
    assignedVersionId: 'ver_orphaned',
    assignedAt: '2026-06-17T12:00:00.000Z',
  });
  await seedActiveNormalWorkerSite(store);

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/bulk-delete', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: {
        ids: ['slot_production_001', 'slot_production_003', 'slot_production_007'],
        reason: 'legacy drain batch',
      },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => {
          deletedWorkers.push(workerName);
        },
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.summary, { requested: 3, retired: 2, pending: 0, failed: 1 });
  assert.deepEqual(
    body.results.map((result) => [result.id, result.status, result.error?.code || null]),
    [
      ['slot_production_001', 'retired', null],
      ['slot_production_003', 'retired', null],
      ['slot_production_007', 'failed', 'NORMAL_WORKER_ACTIVE'],
    ]
  );
  assert.deepEqual(deletedWorkers, ['pages-v2-production-slot-001', 'pages-v2-production-slot-003']);
  assert.equal((await store.getWorkerSlot('slot_production_001')).status, 'retired');
  assert.equal((await store.getWorkerSlot('slot_production_003')).status, 'retired');
  assert.equal((await store.getWorkerSlot('slot_production_007')).status, 'assigned');
});

test('admin bulk normal worker delete reports invalid id items clearly', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/bulk-delete', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: { ids: ['slot_production_001', ''] },
    }),
    env(store)
  );

  assert.equal(response.status, 400, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'NORMAL_WORKER_IDS_INVALID');
  assert.equal(body.error.action, 'Each id must be a non-empty string.');
});

test('admin bulk normal worker delete processes workers with bounded concurrency', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const ids = [];
  const deletedWorkers = [];
  let activeDeletes = 0;
  let maxActiveDeletes = 0;
  await seedPlatformAdmin(store);

  for (let index = 1; index <= 6; index += 1) {
    const suffix = String(index).padStart(3, '0');
    ids.push(`slot_production_${suffix}`);
    await store.createWorkerSlot({
      id: `slot_production_${suffix}`,
      environment: 'production',
      slotNumber: index,
      workerName: `pages-v2-production-slot-${suffix}`,
      bindingName: `SITE_SLOT_${suffix}`,
      status: 'available',
    });
  }

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/bulk-delete', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: { ids },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => {
          activeDeletes += 1;
          maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
          deletedWorkers.push(workerName);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeDeletes -= 1;
        },
      },
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).summary, {
    requested: 6,
    retired: 6,
    pending: 0,
    failed: 0,
  });
  assert.equal(deletedWorkers.length, 6);
  assert.ok(maxActiveDeletes > 1, `expected concurrent deletes, got ${maxActiveDeletes}`);
  assert.ok(maxActiveDeletes <= 5, `expected at most 5 concurrent deletes, got ${maxActiveDeletes}`);
});

test('admin reports inconsistent normal worker state when Cloudflare delete succeeds but D1 retire is blocked', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await store.createWorkerSlot({
    id: 'slot_production_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });
  store.retireIdleNormalWorker = async () => null;

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/slot_production_001', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: { reason: 'legacy drain' },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => {
          deletedWorkers.push(workerName);
        },
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'NORMAL_WORKER_STATE_INCONSISTENT');
  assert.match(body.error.action, /Retry deletion/);
  assert.deepEqual(deletedWorkers, ['pages-v2-production-slot-001']);
  assert.equal((await store.getWorkerSlot('slot_production_001')).status, 'available');
});

test('admin marks idle normal worker delete pending when Cloudflare deletion is blocked', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await store.createWorkerSlot({
    id: 'slot_production_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });

  const pending = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/slot_production_001', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: { reason: 'legacy drain' },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => {
          deletedWorkers.push(workerName);
          const error = new Error('stale service binding');
          error.code = 'NORMAL_WORKER_DELETE_BLOCKED';
          throw error;
        },
      },
    })
  );
  assert.equal(pending.status, 202, await pending.clone().text());
  const pendingBody = await pending.json();
  assert.equal(pendingBody.warning.code, 'NORMAL_WORKER_DELETE_PENDING');
  assert.equal(pendingBody.worker.status, 'delete_pending');
  assert.equal(pendingBody.worker.canDelete, true);
  assert.equal((await store.getWorkerSlot('slot_production_001')).status, 'delete_pending');

  const retry = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/slot_production_001', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: { reason: 'legacy drain retry' },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => {
          deletedWorkers.push(workerName);
        },
      },
    })
  );

  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await retry.json()).worker.status, 'retired');
  assert.equal((await store.getWorkerSlot('slot_production_001')).status, 'retired');
  assert.deepEqual(deletedWorkers, ['pages-v2-production-slot-001', 'pages-v2-production-slot-001']);
});

test('admin does not mark normal worker delete pending for generic Cloudflare failures', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createWorkerSlot({
    id: 'slot_production_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });

  const failed = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/slot_production_001', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: { reason: 'legacy drain' },
    }),
    env(store, {
      NORMAL_WORKER_ADMIN_CLIENT: {
        deleteWorker: async () => {
          throw new Error('Cloudflare token rejected');
        },
      },
    })
  );

  assert.equal(failed.status, 502, await failed.clone().text());
  assert.equal((await failed.json()).error.code, 'NORMAL_WORKER_DELETE_FAILED');
  assert.equal((await store.getWorkerSlot('slot_production_001')).status, 'available');
});

test('admin marks idle normal worker delete pending for Cloudflare conflict responses', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createWorkerSlot({
    id: 'slot_production_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });

  const pending = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/normal-workers/slot_production_001', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: { reason: 'legacy drain' },
    }),
    env(store, {
      CF_ACCOUNT_ID: 'dummy-account',
      CF_API_TOKEN: 'dummy-token',
      fetch: async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: 'script is still bound' }] }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
  );

  assert.equal(pending.status, 202, await pending.clone().text());
  assert.equal((await pending.json()).warning.code, 'NORMAL_WORKER_DELETE_PENDING');
  assert.equal((await store.getWorkerSlot('slot_production_001')).status, 'delete_pending');
});

test('admin can review and run WFP cleanup tasks after the drain window', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await seedTeamSite(store, {
    id: 'site_console',
    slug: 'console',
    teamId: 'team_console',
  });
  await store.createSiteVersion({
    id: 'ver_old',
    siteId: 'site_console',
    deploymentId: 'dep_old',
    workerName: 'pages-v2-console-ver-old',
    runtime: 'worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-console-ver-old',
    contentHash: 'sha256:old',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_1',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-console-ver-old',
    siteId: 'site_console',
    versionId: 'ver_old',
    deploymentId: 'dep_new',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const list = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );
  const run = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_1/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  assert.equal(list.status, 200, await list.clone().text());
  assert.deepEqual(
    (await list.json()).tasks.map((task) => [task.id, task.status, task.canRun]),
    [['cln_1', 'pending', true]]
  );
  assert.equal(run.status, 200, await run.clone().text());
  assert.deepEqual(await run.json(), {
    task: {
      id: 'cln_1',
      environment: 'production',
      resourceType: 'wfp_user_worker',
      resourceRef: 'pages-v2-console-ver-old',
      siteId: 'site_console',
      versionId: 'ver_old',
      deploymentId: 'dep_new',
      cleanupReason: 'blue_green_previous_worker',
      status: 'succeeded',
      cleanupAfter: '2026-07-01T23:59:00.000Z',
      attemptCount: 1,
      lastErrorCode: null,
      lastErrorMessage: null,
      lockedUntil: null,
      canRun: false,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
  });
  assert.deepEqual(deletedWorkers, ['pages-v2-console-ver-old']);
  assert.equal((await store.getSiteVersion('ver_old')).artifactAvailability, 'retired');
  const audits = await store.listAuditEvents({ environment: 'production' });
  assert.ok(
    audits.some(
      (event) =>
        event.eventType === 'admin.cleanup_run' &&
        event.actorUserId === 'usr_root' &&
        event.metadata?.taskId === 'cln_1' &&
        event.metadata?.resourceRef === 'pages-v2-console-ver-old' &&
        event.metadata?.result === 'succeeded'
    )
  );
});

test('admin WFP cleanup deletes user worker through dispatch namespace API', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const requests = [];
  await seedPlatformAdmin(store);
  await seedTeamSite(store, {
    id: 'site_console',
    slug: 'console',
    teamId: 'team_console',
  });
  await store.createSiteVersion({
    id: 'ver_old',
    siteId: 'site_console',
    deploymentId: 'dep_old',
    workerName: 'pages-v2-console-ver-old',
    runtime: 'worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-console-ver-old',
    contentHash: 'sha256:old',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_1',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-console-ver-old',
    siteId: 'site_console',
    versionId: 'ver_old',
    deploymentId: 'dep_new',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_1/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      CF_ACCOUNT_ID: 'account_1',
      CF_API_TOKEN: 'token_1',
      WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
      fetch: async (request) => {
        requests.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get('Authorization'),
        });
        return new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    })
  );

  const expectedUrl =
    'https://api.cloudflare.com/client/v4/accounts/account_1/workers/dispatch/namespaces/' +
    'xd-cell-workers-production/scripts/pages-v2-console-ver-old';
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(requests, [
    {
      url: expectedUrl,
      method: 'DELETE',
      authorization: 'Bearer token_1',
    },
  ]);
});

test('admin WFP cleanup refuses workers still referenced by active routes', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await seedTeamSite(store, {
    id: 'site_console',
    slug: 'console',
    teamId: 'team_console',
  });
  await activateSite(store, 'site_console', { workerName: 'pages-v2-console-ver-active' });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_active',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-console-ver-active',
    siteId: 'site_console',
    versionId: 'ver_site_console',
    deploymentId: 'dep_new',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_active/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_ACTIVE');
  assert.deepEqual(deletedWorkers, []);
  assert.equal((await store.getDeploymentResourceCleanupTask('cln_active', 'production')).status, 'pending');
  const audits = await store.listAuditEvents({ environment: 'production' });
  assert.ok(
    audits.some(
      (event) =>
        event.eventType === 'admin.cleanup_run' &&
        event.metadata?.taskId === 'cln_active' &&
        event.metadata?.resourceRef === 'pages-v2-console-ver-active' &&
        event.metadata?.result === 'CLEANUP_RESOURCE_ACTIVE'
    )
  );
});

test('admin WFP cleanup rechecks active route after taking the cleanup lock', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await seedTeamSite(store, {
    id: 'site_console',
    slug: 'console',
    teamId: 'team_console',
  });
  await store.createSiteVersion({
    id: 'ver_old',
    siteId: 'site_console',
    deploymentId: 'dep_old',
    workerName: 'pages-v2-console-ver-old',
    runtime: 'worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-console-ver-old',
    contentHash: 'sha256:old',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_race',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-console-ver-old',
    siteId: 'site_console',
    versionId: 'ver_old',
    deploymentId: 'dep_new',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });
  const originalMarkRunning = store.markDeploymentResourceCleanupRunning.bind(store);
  store.markDeploymentResourceCleanupRunning = async (...args) => {
    const task = await originalMarkRunning(...args);
    await store.activateSiteVersion(
      'site_console',
      {
        activeVersionId: 'ver_old',
        workerName: 'pages-v2-console-ver-old',
        runtime: 'worker',
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
        visibility: 'org',
        updatedAt: '2026-07-02T00:00:01.000Z',
      },
      'production'
    );
    return task;
  };

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_race/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  const task = await store.getDeploymentResourceCleanupTask('cln_race', 'production');
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_ACTIVE');
  assert.deepEqual(deletedWorkers, []);
  assert.equal(task.status, 'failed');
  assert.equal(task.lastErrorCode, 'CLEANUP_RESOURCE_ACTIVE');
  assert.equal((await store.getSiteVersion('ver_old')).artifactAvailability, 'active');
});

test('admin WFP cleanup refuses staging-prefixed workers in production', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_staging_prefix',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-staging-console-ver-old',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_staging_prefix/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_UNSUPPORTED');
  assert.deepEqual(deletedWorkers, []);
  assert.equal((await store.getDeploymentResourceCleanupTask('cln_staging_prefix', 'production')).status, 'pending');
});

test('admin WFP cleanup audits an unexpected validation failure', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_validation_failure',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-orphan-worker',
    cleanupReason: 'orphan_backfill',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });
  store.findActiveRouteByWorkerResource = async () => {
    throw new Error('D1_READ_FAILED');
  };

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_validation_failure/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async () => assert.fail('cleanup must fail before Cloudflare deletion'),
      },
    })
  );

  assert.equal(response.status, 500, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_TASK_FAILED');
  const audits = await store.listAuditEvents({ environment: 'production' });
  assert.ok(
    audits.some(
      (event) =>
        event.eventType === 'admin.cleanup_run' &&
        event.metadata?.taskId === 'cln_validation_failure' &&
        event.metadata?.outcome === 'failed' &&
        event.metadata?.result === 'CLEANUP_TASK_FAILED'
    )
  );
});

test('admin WFP cleanup audits a task lookup failure', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  store.getDeploymentResourceCleanupTask = async () => {
    throw new Error('D1_READ_FAILED');
  };

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_lookup_failure/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store)
  );

  assert.equal(response.status, 500, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_TASK_FAILED');
  const audits = await store.listAuditEvents({ environment: 'production' });
  assert.ok(
    audits.some(
      (event) =>
        event.eventType === 'admin.cleanup_run' &&
        event.metadata?.taskId === 'cln_lookup_failure' &&
        event.metadata?.resourceRef === null &&
        event.metadata?.outcome === 'failed'
    )
  );
});

test('admin WFP cleanup refuses normal Worker slot names before Cloudflare deletion', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_normal_slot',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-production-slot-1',
    cleanupReason: 'orphan_backfill',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_normal_slot/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_UNSUPPORTED');
  assert.deepEqual(deletedWorkers, []);
});

test('admin WFP cleanup refuses D1 versions owned by the normal Worker provider', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await seedTeamSite(store, { id: 'site_normal', slug: 'normal', teamId: 'team_console' });
  await store.createSiteVersion({
    id: 'ver_normal',
    siteId: 'site_normal',
    deploymentId: 'dep_normal',
    workerName: 'pages-v2-normal-provider-record',
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    dispatchType: null,
    artifactRef: 'slot://test/pages-v2-normal-provider-record',
    contentHash: 'sha256:normal',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_normal_record',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-normal-provider-record',
    siteId: 'site_normal',
    versionId: 'ver_normal',
    cleanupReason: 'orphan_backfill',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_normal_record/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_UNSUPPORTED');
  assert.deepEqual(deletedWorkers, []);
});

test('admin WFP cleanup refuses pointerless tasks when D1 has a normal-provider record', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await seedTeamSite(store, { id: 'site_normal_pointerless', slug: 'normal-pointerless', teamId: 'team_console' });
  await store.createSiteVersion({
    id: 'ver_normal_pointerless',
    siteId: 'site_normal_pointerless',
    deploymentId: 'dep_normal_pointerless',
    workerName: 'pages-v2-normal-provider-pointerless',
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'slot://test/pages-v2-normal-provider-pointerless',
    contentHash: 'sha256:normal-pointerless',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_normal_pointerless',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-normal-provider-pointerless',
    siteId: null,
    versionId: null,
    cleanupReason: 'orphan_backfill',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_normal_pointerless/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_UNSUPPORTED');
  assert.deepEqual(deletedWorkers, []);
});

test('admin WFP cleanup fails closed for pointerless tasks with an orphaned version ownership record', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const deletedWorkers = [];
  await seedPlatformAdmin(store);
  await seedTeamSite(store, { id: 'site_orphaned_version', slug: 'orphaned-version', teamId: 'team_console' });
  await store.createSiteVersion({
    id: 'ver_orphaned_ownership',
    siteId: 'site_orphaned_version',
    deploymentId: 'dep_orphaned_ownership',
    workerName: 'pages-v2-orphaned-ownership',
    runtime: 'worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-orphaned-ownership',
    contentHash: 'sha256:orphaned-ownership',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_root',
  });
  store.sites.delete('site_orphaned_version');
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_orphaned_ownership',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-orphaned-ownership',
    siteId: null,
    versionId: null,
    cleanupReason: 'orphan_backfill',
    status: 'pending',
    cleanupAfter: '2026-07-01T23:59:00.000Z',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/deployment-cleanups/cln_orphaned_ownership/run', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
    }),
    env(store, {
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_UNSUPPORTED');
  assert.deepEqual(deletedWorkers, []);
});

for (const ownershipKind of ['route', 'version']) {
  test(`admin WFP cleanup refuses pointerless tasks with cross-environment ${ownershipKind} ownership`, async () => {
    const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
    const deletedWorkers = [];
    const workerName = `pages-v2-cross-environment-${ownershipKind}`;
    const siteId = `site_cross_environment_${ownershipKind}`;
    const routeId = `route_cross_environment_${ownershipKind}`;
    await seedPlatformAdmin(store);
    await store.createSite({
      id: siteId,
      slug: `cross-environment-${ownershipKind}`,
      ownerUserId: 'usr_root',
      ownerType: 'user',
      ownerId: 'usr_root',
      siteUuid: `uuid_${siteId}`,
      defaultVisibility: 'internal',
      environment: 'staging',
      routeId,
      hostname: `cross-environment-${ownershipKind}-staging.workers.xd.team`,
    });
    if (ownershipKind === 'route') {
      Object.assign(store.routes.get(routeId), {
        workerName,
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
        routeStatus: 'active',
      });
    } else {
      await store.createSiteVersion({
        id: `ver_cross_environment_${ownershipKind}`,
        siteId,
        deploymentId: `dep_cross_environment_${ownershipKind}`,
        workerName,
        runtime: 'worker',
        executionProvider: 'wfp',
        dispatchType: 'dispatch-namespace',
        artifactRef: `wfp://test/${workerName}`,
        contentHash: `sha256:cross-environment-${ownershipKind}`,
        deploymentShape: 'worker-only',
        requestedFallback: 'auto',
        resolvedFallback: null,
        routingMode: 'worker-only',
        artifactAvailability: 'active',
        createdBy: 'usr_root',
      });
    }
    await store.createDeploymentResourceCleanupTask({
      id: `cln_cross_environment_${ownershipKind}`,
      environment: 'production',
      resourceType: 'wfp_user_worker',
      resourceRef: workerName,
      siteId: null,
      versionId: null,
      cleanupReason: 'orphan_backfill',
      status: 'pending',
      cleanupAfter: '2026-07-01T23:59:00.000Z',
    });

    const response = await worker.fetch(
      internalConsoleRequest(
        `/.xd-pages/api/console/admin/deployment-cleanups/cln_cross_environment_${ownershipKind}/run`,
        { userId: 'usr_root', admin: true, method: 'POST' }
      ),
      env(store, {
        WFP_RESOURCE_ADMIN_CLIENT: {
          deleteWorker: async ({ workerName: deletedWorkerName }) => deletedWorkers.push(deletedWorkerName),
        },
      })
    );

    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).error.code, 'CLEANUP_RESOURCE_UNSUPPORTED');
    assert.deepEqual(deletedWorkers, []);
  });
}

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

test('admin sites expose the active deployment shape without crossing site versions', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await seedConsoleUser(store, 'usr_owner');
  await seedAdminShapeSite(store, { id: 'site_assets', deploymentShape: 'assets-only' });
  await seedAdminShapeSite(store, { id: 'site_worker', deploymentShape: 'worker-only' });
  await seedAdminShapeSite(store, { id: 'site_worker_assets', deploymentShape: 'worker-with-assets' });
  await seedAdminShapeSite(store, { id: 'site_future', deploymentShape: 'future-shape' });
  await seedAdminShapeSite(store, { id: 'site_empty' });
  await seedAdminShapeSite(store, { id: 'site_cross' });
  await store.activateSiteVersion(
    'site_cross',
    {
      activeVersionId: 'ver_site_worker',
      workerName: 'pages-v2-site-cross',
      visibility: 'internal',
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
    'production'
  );

  const list = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites', { userId: 'usr_root', admin: true }),
    env(store)
  );
  const detail = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_worker', { userId: 'usr_root', admin: true }),
    env(store)
  );

  assert.equal(list.status, 200, await list.clone().text());
  const body = await list.json();
  const listedById = new Map(body.sites.map((site) => [site.id, site]));
  assert.equal(listedById.get('site_assets').deploymentShape, 'assets-only');
  assert.equal(listedById.get('site_worker').deploymentShape, 'worker-only');
  assert.equal(listedById.get('site_worker_assets').deploymentShape, 'worker-with-assets');
  assert.equal(listedById.get('site_future').deploymentShape, 'future-shape');
  assert.equal(listedById.get('site_empty').deploymentShape, null);
  assert.equal(listedById.get('site_cross').deploymentShape, null);
  assert.equal(detail.status, 200, await detail.clone().text());
  assert.equal((await detail.json()).site.deploymentShape, 'worker-only');
});

test('platform admin can edit admin-scope site settings without asset membership', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    employeeStatus: 'active',
  });
  await store.createUser({
    userId: 'usr_target',
    email: 'target@example.com',
    realname: '目标用户',
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

  const putVar = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_console/config/vars/API_BASE', {
      userId: 'usr_root',
      admin: true,
      method: 'PUT',
      body: { value: 'https://api.example.com' },
    }),
    env(store)
  );
  const access = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_console/access', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { visibility: 'acl', aclEntries: [{ subjectType: 'email', subjectValue: 'viewer@example.com' }] },
    }),
    env(store)
  );
  const settings = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_console/settings', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { ownerType: 'user', ownerId: 'usr_target' },
    }),
    env(store)
  );

  assert.equal(putVar.status, 200, await putVar.clone().text());
  assert.equal((await putVar.json()).var.name, 'API_BASE');
  assert.equal(access.status, 200, await access.clone().text());
  assert.equal((await access.json()).access.visibility, 'acl');
  assert.equal(settings.status, 200, await settings.clone().text());
  const settingsBody = await settings.json();
  assert.equal(settingsBody.site.owner.type, 'user');
  assert.equal(settingsBody.site.owner.id, 'usr_target');
  assert.equal(settingsBody.site.owner.displayName, '目标用户');
  const site = await store.getSite('site_console');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_target');
  assert.equal(site.ownerUserId, 'usr_target');
});

test('platform admin site detail and settings avoid full admin site scans', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    employeeStatus: 'active',
  });
  await store.createUser({
    userId: 'usr_target',
    email: 'target@example.com',
    realname: '目标用户',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_personal',
    slug: 'personal',
    ownerUserId: 'usr_owner',
    ownerType: 'user',
    ownerId: 'usr_owner',
    siteUuid: 'uuid_site_personal',
    defaultVisibility: 'internal',
    environment: 'production',
    routeId: 'route_site_personal',
    hostname: 'personal.workers.xd.team',
  });
  store.listAdminSites = async () => {
    throw new Error('unexpected full admin site scan');
  };

  const detail = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_personal', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );
  const settings = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_personal/settings', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { ownerType: 'user', ownerId: 'usr_target' },
    }),
    env(store)
  );

  assert.equal(detail.status, 200, await detail.clone().text());
  assert.equal((await detail.json()).site.id, 'site_personal');
  assert.equal(settings.status, 200, await settings.clone().text());
  assert.equal((await settings.json()).site.owner.id, 'usr_target');
});

test('platform admin site owner transfer refreshes active route snapshot', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  const snapshots = createSnapshotStore();
  await seedPlatformAdmin(store);
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    employeeStatus: 'active',
  });
  await store.createUser({
    userId: 'usr_target',
    email: 'target@example.com',
    realname: '目标用户',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_personal',
    slug: 'personal',
    ownerUserId: 'usr_owner',
    ownerType: 'user',
    ownerId: 'usr_owner',
    siteUuid: 'uuid_site_personal',
    defaultVisibility: 'owner',
    environment: 'production',
    routeId: 'route_site_personal',
    hostname: 'personal.workers.xd.team',
  });
  await activateSite(store, 'site_personal', { visibility: 'owner' });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_personal/settings', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { ownerType: 'user', ownerId: 'usr_target' },
    }),
    env(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200, await response.clone().text());
  const pointer = snapshots.read('production:route_pointer:personal.workers.xd.team');
  assert.ok(pointer);
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.ownerUserId, 'usr_target');
});

test('platform admin site owner transfer rolls back when route snapshot cannot refresh', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    employeeStatus: 'active',
  });
  await store.createUser({
    userId: 'usr_target',
    email: 'target@example.com',
    realname: '目标用户',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_personal',
    slug: 'personal',
    ownerUserId: 'usr_owner',
    ownerType: 'user',
    ownerId: 'usr_owner',
    siteUuid: 'uuid_site_personal',
    defaultVisibility: 'owner',
    environment: 'production',
    routeId: 'route_site_personal',
    hostname: 'personal.workers.xd.team',
  });
  await activateSite(store, 'site_personal', { visibility: 'owner' });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_personal/settings', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { ownerType: 'user', ownerId: 'usr_target' },
    }),
    env(store, { ROUTE_SNAPSHOTS: failingSnapshotStore() })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  const site = await store.getSite('site_personal');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_owner');
  assert.equal(site.ownerUserId, 'usr_owner');
});

test('platform admin cannot transfer an admin-scope site to an inactive user', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await seedConsoleUser(store, 'usr_owner');
  await seedConsoleUser(store, 'usr_disabled', { employeeStatus: 'disabled' });
  await store.createSite({
    id: 'site_personal',
    slug: 'personal',
    ownerUserId: 'usr_owner',
    siteUuid: 'uuid_site_personal',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_site_personal',
    hostname: 'personal.workers.xd.team',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/sites/site_personal/settings', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { ownerType: 'user', ownerId: 'usr_disabled' },
    }),
    env(store)
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_TRANSFER_FORBIDDEN');
  const site = await store.getSite('site_personal');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_owner');
  assert.equal(site.ownerUserId, 'usr_owner');
});

test('platform admin can edit admin-scope custom team settings without team membership', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
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
    description: 'before',
    createdByUserId: 'usr_owner',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams/team_console/settings', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { name: 'Console Owners', description: 'after' },
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.team.name, 'Console Owners');
  assert.equal(body.team.description, 'after');
});

test('platform admin can manage admin-scope team members without team membership', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    employeeStatus: 'active',
  });
  await store.createUser({
    userId: 'usr_member',
    email: 'member@example.com',
    realname: '成员',
    employeeStatus: 'active',
  });
  await store.createUser({
    userId: 'usr_new',
    email: 'new@example.com',
    realname: '新人',
    employeeStatus: 'active',
  });
  await store.createTeam({
    id: 'team_console',
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    createdByUserId: 'usr_owner',
  });
  await store.addTeamMember({
    teamId: 'team_console',
    userId: 'usr_member',
    role: 'viewer',
    membershipSource: 'manual',
    actorUserId: 'usr_owner',
  });

  const members = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams/team_console/members', {
      userId: 'usr_root',
      admin: true,
    }),
    env(store)
  );
  const update = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams/team_console/members/usr_new', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { role: 'publisher' },
    }),
    env(store)
  );
  const remove = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams/team_console/members/usr_member', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(members.status, 200, await members.clone().text());
  assert.equal(
    (await members.json()).members.some((member) => member.userId === 'usr_member'),
    true
  );
  assert.equal(update.status, 200, await update.clone().text());
  assert.equal((await update.json()).member.role, 'publisher');
  assert.equal(remove.status, 200, await remove.clone().text());
  assert.ok((await remove.json()).member.removedAt);
});

test('platform admin cannot remove or demote the last team admin from admin scope', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
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

  const demote = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams/team_console/members/usr_owner', {
      userId: 'usr_root',
      admin: true,
      method: 'PATCH',
      body: { role: 'viewer' },
    }),
    env(store)
  );
  const remove = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/teams/team_console/members/usr_owner', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
    }),
    env(store)
  );

  assert.equal(demote.status, 409, await demote.clone().text());
  assert.equal((await demote.json()).error.code, 'TEAM_LAST_ADMIN');
  assert.equal(remove.status, 409, await remove.clone().text());
  assert.equal((await remove.json()).error.code, 'TEAM_LAST_ADMIN');
  const member = await store.getTeamMember({ teamId: 'team_console', userId: 'usr_owner' });
  assert.equal(member.role, 'admin');
  assert.equal(member.removedAt, null);
});

test('admin audit events include readable actor profile', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-02T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createUser({
    userId: 'usr_actor',
    email: 'actor@example.com',
    realname: '徐天麒',
    employeeStatus: 'active',
  });
  await store.recordAuditEvent({
    id: 'audit_actor_name',
    environment: 'production',
    eventType: 'site.publish',
    actorUserId: 'usr_actor',
    actorType: 'user',
    decision: 'allow',
    statusCode: 200,
    metadata: {
      siteSlug: 'demo',
    },
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/audit', { userId: 'usr_root', admin: true }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const auditEvent = body.events.find((event) => event.id === 'audit_actor_name');
  assert.ok(auditEvent);
  assert.deepEqual(auditEvent.actor, {
    type: 'user',
    userId: 'usr_actor',
    displayName: '徐天麒',
    email: 'actor@example.com',
  });
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    now: () => '2026-07-02T00:00:00.000Z',
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

async function seedAdminShapeSite(store, { id, deploymentShape = null }) {
  await store.createSite({
    id,
    slug: id.replaceAll('_', '-'),
    ownerUserId: 'usr_owner',
    ownerType: 'user',
    ownerId: 'usr_owner',
    siteUuid: `uuid_${id}`,
    defaultVisibility: 'internal',
    environment: 'production',
    routeId: `route_${id}`,
    hostname: `${id.replaceAll('_', '-')}.workers.xd.team`,
  });
  if (!deploymentShape) return;

  const hasAssets = deploymentShape === 'assets-only' || deploymentShape === 'worker-with-assets';
  await store.createSiteVersion({
    id: `ver_${id}`,
    siteId: id,
    deploymentId: `dep_${id}`,
    workerName: `pages-v2-${id}`,
    runtime: 'wfp',
    artifactRef: `wfp://test/pages-v2-${id}`,
    contentHash: `sha256:${id}`,
    deploymentShape,
    requestedFallback: 'auto',
    resolvedFallback: hasAssets ? 'not-found' : null,
    routingMode: deploymentShape === 'worker-with-assets' ? 'worker-first' : deploymentShape,
    createdBy: 'usr_owner',
  });
  await store.activateSiteVersion(
    id,
    {
      activeVersionId: `ver_${id}`,
      workerName: `pages-v2-${id}`,
      visibility: 'internal',
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
    'production'
  );
}

async function activateSite(store, siteId, { workerName = 'pages-v2-site-ver-1', visibility = 'org' } = {}) {
  await store.createSiteVersion({
    id: `ver_${siteId}`,
    siteId,
    deploymentId: `dep_${siteId}`,
    workerName,
    runtime: 'wfp',
    artifactRef: `wfp://test/${workerName}`,
    contentHash: `sha256:${siteId}`,
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    createdBy: 'usr_owner',
  });
  return store.activateSiteVersion(
    siteId,
    {
      activeVersionId: `ver_${siteId}`,
      workerName,
      runtime: 'wfp',
      executionProvider: 'wfp',
      dispatchType: 'dispatch-namespace',
      visibility,
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
    'production'
  );
}

async function seedActiveNormalWorkerSite(store) {
  await store.createUser({
    userId: 'usr_legacy_owner',
    email: 'legacy-owner@example.com',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_normal_active',
    slug: 'normal-active',
    ownerUserId: 'usr_legacy_owner',
    siteUuid: 'uuid_site_normal_active',
    defaultVisibility: 'internal',
    environment: 'production',
    routeId: 'route_site_normal_active',
    hostname: 'normal-active.pages.xd.team',
  });
  await store.createWorkerSlot({
    id: 'slot_production_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'assigned',
    assignedSiteId: 'site_normal_active',
    assignedRouteId: 'route_site_normal_active',
    assignedVersionId: 'ver_site_normal_active',
    assignedAt: '2026-07-02T00:00:00.000Z',
  });
  await store.createSiteVersion({
    id: 'ver_site_normal_active',
    siteId: 'site_normal_active',
    deploymentId: 'dep_site_normal_active',
    workerName: 'pages-v2-production-slot-007',
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    dispatchType: 'service-binding',
    dispatchBindingName: 'SITE_SLOT_007',
    slotId: 'slot_production_007',
    artifactRef: 'slot://production/slot_production_007/pages-v2-production-slot-007/ver_site_normal_active',
    contentHash: 'sha256:normal-active',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    createdBy: 'usr_legacy_owner',
  });
  return store.activateSiteVersion(
    'site_normal_active',
    {
      activeVersionId: 'ver_site_normal_active',
      workerName: 'pages-v2-production-slot-007',
      runtime: 'worker',
      executionProvider: 'normal-worker-slot',
      dispatchType: 'service-binding',
      dispatchBindingName: 'SITE_SLOT_007',
      slotId: 'slot_production_007',
      visibility: 'internal',
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
    'production'
  );
}

function createSnapshotStore() {
  const values = new Map();
  return {
    put: async (key, value) => values.set(key, JSON.parse(value)),
    get: async (key) => (values.has(key) ? JSON.stringify(values.get(key)) : null),
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
