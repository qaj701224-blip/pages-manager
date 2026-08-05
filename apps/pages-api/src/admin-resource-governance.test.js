import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkerOrphanScan,
  createV1SitesAdminClient,
  formatV1SitesInventory,
  isManagedV1WorkerName,
  isManagedWfpWorkerName,
  readV1ReservedWorkerNames,
} from './admin-resource-governance.js';

test('v1 sites admin client reads KV cursor pages and the account Worker inventory', async () => {
  const requests = [];
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async (url, init) => {
      const parsed = new URL(url);
      requests.push({ url: parsed.toString(), authorization: init.headers.Authorization });
      if (parsed.pathname.endsWith('/keys')) {
        const cursor = parsed.searchParams.get('cursor');
        return Response.json({
          success: true,
          result: [{ name: cursor ? 'legacy-2' : 'legacy-1', metadata: { preset: 'spa' } }],
          result_info: { cursor: cursor ? '' : 'cursor-2' },
        });
      }
      return Response.json({
        success: true,
        result: [
          {
            id: 'pages-legacy-1',
            modified_on: '2026-06-01T00:00:00.000Z',
          },
          {
            id: 'pages-legacy-2',
            modified_on: '2026-06-02T00:00:00.000Z',
          },
        ],
      });
    },
  });

  assert.deepEqual(
    (await client.listSites()).map((site) => site.name),
    ['legacy-1', 'legacy-2']
  );
  assert.deepEqual(await client.listWorkers(), [
    { name: 'pages-legacy-1', created_on: null, modified_on: '2026-06-01T00:00:00.000Z' },
    { name: 'pages-legacy-2', created_on: null, modified_on: '2026-06-02T00:00:00.000Z' },
  ]);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://api.cloudflare.com/client/v4/accounts/account_1/storage/kv/namespaces/namespace_1/keys?limit=1000',
      'https://api.cloudflare.com/client/v4/accounts/account_1/storage/kv/namespaces/namespace_1/keys?limit=1000&cursor=cursor-2',
      'https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts',
    ]
  );
  assert.equal(
    requests.every((request) => request.authorization === 'Bearer secret_token'),
    true
  );
});

test('v1 sites admin client accepts a large single-page Worker inventory without pagination metadata', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async () =>
      Response.json({
        success: true,
        result: Array.from({ length: 150 }, (_, index) => ({ id: `pages-site-${index + 1}` })),
      }),
  });

  assert.equal((await client.listWorkers()).length, 150);
});

test('v1 sites admin client accepts a full KV page without a next cursor as the terminal page', async () => {
  let requests = 0;
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async () => {
      requests += 1;
      return Response.json({
        success: true,
        result: Array.from({ length: 1000 }, (_, index) => ({ name: `legacy-${index + 1}` })),
        result_info: {},
      });
    },
  });

  assert.equal((await client.listSites()).length, 1000);
  assert.equal(requests, 1);
});

test('v1 sites admin client continues after a full KV page with a next cursor', async () => {
  let requests = 0;
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async (url) => {
      requests += 1;
      const cursor = new URL(url).searchParams.get('cursor');
      if (cursor) return Response.json({ success: true, result: [{ name: 'legacy-final' }], result_info: {} });
      return Response.json({
        success: true,
        result: Array.from({ length: 1000 }, (_, index) => ({ name: `legacy-${index + 1}` })),
        result_info: { cursor: 'next-page' },
      });
    },
  });

  assert.equal((await client.listSites()).length, 1001);
  assert.equal(requests, 2);
});

test('v1 sites admin client rejects a non-string KV cursor', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async () => Response.json({ success: true, result: [], result_info: { cursor: 42 } }),
  });

  await assert.rejects(() => client.listSites(), /CLOUDFLARE_RESOURCE_INVENTORY_INVALID/);
});

test('v1 sites admin client rejects malformed list responses instead of reporting empty inventory', async () => {
  let workerRequests = 0;
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async (url) => {
      if (new URL(url).pathname.endsWith('/keys')) {
        return Response.json({ success: true, result: {}, result_info: { cursor: '' } });
      }
      workerRequests += 1;
      if (workerRequests > 3) throw new Error('TEST_REQUEST_LIMIT_EXCEEDED');
      return Response.json({ success: true, result: {} });
    },
  });

  await assert.rejects(() => client.listSites(), /CLOUDFLARE_RESOURCE_INVENTORY_INVALID/);
  await assert.rejects(() => client.listWorkers(), /CLOUDFLARE_RESOURCE_INVENTORY_INVALID/);
  assert.equal(workerRequests, 1);
});

test('v1 sites admin client rejects a repeated KV cursor before retrying forever', async () => {
  let requests = 0;
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async () => {
      requests += 1;
      if (requests > 3) throw new Error('TEST_REQUEST_LIMIT_EXCEEDED');
      return Response.json({ success: true, result: [], result_info: { cursor: 'same-cursor' } });
    },
  });

  await assert.rejects(() => client.listSites(), /CLOUDFLARE_RESOURCE_INVENTORY_INVALID/);
  assert.equal(requests, 2);
});

