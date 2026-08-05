import assert from 'node:assert/strict';
import test from 'node:test';

import { createV1SitesAdminClient, isManagedV1WorkerName, isManagedWfpWorkerName } from './admin-resource-governance.js';

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

test('resource inventory filters v1 and WFP names by the current environment', () => {
  assert.equal(isManagedWfpWorkerName('pages-v2-docs-ver-1', 'production'), true);
  assert.equal(isManagedWfpWorkerName('pages-v2-staging-docs-ver-1', 'production'), false);
  assert.equal(isManagedWfpWorkerName('pages-v2-staging-docs-ver-1', 'staging'), true);
  assert.equal(isManagedV1WorkerName('pages-docs', 'production'), true);
  assert.equal(isManagedV1WorkerName('pages-staging-docs', 'production'), false);
  assert.equal(isManagedV1WorkerName('pages-v2-docs-ver-1', 'production'), false);
  assert.equal(isManagedV1WorkerName('pages-staging-docs', 'staging'), true);
  assert.equal(isManagedV1WorkerName('pages-v2-staging-docs-ver-1', 'staging'), false);
});

test('v1 sites admin client retires a Worker through exact route and KV endpoints', async () => {
  const requests = [];
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    CF_ZONE_ID: 'zone_1',
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
    CF_ZONE_ID: 'zone_1',
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

test('v1 sites admin client validates staging Worker names against the requested environment', async () => {
  const client = createV1SitesAdminClient({
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'runtime-secret-placeholder',
    CF_ZONE_ID: 'zone_1',
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