test('v1 sites admin client rejects a non-object KV result_info', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'secret_token',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async () => Response.json({ success: true, result: [], result_info: 'invalid' }),
  });

  await assert.rejects(() => client.listSites(), /CLOUDFLARE_RESOURCE_INVENTORY_INVALID/);
});

test('resource inventory filters v1 and WFP names by the current environment', () => {
  assert.equal(isManagedWfpWorkerName('pages-v2-docs-ver-1', 'production'), true);
  assert.equal(isManagedWfpWorkerName('pages-v2-staging-docs-ver-1', 'production'), false);
  assert.equal(isManagedWfpWorkerName('pages-v2-staging-docs-ver-1', 'staging'), true);
  assert.equal(isManagedV1WorkerName('pages-docs', 'production'), true);
  assert.equal(isManagedV1WorkerName('pages-staging-docs', 'production'), false);
  assert.equal(isManagedV1WorkerName('pages-v2-docs-ver-1', 'production'), false);
  assert.equal(isManagedV1WorkerName('pages-staging-docs', 'staging'), true);
  assert.equal(isManagedV1WorkerName('pages-v2-staging-docs-ver-1', 'staging'), false);
  assert.equal(isManagedWfpWorkerName('pages-v2-production-slot-1', 'production'), false);
  assert.equal(isManagedWfpWorkerName('pages-v2-staging-slot-1', 'staging'), false);
});

test('orphan scan excludes normal Worker slots and ignores non-WFP D1 ownership records', () => {
  const scan = buildWorkerOrphanScan({
    environment: 'production',
    scannedAt: '2026-07-02T00:00:00.000Z',
    workers: [
      { name: 'pages-v2-production-slot-1' },
      { name: 'pages-v2-normal-provider-record' },
      { name: 'pages-v2-wfp-record' },
    ],
    references: {
      activeRoutes: [
        {
          workerName: 'pages-v2-normal-provider-record',
          executionProvider: 'normal-worker-slot',
          dispatchType: 'dispatch-namespace',
          siteId: 'site_normal',
        },
        {
          workerName: 'pages-v2-wfp-record',
          executionProvider: 'wfp',
          dispatchType: 'dispatch-namespace',
          siteId: 'site_wfp',
        },
      ],
      versions: [],
      cleanupTasks: [],
    },
  });

  assert.deepEqual(scan.workers.map((worker) => [worker.name, worker.referencedByActiveRoute, worker.orphanReason]), [
    ['pages-v2-normal-provider-record', false, 'no_d1_reference'],
    ['pages-v2-wfp-record', true, null],
  ]);
});

test('reserved Worker names normalize to lower case and ignore invalid entries', () => {
  const warnings = [];
  const originalWarn = globalThis.console.warn;
  globalThis.console.warn = (...values) => warnings.push(values.join(' '));
  try {
    assert.deepEqual(
      [...readV1ReservedWorkerNames({ PAGES_V1_RESERVED_WORKER_NAMES: ' Pages-OPS , PAGES-CONSOLE ,, unsafe/name ' })].sort(),
      [
        'pages-api',
        'pages-api-staging',
        'pages-auth',
        'pages-auth-staging',
        'pages-console',
        'pages-console-staging',
        'pages-kv-gateway',
        'pages-kv-gateway-staging',
        'pages-manager',
        'pages-manager-staging',
        'pages-ops',
        'pages-router',
        'pages-router-staging',
      ].sort()
    );
  } finally {
    globalThis.console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ['V1_RESERVED_WORKER_NAME_INVALID']);
});

test('v1 inventory marks every non-retirable condition explicitly', () => {
  const inventory = formatV1SitesInventory({
    environment: 'production',
    activeV2Sites: [],
    reservedWorkerNames: new Set(['pages-reserved']),
    siteKeys: [
      { name: 'missing', metadata: {} },
      { name: 'malformed', metadata: { scriptName: 'pages-../malformed' } },
      { name: 'mismatch', metadata: { scriptName: 'pages-other' } },
      { name: 'absent-worker', metadata: { scriptName: 'pages-absent-worker' } },
      { name: 'reserved', metadata: { scriptName: 'pages-reserved' } },
      { name: 'ready', metadata: { scriptName: 'pages-ready' } },
    ],
    workers: [{ name: 'pages-ready', modified_on: '2026-07-02T00:00:00.000Z' }],
  });

  assert.deepEqual(
    inventory.map((site) => [site.name, site.canRetire, site.retireBlockedReason]),
    [
      ['absent-worker', false, 'worker_missing'],
      ['malformed', false, 'script_name_invalid'],
      ['mismatch', false, 'script_name_mismatch'],
      ['missing', false, 'script_name_missing'],
      ['ready', true, undefined],
      ['reserved', false, 'platform_reserved'],
    ]
  );
});

test('v1 sites admin client retires a Worker through exact route and KV endpoints', async () => {
  const requests = [];
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    PAGES_V1_ZONE_ID: 'zone_1',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    PAGES_ENV: 'production',
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init.method || 'GET' });
      if ((init.method || 'GET') === 'GET') {
        return Response.json({
          success: true,
          result: [{ id: 'route_1', pattern: 'legacy.workers.xd.team/*', script: 'pages-legacy' }],
        });
      }
      return Response.json({ success: true, result: null });
    },
  });

  await client.deleteWorker({ workerName: 'pages-legacy' });
  await client.unbindRoute({ hostname: 'legacy.workers.xd.team', expectedScriptName: 'pages-legacy' });
  await client.deleteSite('legacy');
  assert.deepEqual(requests, [
    {
      url: 'https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/pages-legacy?force=true',
      method: 'DELETE',
    },
    {
      url: 'https://api.cloudflare.com/client/v4/zones/zone_1/workers/routes',
      method: 'GET',
    },
    {
      url: 'https://api.cloudflare.com/client/v4/zones/zone_1/workers/routes/route_1',
      method: 'DELETE',
    },
    {
      url: 'https://api.cloudflare.com/client/v4/accounts/account_1/storage/kv/namespaces/namespace_1/values/legacy',
      method: 'DELETE',
    },
  ]);
});

test('v1 sites admin client refuses unsafe route patterns and mismatched scripts', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    PAGES_V1_ZONE_ID: 'zone_1',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    PAGES_ENV: 'production',
    fetch: async () =>
      Response.json({
        success: true,
        result: [{ id: 'route_1', pattern: '*.workers.xd.team/*', script: 'pages-other' }],
      }),
  });

  await assert.rejects(
    () => client.unbindRoute({ hostname: 'legacy.workers.xd.team', expectedScriptName: 'pages-legacy' }),
    /V1_SITE_ROUTE_UNSAFE/
  );
});

test('v1 sites admin client treats missing Worker, route, and KV as idempotent success', async () => {
  const requests = [];
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    PAGES_V1_ZONE_ID: 'zone_1',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    PAGES_ENV: 'production',
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init.method || 'GET' });
      if ((init.method || 'GET') === 'GET') return Response.json({ success: true, result: [] });
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.deleteWorker({ workerName: 'pages-legacy' });
  await client.unbindRoute({ hostname: 'legacy.workers.xd.team', expectedScriptName: 'pages-legacy' });
  await client.deleteSite('legacy');
  assert.equal(requests.length, 3);
});

test('v1 sites admin client ignores unrelated exact routes when the target route is already absent', async () => {
  const requests = [];
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    PAGES_V1_ZONE_ID: 'zone_1',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    PAGES_ENV: 'production',
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || 'GET' });
      return Response.json({
        success: true,
        result: [{ id: 'route_other', pattern: 'other.workers.xd.team/*', script: 'pages-other' }],
      });
    },
  });

  await client.unbindRoute({ hostname: 'legacy.workers.xd.team', expectedScriptName: 'pages-legacy' });
  assert.deepEqual(requests, [
    {
      url: 'https://api.cloudflare.com/client/v4/zones/zone_1/workers/routes',
      method: 'GET',
    },
  ]);
});

test('v1 sites admin client fails closed when route inventory cannot be read', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    PAGES_V1_ZONE_ID: 'zone_1',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    PAGES_ENV: 'production',
    fetch: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  await assert.rejects(
    () => client.unbindRoute({ hostname: 'legacy.workers.xd.team', expectedScriptName: 'pages-legacy' }),
    /V1_SITE_ROUTE_UNSAFE/
  );
});

test('v1 sites admin client rejects malformed successful destructive responses', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    PAGES_V1_ZONE_ID: 'zone_1',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    PAGES_ENV: 'production',
    fetch: async () => Response.json({}),
  });

  await assert.rejects(() => client.deleteWorker({ workerName: 'pages-legacy' }), /CLOUDFLARE_RESOURCE_INVENTORY_FAILED/);
});

test('v1 sites admin client validates staging Worker names against the requested environment', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    PAGES_V1_ZONE_ID: 'zone_1',
    PAGES_V1_SITES_KV_NAMESPACE_ID: 'namespace_1',
    fetch: async () =>
      Response.json({
        success: true,
        result: [{ id: 'route_1', pattern: 'legacy-staging.workers.xd.team/*', script: 'pages-staging-legacy' }],
      }),
  });

  await client.unbindRoute({
    hostname: 'legacy-staging.workers.xd.team',
    expectedScriptName: 'pages-staging-legacy',
    environment: 'staging',
  });
});
