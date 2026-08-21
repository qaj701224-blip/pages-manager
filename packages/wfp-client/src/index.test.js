import assert from 'node:assert/strict';
import test from 'node:test';

import { WfpApiError, createWfpClient, normalizeWorkerBindings, readWfpConfig, validateScriptName } from './index.js';

test('readWfpConfig enforces production and staging namespace isolation', () => {
  assert.deepEqual(
    readWfpConfig(
      {
        CF_ACCOUNT_ID: 'account_1',
        CF_API_TOKEN: 'cf_secret_token',
        WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
      },
      { environment: 'production' }
    ),
    {
      accountId: 'account_1',
      apiToken: 'cf_secret_token',
      dispatchNamespace: 'xd-cell-workers-production',
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      environment: 'production',
    }
  );

  assert.throws(
    () =>
      readWfpConfig(
        {
          CF_ACCOUNT_ID: 'account_1',
          CF_API_TOKEN: 'cf_secret_token',
          WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-staging',
        },
        { environment: 'production' }
      ),
    /WFP_DISPATCH_NAMESPACE/
  );
  assert.throws(
    () =>
      readWfpConfig(
        {
          CF_ACCOUNT_ID: 'account_1',
          CF_API_TOKEN: 'cf_secret_token',
          WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
        },
        { environment: 'staging' }
      ),
    /WFP_DISPATCH_NAMESPACE/
  );
});

test('readWfpConfig fails closed on missing credentials and unsafe API origins', () => {
  assert.throws(
    () => readWfpConfig({ CF_API_TOKEN: 'token', WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production' }),
    /CF_ACCOUNT_ID/
  );
  assert.throws(
    () => readWfpConfig({ CF_ACCOUNT_ID: 'account', WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production' }),
    /CF_API_TOKEN/
  );
  assert.throws(
    () =>
      readWfpConfig(
        {
          CF_ACCOUNT_ID: 'account',
          CF_API_TOKEN: 'token',
          WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
          CF_API_BASE_URL: 'https://api.cloudflare.com/client/v4/path',
        },
        { environment: 'production' }
      ),
    /CF_API_BASE_URL/
  );
  assert.throws(
    () =>
      readWfpConfig(
        {
          CF_ACCOUNT_ID: 'account',
          CF_API_TOKEN: 'token',
          WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
          CF_API_BASE_URL: 'https://example.com/client/v4',
        },
        { environment: 'production' }
      ),
    /CF_API_BASE_URL/
  );
  assert.equal(
    readWfpConfig(
      {
        CF_ACCOUNT_ID: 'account',
        CF_API_TOKEN: 'token',
        WFP_DISPATCH_NAMESPACE: 'pages-local',
        CF_API_BASE_URL: 'https://mock.cloudflare.test/client/v4',
      },
      { environment: 'local' }
    ).apiBaseUrl,
    'https://mock.cloudflare.test/client/v4'
  );
});

test('uploadUserWorker sends multipart metadata and module to dispatch namespace endpoint', async () => {
  const requests = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      requests.push(request);
      return Response.json({ success: true, result: { id: 'pages-v2-docs-ver-1' } });
    },
  });

  const result = await client.uploadUserWorker({
    scriptName: 'pages-v2-docs-ver-1',
    mainModule: 'worker.mjs',
    modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
    compatibilityDate: '2026-06-15',
    tags: ['pages-v2', 'production'],
    bindings: [{ type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' }],
  });

  assert.deepEqual(result, {
    scriptName: 'pages-v2-docs-ver-1',
    dispatchNamespace: 'xd-cell-workers-production',
    artifactRef: 'wfp://xd-cell-workers-production/pages-v2-docs-ver-1',
  });
  assert.equal(
    requests[0].url,
    [
      'https://api.cloudflare.com/client/v4/accounts/account_1',
      'workers/dispatch/namespaces/xd-cell-workers-production/scripts/pages-v2-docs-ver-1',
    ].join('/')
  );
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer cf_secret_token');
  const form = await requests[0].formData();
  assert.deepEqual(JSON.parse(await form.get('metadata').text()), {
    main_module: 'worker.mjs',
    compatibility_date: '2026-06-15',
    tags: ['pages-v2', 'production'],
    bindings: [{ type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' }],
  });
  assert.equal(await form.get('worker.mjs').text(), 'export default {};');
  assert.equal(form.get('worker.mjs').type, 'application/javascript+module');
});

test('listUserWorkers accepts an undocumented single-page list and verifies namespace script count', async () => {
  const requests = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      requests.push(request);
      if (!request.url.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 1 } });
      return Response.json({
        success: true,
        result: [
          {
            script: { id: 'pages-v2-docs-ver-1' },
            created_on: '2026-06-01T00:00:00.000Z',
            modified_on: '2026-06-02T00:00:00.000Z',
          },
        ],
      });
    },
  });

  assert.deepEqual(await client.listUserWorkers(), {
    workers: [
      {
        name: 'pages-v2-docs-ver-1',
        created_on: '2026-06-01T00:00:00.000Z',
        modified_on: '2026-06-02T00:00:00.000Z',
      },
    ],
    completeness: 'complete',
    scannedCount: 1,
    namespaceScriptCount: 1,
  });
  const scriptsEndpoint =
    'https://api.cloudflare.com/client/v4/accounts/account_1/workers/dispatch/namespaces/xd-cell-workers-production/scripts';
  assert.deepEqual(
    requests.map((request) => request.url),
    [scriptsEndpoint, scriptsEndpoint.replace(/\/scripts$/, '')]
  );
  assert.equal(
    requests.every((request) => request.headers.get('Authorization') === 'Bearer cf_secret_token'),
    true
  );
});

test('listUserWorkers rejects partial result_info metadata instead of treating it as a complete single page', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) =>
      request.url.endsWith('/scripts')
        ? Response.json({ success: true, result: [{ id: 'pages-v2-docs-ver-1' }], result_info: { page: 1 } })
        : Response.json({ success: true, result: { script_count: 1 } }),
  });

  await assert.rejects(
    () => client.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
});

test('listUserWorkers rejects malformed result_info values and malformed worker items', async () => {
  const malformedPagination = [
    { page: '1', total_pages: 1 },
    { page: 0, total_pages: 1 },
    { page: 1, total_pages: 0 },
    { page: 2, total_pages: 1 },
    'invalid',
    null,
  ];

  for (const resultInfo of malformedPagination) {
    const client = createWfpClient({
      accountId: 'account_1',
      apiToken: 'cf_secret_token',
      dispatchNamespace: 'xd-cell-workers-production',
      fetch: async (request) =>
        request.url.endsWith('/scripts')
          ? Response.json({ success: true, result: [{ id: 'pages-v2-docs-ver-1' }], result_info: resultInfo })
          : Response.json({ success: true, result: { script_count: 1 } }),
    });

    await assert.rejects(
      () => client.listUserWorkers(),
      (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
    );
  }

  const malformedWorker = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) =>
      request.url.endsWith('/scripts')
        ? Response.json({ success: true, result: [{ created_on: '2026-06-01T00:00:00.000Z' }] })
        : Response.json({ success: true, result: { script_count: 1 } }),
  });

  await assert.rejects(
    () => malformedWorker.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
});

test('listUserWorkers follows usable result_info pagination before checking script count', async () => {
  const requests = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      requests.push(request.url);
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 2 } });
      if (url.searchParams.get('page') === '2') {
        return Response.json({
          success: true,
          result: [{ id: 'pages-v2-blog-ver-2', modified_on: '2026-06-04T00:00:00.000Z' }],
          result_info: { page: 2, total_pages: 2 },
        });
      }
      return Response.json({
        success: true,
        result: [{ script: { id: 'pages-v2-docs-ver-1' }, modified_on: '2026-06-02T00:00:00.000Z' }],
        result_info: { page: 1, total_pages: 2 },
      });
    },
  });

  const inventory = await client.listUserWorkers();
  assert.deepEqual(
    inventory.workers.map((worker) => worker.name),
    ['pages-v2-docs-ver-1', 'pages-v2-blog-ver-2']
  );
  assert.equal(inventory.completeness, 'complete');
  assert.deepEqual(
    requests.map((url) => new URL(url).search),
    ['', '?page=2', '']
  );
});

test('listUserWorkers derives total pages from per_page/total_count metadata without total_pages', async () => {
  const requests = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      requests.push(request.url);
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 3 } });
      if (url.searchParams.get('page') === '2') {
        return Response.json({
          success: true,
          result: [{ id: 'pages-v2-blog-ver-3' }],
          result_info: { page: 2, per_page: 2, count: 1, total_count: 3 },
        });
      }
      return Response.json({
        success: true,
        result: [{ id: 'pages-v2-docs-ver-1' }, { id: 'pages-v2-docs-ver-2' }],
        result_info: { page: 1, per_page: 2, count: 2, total_count: 3 },
      });
    },
  });

  const inventory = await client.listUserWorkers();
  assert.deepEqual(
    inventory.workers.map((worker) => worker.name),
    ['pages-v2-docs-ver-1', 'pages-v2-docs-ver-2', 'pages-v2-blog-ver-3']
  );
  assert.equal(inventory.completeness, 'complete');
  assert.deepEqual(
    requests.map((url) => new URL(url).search),
    ['', '?page=2', '']
  );
});

test('listUserWorkers follows cursor pagination as observed on the live dispatch scripts endpoint', async () => {
  const requests = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      requests.push(request.url);
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 3 } });
      if (url.searchParams.get('cursor') === 'cursor-2') {
        return Response.json({
          success: true,
          result: [{ id: 'pages-v2-blog-ver-3' }],
          result_info: { count: 1, cursor: '' },
        });
      }
      return Response.json({
        success: true,
        result: [{ id: 'pages-v2-docs-ver-1' }, { id: 'pages-v2-docs-ver-2' }],
        result_info: { count: 2, cursor: 'cursor-2' },
      });
    },
  });

  const inventory = await client.listUserWorkers();
  assert.deepEqual(
    inventory.workers.map((worker) => worker.name),
    ['pages-v2-docs-ver-1', 'pages-v2-docs-ver-2', 'pages-v2-blog-ver-3']
  );
  assert.equal(inventory.completeness, 'complete');
  assert.deepEqual(
    requests.map((url) => new URL(url).search),
    ['', '?cursor=cursor-2', '']
  );
});

test('listUserWorkers treats a missing or empty cursor as the terminal page', async () => {
  for (const resultInfo of [{ count: 1 }, { count: 1, cursor: '' }, { count: 1, cursor: null }]) {
    const client = createWfpClient({
      accountId: 'account_1',
      apiToken: 'cf_secret_token',
      dispatchNamespace: 'xd-cell-workers-production',
      fetch: async (request) =>
        request.url.endsWith('/scripts')
          ? Response.json({ success: true, result: [{ id: 'pages-v2-docs-ver-1' }], result_info: resultInfo })
          : Response.json({ success: true, result: { script_count: 1 } }),
    });
    const inventory = await client.listUserWorkers();
    assert.deepEqual(
      inventory.workers.map((worker) => worker.name),
      ['pages-v2-docs-ver-1']
    );
    assert.equal(inventory.completeness, 'complete');
  }
});

test('listUserWorkers rejects malformed, repeated, or unproductive cursors', async () => {
  const malformedCursor = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) =>
      request.url.endsWith('/scripts')
        ? Response.json({ success: true, result: [{ id: 'pages-v2-docs-ver-1' }], result_info: { count: 1, cursor: 42 } })
        : Response.json({ success: true, result: { script_count: 1 } }),
  });
  await assert.rejects(
    () => malformedCursor.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );

  const repeatedCursor = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 4 } });
      const worker = url.searchParams.get('cursor') ? 'pages-v2-blog-ver-2' : 'pages-v2-docs-ver-1';
      return Response.json({
        success: true,
        result: [{ id: worker }],
        result_info: { count: 1, cursor: 'cursor-loop' },
      });
    },
  });
  await assert.rejects(
    () => repeatedCursor.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );

  const emptyPageWithCursor = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 2 } });
      if (url.searchParams.get('cursor')) {
        return Response.json({ success: true, result: [], result_info: { count: 0, cursor: 'cursor-next' } });
      }
      return Response.json({
        success: true,
        result: [{ id: 'pages-v2-docs-ver-1' }],
        result_info: { count: 1, cursor: 'cursor-2' },
      });
    },
  });
  await assert.rejects(
    () => emptyPageWithCursor.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );

  const unknownMetadata = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) =>
      request.url.endsWith('/scripts')
        ? Response.json({ success: true, result: [{ id: 'pages-v2-docs-ver-1' }], result_info: { unexpected: true } })
        : Response.json({ success: true, result: { script_count: 1 } }),
  });
  await assert.rejects(
    () => unknownMetadata.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
});

test('listUserWorkers accepts count-only single-page metadata and rejects malformed count fields', async () => {
  const singlePage = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) =>
      request.url.endsWith('/scripts')
        ? Response.json({
            success: true,
            result: [{ id: 'pages-v2-docs-ver-1' }],
            result_info: { page: 1, per_page: 100, count: 1, total_count: 1 },
          })
        : Response.json({ success: true, result: { script_count: 1 } }),
  });
  const inventory = await singlePage.listUserWorkers();
  assert.deepEqual(
    inventory.workers.map((worker) => worker.name),
    ['pages-v2-docs-ver-1']
  );
  assert.equal(inventory.completeness, 'complete');

  const malformedCountMetadata = [
    { page: 1, per_page: 0, total_count: 1 },
    { page: 1, per_page: '100', total_count: 1 },
    { page: 1, per_page: 100, total_count: -1 },
    { page: 1, per_page: 100, total_count: '1' },
  ];
  for (const resultInfo of malformedCountMetadata) {
    const client = createWfpClient({
      accountId: 'account_1',
      apiToken: 'cf_secret_token',
      dispatchNamespace: 'xd-cell-workers-production',
      fetch: async (request) =>
        request.url.endsWith('/scripts')
          ? Response.json({ success: true, result: [{ id: 'pages-v2-docs-ver-1' }], result_info: resultInfo })
          : Response.json({ success: true, result: { script_count: 1 } }),
    });

    await assert.rejects(
      () => client.listUserWorkers(),
      (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
    );
  }
});

test('listUserWorkers rejects repeated Worker names that could fake a complete paginated count', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 2 } });
      return Response.json({
        success: true,
        result: [{ id: 'pages-v2-docs-ver-1' }],
        result_info: { page: url.searchParams.get('page') === '2' ? 2 : 1, total_pages: 2 },
      });
    },
  });

  await assert.rejects(
    () => client.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
});

test('listUserWorkers rejects a paginated response for the wrong page', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 2 } });
      return Response.json({
        success: true,
        result: [{ id: url.searchParams.has('page') ? 'pages-v2-blog-ver-2' : 'pages-v2-docs-ver-1' }],
        result_info: { page: 1, total_pages: 2 },
      });
    },
  });

  await assert.rejects(
    () => client.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
});

test('listUserWorkers rejects first-page pagination metadata that starts after page one', async () => {
  let requests = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () => {
      requests += 1;
      return Response.json({
        success: true,
        result: [{ id: 'pages-v2-blog-ver-2' }],
        result_info: { page: 2, total_pages: 2 },
      });
    },
  });

  await assert.rejects(
    () => client.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
  assert.equal(requests, 1);
});

test('listUserWorkers rejects pagination totals above the strictest configured bound', async () => {
  let listRequests = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      if (!request.url.includes('/scripts')) return Response.json({ success: true, result: { script_count: 2 } });
      listRequests += 1;
      const page = new URL(request.url).searchParams.get('page');
      if (page === '2') {
        return Response.json({
          success: true,
          result: [{ id: 'pages-v2-site-2' }],
          result_info: { page: 2, total_pages: 2 },
        });
      }
      return Response.json({
        success: true,
        result: [{ id: 'pages-v2-site-1' }],
        result_info: { page: 1, total_pages: 2 },
      });
    },
  });

  await assert.rejects(
    () => client.listUserWorkers({ maxWorkers: 1, maxPages: 10 }),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
  assert.equal(listRequests, 1);
});

test('listUserWorkers rejects an empty first page that claims more pages', async () => {
  let listRequests = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      if (!request.url.includes('/scripts')) return Response.json({ success: true, result: { script_count: 1 } });
      listRequests += 1;
      return Response.json({
        success: true,
        result: [],
        result_info: { page: 1, total_pages: 10000 },
      });
    },
  });

  await assert.rejects(
    () => client.listUserWorkers({ maxWorkers: 10000 }),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
  assert.equal(listRequests, 1);
});

test('listUserWorkers retries the list once when script_count initially disagrees', async () => {
  let listRequests = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      if (!request.url.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 2 } });
      listRequests += 1;
      return Response.json({
        success: true,
        result: Array.from({ length: listRequests }, (_, index) => ({ id: `pages-v2-site-${index + 1}` })),
      });
    },
  });

  const inventory = await client.listUserWorkers();
  assert.equal(listRequests, 2);
  assert.equal(inventory.completeness, 'complete');
  assert.equal(inventory.scannedCount, 2);
  assert.equal(inventory.namespaceScriptCount, 2);
});

test('listUserWorkers reports incomplete after one retry still disagrees with script_count', async () => {
  let listRequests = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) => {
      if (!request.url.endsWith('/scripts')) return Response.json({ success: true, result: { script_count: 3 } });
      listRequests += 1;
      return Response.json({
        success: true,
        result: Array.from({ length: listRequests }, (_, index) => ({ id: `pages-v2-site-${index + 1}` })),
      });
    },
  });

  assert.deepEqual(await client.listUserWorkers(), {
    workers: [
      { name: 'pages-v2-site-1', created_on: null, modified_on: null },
      { name: 'pages-v2-site-2', created_on: null, modified_on: null },
    ],
    completeness: 'incomplete',
    scannedCount: 2,
    namespaceScriptCount: 3,
  });
  assert.equal(listRequests, 2);
});

test('listUserWorkers reports a complete empty namespace', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) =>
      request.url.endsWith('/scripts')
        ? Response.json({ success: true, result: [] })
        : Response.json({ success: true, result: { script_count: 0 } }),
  });

  assert.deepEqual(await client.listUserWorkers(), {
    workers: [],
    completeness: 'complete',
    scannedCount: 0,
    namespaceScriptCount: 0,
  });
});

test('listUserWorkers rejects a malformed namespace script_count instead of reporting a complete empty list', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async (request) =>
      request.url.endsWith('/scripts')
        ? Response.json({ success: true, result: [] })
        : Response.json({ success: true, result: { script_count: null } }),
  });

  await assert.rejects(
    () => client.listUserWorkers(),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID'
  );
});

test('listUserWorkers rejects a malformed list result without checking namespace details', async () => {
  let requests = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () => {
      requests += 1;
      return Response.json({ success: true, result: {} });
    },
  });

  await assert.rejects(
    () => client.listUserWorkers(),
    (error) =>
      error instanceof WfpApiError && error.code === 'WFP_API_RESPONSE_INVALID' && !error.message.includes('cf_secret_token')
  );
  assert.equal(requests, 1);
});

test('uploadUserWorker can upload static assets before deploying thin assets worker', async () => {
  const requests = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.url.endsWith('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [['hash_index']] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'pages-v2-docs-ver-1' } });
    },
  });

  const result = await client.uploadUserWorker({
    scriptName: 'pages-v2-docs-ver-1',
    decision: {
      deploymentShape: 'assets-only',
      requestedFallback: 'auto',
      resolvedFallback: 'index',
      routingMode: 'assets-only',
      workerEntry: null,
    },
    assetManifest: {
      '/index.html': { hash: 'hash_index', size: 5, content_type: 'text/html; charset=utf-8' },
    },
    assetFiles: [{ path: '/index.html', bytes: new globalThis.TextEncoder().encode('hello'), contentType: 'text/html' }],
    compatibilityDate: '2026-06-15',
    tags: ['pages-v2', 'production'],
    bindings: [{ type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' }],
  });

  assert.deepEqual(result, {
    scriptName: 'pages-v2-docs-ver-1',
    dispatchNamespace: 'xd-cell-workers-production',
    artifactRef: 'wfp://xd-cell-workers-production/pages-v2-docs-ver-1',
  });
  assert.equal(requests[0].method, 'POST');
  assert.ok(requests[0].url.endsWith('/scripts/pages-v2-docs-ver-1/assets-upload-session'));
  assert.equal(requests[1].method, 'POST');
  assert.ok(requests[1].url.includes('/workers/assets/upload?base64=true'));
  const assetUploadForm = await requests[1].formData();
  assert.equal(assetUploadForm.get('hash_index').type, 'text/html');
  assert.equal(await assetUploadForm.get('hash_index').text(), 'aGVsbG8=');
  const deployed = requests.find((request) => request.method === 'PUT');
  const form = await deployed.formData();
  assert.deepEqual(JSON.parse(await form.get('metadata').text()), {
    main_module: 'worker.mjs',
    compatibility_date: '2026-06-15',
    tags: ['pages-v2', 'production'],
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    ],
    assets: {
      jwt: 'completion-jwt',
      config: { not_found_handling: 'single-page-application' },
    },
  });
  assert.match(await form.get('worker.mjs').text(), /env\.ASSETS\.fetch/);
});

test('WFP assets upload session errors retain structured provider diagnostics', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10090, message: 'manifest rejected for cf_secret_token' }],
        },
        { status: 400, headers: { 'cf-ray': 'ray-session-1' } }
      ),
  });

  await assert.rejects(
    () => client.uploadUserWorker(assetsOnlyUploadInput()),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'assets_upload_session');
      assert.equal(error.status, 400);
      assert.equal(error.code, 'WFP_API_ERROR');
      assert.equal(error.providerCode, '10090');
      assert.equal(error.providerMessage, 'manifest rejected for [redacted]');
      assert.equal(error.providerRequestId, 'ray-session-1');
      assert.equal(error.message.includes('cf_secret_token'), false);
      return true;
    }
  );
});

test('WFP assets bucket upload errors redact the session JWT', async () => {
  let requestCount = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({ success: true, result: { jwt: 'session-jwt-secret', buckets: [['hash_index']] } });
      }
      return Response.json(
        {
          success: false,
          errors: [{ code: 10091, message: 'bucket upload failed with session-jwt-secret' }],
        },
        { status: 502, headers: { 'x-request-id': 'asset-upload-1' } }
      );
    },
  });

  await assert.rejects(
    () => client.uploadUserWorker(assetsOnlyUploadInput()),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'assets_upload');
      assert.equal(error.status, 502);
      assert.equal(error.providerCode, '10091');
      assert.equal(error.providerMessage, 'bucket upload failed with [redacted]');
      assert.equal(error.providerRequestId, 'asset-upload-1');
      assert.equal(error.message.includes('session-jwt-secret'), false);
      return true;
    }
  );
});

test('WFP Worker PUT errors retain provider diagnostics', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 'WORKER_PUT_FAILED', message: 'Worker upload rejected' }],
        },
        { status: 413, headers: { 'cf-ray': 'worker-put-1', 'x-request-id': 'fallback-should-not-win' } }
      ),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'worker_put');
      assert.equal(error.status, 413);
      assert.equal(error.providerCode, 'WORKER_PUT_FAILED');
      assert.equal(error.providerMessage, 'Worker upload rejected');
      assert.equal(error.providerRequestId, 'worker-put-1');
      return true;
    }
  );
});

test('WFP network errors are classified without fabricated provider fields', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () => {
      throw new Error('socket details must not escape');
    },
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'worker_put');
      assert.equal(error.code, 'WFP_NETWORK_ERROR');
      assert.equal(error.message, 'Cloudflare WFP request failed before receiving a response.');
      assert.equal('status' in error, false);
      assert.equal('providerCode' in error, false);
      assert.equal('providerRequestId' in error, false);
      assert.equal(error.message.includes('socket details'), false);
      return true;
    }
  );
});

test('WFP invalid JSON errors retain response metadata without network wrapping', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      new Response('{not-json', {
        status: 502,
        headers: { 'cf-ray': 'invalid-json-1' },
      }),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'worker_put');
      assert.equal(error.code, 'WFP_API_INVALID_JSON');
      assert.equal(error.status, 502);
      assert.equal(error.providerRequestId, 'invalid-json-1');
      assert.equal(error.providerCode, undefined);
      return true;
    }
  );
});

test('WFP provider metadata drops malformed identifiers and bounds message length', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: { nested: true }, message: `\u0000${'x'.repeat(600)}` }],
        },
        { status: 400, headers: { 'cf-ray': 'invalid ray', 'x-request-id': 'fallback-ray-1' } }
      ),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error.providerCode, undefined);
      assert.equal(error.providerMessage.length, 512);
      assert.equal(error.providerRequestId, 'fallback-ray-1');
      return true;
    }
  );
});

test('WFP provider request id rejects URLs and falls back to a safe header', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      Response.json(
        { success: false, errors: [{ code: 1000, message: 'provider rejected request' }] },
        {
          status: 502,
          headers: {
            'cf-ray': 'https://private.example.test/request',
            'x-request-id': 'safe-request-1',
          },
        }
      ),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error.providerRequestId, 'safe-request-1');
      return true;
    }
  );
});

test('WFP provider code and request id do not retain the API token', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 'cf_secret_token', message: 'provider rejected request' }],
        },
        { status: 400, headers: { 'cf-ray': 'cf_secret_token' } }
      ),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error.providerCode, undefined);
      assert.equal(error.providerRequestId, undefined);
      return true;
    }
  );
});

test('WFP provider code and request id do not retain an assets session JWT', async () => {
  let requestCount = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({ success: true, result: { jwt: 'session-jwt-secret', buckets: [['hash_index']] } });
      }
      return Response.json(
        {
          success: false,
          errors: [{ code: 'session-jwt-secret', message: 'bucket upload rejected' }],
        },
        { status: 502, headers: { 'x-request-id': 'session-jwt-secret' } }
      );
    },
  });

  await assert.rejects(
    () => client.uploadUserWorker(assetsOnlyUploadInput()),
    (error) => {
      assert.equal(error.providerCode, undefined);
      assert.equal(error.providerRequestId, undefined);
      return true;
    }
  );
});

test('WFP management operations keep fixed operation names across provider failure classes', async () => {
  const scriptName = 'pages-v2-staging-docs-ver-1';
  const cases = [
    {
      operation: 'worker_delete',
      invoke: (client) => client.deleteUserWorker(scriptName),
    },
    {
      operation: 'worker_settings_get',
      invoke: (client) => client.getUserWorkerSettings(scriptName),
    },
    {
      operation: 'worker_settings_patch',
      prepareSuccesses: 1,
      invoke: (client) =>
        client.updateUserWorkerBindings(scriptName, {
          bindings: [{ type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' }],
        }),
    },
    {
      operation: 'worker_secret_put',
      invoke: (client) => client.putUserWorkerSecret(scriptName, { name: 'API_TOKEN', value: 'secret-value' }),
    },
    {
      operation: 'worker_secret_delete',
      invoke: (client) => client.deleteUserWorkerSecret(scriptName, 'API_TOKEN'),
    },
  ];
  const failures = [
    {
      code: 'WFP_API_ERROR',
      response: () =>
        Response.json(
          { success: false, errors: [{ code: 1000, message: 'provider failure' }] },
          { status: 502, headers: { 'cf-ray': 'management-ray' } }
        ),
    },
    {
      code: 'WFP_API_INVALID_JSON',
      response: () => new Response('{not-json', { status: 502, headers: { 'cf-ray': 'management-ray' } }),
    },
    {
      code: 'WFP_NETWORK_ERROR',
      response: () => {
        throw new Error('network internals must not escape');
      },
    },
  ];

  for (const operationCase of cases) {
    for (const failure of failures) {
      let callCount = 0;
      const client = createWfpClient({
        accountId: 'account_1',
        apiToken: 'cf_secret_token',
        dispatchNamespace: 'xd-cell-workers-staging',
        fetch: async () => {
          callCount += 1;
          if (callCount <= (operationCase.prepareSuccesses || 0)) {
            return Response.json({ success: true, result: { bindings: [] } });
          }
          return failure.response();
        },
      });

      await assert.rejects(
        () => operationCase.invoke(client),
        (error) => {
          assert.equal(error instanceof WfpApiError, true);
          assert.equal(error.operation, operationCase.operation);
          assert.equal(error.code, failure.code);
          assert.equal(JSON.stringify(error).includes('cf_secret_token'), false);
          return true;
        },
        `${operationCase.operation}/${failure.code}`
      );
    }
  }
});

test('WFP settings shape errors retain the operation that read the invalid response', async () => {
  for (const invoke of [
    (client) => client.getUserWorkerSettings('pages-v2-staging-docs-ver-1'),
    (client) => client.updateUserWorkerBindings('pages-v2-staging-docs-ver-1', { bindings: [] }),
  ]) {
    const client = createWfpClient({
      accountId: 'account_1',
      apiToken: 'cf_secret_token',
      dispatchNamespace: 'xd-cell-workers-staging',
      fetch: async () => Response.json({ success: true, result: {} }),
    });
    await assert.rejects(
      () => invoke(client),
      (error) => {
        assert.equal(error instanceof WfpApiError, true);
        assert.equal(error.code, 'WFP_API_SETTINGS_INVALID');
        assert.equal(error.operation, 'worker_settings_get');
        return true;
      }
    );
  }
});

test('WfpApiError accepts only safe WFP client codes', () => {
  assert.equal(new WfpApiError({ code: 'WFP_CUSTOM_FAILURE' }).code, 'WFP_CUSTOM_FAILURE');
  assert.equal(new WfpApiError({ code: 'UNTRUSTED_FAILURE' }).code, 'WFP_API_ERROR');
  assert.equal(new WfpApiError({ code: `WFP_${'X'.repeat(65)}` }).code, 'WFP_API_ERROR');
});

test('WFP Worker PUT diagnostics redact the completion JWT and provider URLs', async () => {
  let callCount = 0;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () => {
      callCount += 1;
      if (callCount === 1) {
        return Response.json({ success: true, result: { jwt: 'session-jwt-secret', buckets: [['hash_index']] } });
      }
      if (callCount === 2) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt-secret' } });
      }
      return Response.json(
        {
          success: false,
          errors: [
            {
              code: 'completion-jwt-secret',
              message: 'completion-jwt-secret https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/private',
            },
          ],
        },
        { status: 502, headers: { 'cf-ray': 'completion-jwt-secret' } }
      );
    },
  });

  await assert.rejects(
    () => client.uploadUserWorker(assetsOnlyUploadInput()),
    (error) => {
      assert.equal(error.operation, 'worker_put');
      assert.equal(error.providerCode, undefined);
      assert.equal(error.providerRequestId, undefined);
      assert.equal(error.providerMessage.includes('completion-jwt-secret'), false);
      assert.equal(error.providerMessage.includes('https://'), false);
      assert.equal(error.message.includes('completion-jwt-secret'), false);
      assert.equal(error.message.includes('https://'), false);
      return true;
    }
  );
});

test('WFP Worker PUT diagnostics redact secret binding values', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 1000, message: 'Worker upload rejected runtime-secret-value' }],
        },
        { status: 502, headers: { 'cf-ray': 'worker-put-secret-1' } }
      ),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
        bindings: [{ type: 'secret_text', name: 'API_TOKEN', text: 'runtime-secret-value' }],
      }),
    (error) => {
      assert.equal(error.operation, 'worker_put');
      assert.equal(error.providerMessage, 'Worker upload rejected [redacted]');
      assert.equal(error.message.includes('runtime-secret-value'), false);
      assert.equal(JSON.stringify(error).includes('runtime-secret-value'), false);
      return true;
    }
  );
});

test('WFP diagnostics redact complete quoted credential values containing spaces', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-production',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 1000, message: 'provider rejected password="abc def"' }],
        },
        { status: 502, headers: { 'cf-ray': 'worker-put-quoted-secret-1' } }
      ),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error.providerMessage, 'provider rejected password="[redacted]"');
      assert.equal(error.message.includes('abc def'), false);
      assert.equal(JSON.stringify(error).includes('abc def'), false);
      return true;
    }
  );
});

test('get and delete user worker use dispatch namespace script endpoint', async () => {
  const calls = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      calls.push(request);
      if (request.method === 'GET') return multipartWorkerScriptResponse();
      return Response.json({ success: true, result: { id: 'pages-v2-staging-docs-ver-1' } });
    },
  });

  await client.getUserWorker('pages-v2-staging-docs-ver-1');
  await client.deleteUserWorker('pages-v2-staging-docs-ver-1');

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[0].url, calls[1].url);
});

test('WFP Worker verify GET errors retain structured provider diagnostics', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-staging',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10007, message: 'Worker lookup rejected for cf_secret_token' }],
        },
        { status: 404, headers: { 'cf-ray': 'worker-verify-1' } }
      ),
  });

  await assert.rejects(
    () => client.getUserWorker('pages-v2-staging-docs-ver-1'),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'worker_get');
      assert.equal(error.status, 404);
      assert.equal(error.code, 'WFP_API_ERROR');
      assert.equal(error.providerCode, '10007');
      assert.equal(error.providerMessage, 'Worker lookup rejected for [redacted]');
      assert.equal(error.providerRequestId, 'worker-verify-1');
      assert.equal(error.message.includes('cf_secret_token'), false);
      return true;
    }
  );
});

test('WFP Worker verify GET network errors stay safe and operation-scoped', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-staging',
    fetch: async () => {
      throw new Error('socket details must not escape');
    },
  });

  await assert.rejects(
    () => client.getUserWorker('pages-v2-staging-docs-ver-1'),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'worker_get');
      assert.equal(error.code, 'WFP_NETWORK_ERROR');
      assert.equal(error.message, 'Cloudflare WFP request failed before receiving a response.');
      assert.equal('status' in error, false);
      assert.equal('providerCode' in error, false);
      assert.equal('providerRequestId' in error, false);
      return true;
    }
  );
});

test('WFP Worker verify GET invalid JSON keeps response metadata', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'xd-cell-workers-staging',
    fetch: async () => new Response('{not-json', { status: 502, headers: { 'cf-ray': 'worker-verify-invalid-json' } }),
  });

  await assert.rejects(
    () => client.getUserWorker('pages-v2-staging-docs-ver-1'),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.operation, 'worker_get');
      assert.equal(error.code, 'WFP_API_INVALID_JSON');
      assert.equal(error.status, 502);
      assert.equal(error.providerRequestId, 'worker-verify-invalid-json');
      assert.equal(error.providerCode, undefined);
      return true;
    }
  );
});

test('put and delete user worker secret use dispatch namespace script secrets endpoint', async () => {
  const calls = [];
  const controller = new globalThis.AbortController();
  const scriptUrl =
    'https://api.cloudflare.com/client/v4/accounts/account_1/workers/dispatch/namespaces/xd-cell-workers-staging' +
    '/scripts/pages-v2-staging-docs-ver-1';
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      calls.push(request.clone());
      return Response.json({ success: true, result: { id: 'API_TOKEN' } });
    },
  });

  await client.putUserWorkerSecret(
    'pages-v2-staging-docs-ver-1',
    {
      name: 'API_TOKEN',
      value: 'secret-value',
    },
    { signal: controller.signal }
  );
  await client.deleteUserWorkerSecret('pages-v2-staging-docs-ver-1', 'API_TOKEN', { signal: controller.signal });
  controller.abort();

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `${scriptUrl}/secrets`);
  assert.deepEqual(await calls[0].json(), {
    name: 'API_TOKEN',
    text: 'secret-value',
    type: 'secret_text',
  });
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].url, `${scriptUrl}/secrets/API_TOKEN`);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, true);
});

test('updateUserWorkerBindings patches script settings and preserves non-plain-text bindings', async () => {
  const calls = [];
  const scriptUrl =
    'https://api.cloudflare.com/client/v4/accounts/account_1/workers/dispatch/namespaces/xd-cell-workers-staging' +
    '/scripts/pages-v2-staging-docs-ver-1';
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      calls.push(request.clone());
      if (request.method === 'GET') {
        return Response.json({
          success: true,
          result: {
            bindings: [
              { type: 'assets', name: 'ASSETS' },
              { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway-staging' },
              { type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: 'test-office-tunnel-id' },
              { type: 'secret_text', name: 'API_TOKEN' },
              { type: 'plain_text', name: 'API_BASE', text: 'https://old.example.com' },
              { type: 'plain_text', name: 'OLD_FLAG', text: '1' },
            ],
          },
        });
      }
      return Response.json({ success: true, result: { id: 'pages-v2-staging-docs-ver-1' } });
    },
  });

  await client.updateUserWorkerBindings('pages-v2-staging-docs-ver-1', {
    bindings: [{ type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' }],
  });

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${scriptUrl}/settings`);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, `${scriptUrl}/settings`);
  const form = await calls[1].formData();
  assert.deepEqual(JSON.parse(await form.get('settings').text()), {
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway-staging' },
      { type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: 'test-office-tunnel-id' },
      { type: 'secret_text', name: 'API_TOKEN' },
      { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
    ],
  });
  assert.deepEqual([...form.keys()], ['settings']);
});

test('updateUserWorkerBindings removes plain-text bindings on delete without touching assets or secrets', async () => {
  const calls = [];
  const scriptUrl =
    'https://api.cloudflare.com/client/v4/accounts/account_1/workers/dispatch/namespaces/xd-cell-workers-staging' +
    '/scripts/pages-v2-staging-docs-ver-1';
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      calls.push(request.clone());
      if (request.method === 'GET') {
        return Response.json({
          success: true,
          result: {
            bindings: [
              { type: 'assets', name: 'ASSETS' },
              { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway-staging' },
              { type: 'secret_text', name: 'API_TOKEN' },
              { type: 'plain_text', name: 'API_BASE', text: 'https://old.example.com' },
            ],
          },
        });
      }
      return Response.json({ success: true, result: { id: 'pages-v2-staging-docs-ver-1' } });
    },
  });

  await client.updateUserWorkerBindings('pages-v2-staging-docs-ver-1', { bindings: [] });

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, `${scriptUrl}/settings`);
  const form = await calls[1].formData();
  assert.deepEqual(JSON.parse(await form.get('settings').text()), {
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway-staging' },
      { type: 'secret_text', name: 'API_TOKEN' },
    ],
  });
});

test('updateUserWorkerBindings rejects a successful settings response without bindings before PATCH', async () => {
  const methods = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      methods.push(request.method);
      return new Response(null, { status: 200 });
    },
  });

  await assert.rejects(
    client.updateUserWorkerBindings('pages-v2-staging-docs-ver-1', {
      bindings: [{ type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' }],
    }),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_SETTINGS_INVALID'
  );
  assert.deepEqual(methods, ['GET']);
});

test('removeOfficeNetBinding removes only the platform OfficeNet binding', async () => {
  const calls = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      calls.push(request.clone());
      if (request.method === 'GET') {
        return Response.json({
          success: true,
          result: {
            bindings: [
              { type: 'assets', name: 'ASSETS' },
              { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway-staging' },
              { type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: 'office-tunnel' },
              { type: 'vpc_network', name: 'OTHER_VPC', tunnel_id: 'other-tunnel' },
              { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
              { type: 'secret_text', name: 'API_TOKEN', text: 'redacted' },
            ],
          },
        });
      }
      return Response.json({ success: true, result: { id: 'pages-v2-staging-docs-ver-1' } });
    },
  });

  const result = await client.removeOfficeNetBinding('pages-v2-staging-docs-ver-1');

  assert.equal(result.removed, true);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PATCH');
  const form = await calls[1].formData();
  assert.deepEqual(JSON.parse(await form.get('settings').text()), {
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway-staging' },
      { type: 'vpc_network', name: 'OTHER_VPC', tunnel_id: 'other-tunnel' },
      { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
      { type: 'secret_text', name: 'API_TOKEN', text: 'redacted' },
    ],
  });
});

test('removeOfficeNetBinding is a no-op when the platform binding is absent', async () => {
  const methods = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      methods.push(request.method);
      return Response.json({ success: true, result: { bindings: [{ type: 'service', name: 'OTHER', service: 'other' }] } });
    },
  });

  const result = await client.removeOfficeNetBinding('pages-v2-staging-docs-ver-1');

  assert.equal(result.removed, false);
  assert.deepEqual(methods, ['GET']);
});

test('removeOfficeNetBinding rejects settings without bindings and propagates patch failures', async () => {
  const invalidClient = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    fetch: async () => Response.json({ success: true, result: {} }),
  });
  await assert.rejects(
    invalidClient.removeOfficeNetBinding('pages-v2-staging-docs-ver-1'),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_SETTINGS_INVALID'
  );

  const failingClient = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    fetch: async (request) => {
      if (request.method === 'GET') {
        return Response.json({
          success: true,
          result: { bindings: [{ type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: 'office-tunnel' }] },
        });
      }
      return Response.json({ success: false, errors: [{ code: 1000, message: 'patch failed' }] }, { status: 500 });
    },
  });
  await assert.rejects(
    failingClient.removeOfficeNetBinding('pages-v2-staging-docs-ver-1'),
    (error) => error instanceof WfpApiError
  );
});

test('removeOfficeNetBinding fails closed for malformed settings bindings', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    fetch: async () => Response.json({ success: true, result: { bindings: [null] } }),
  });

  await assert.rejects(
    client.removeOfficeNetBinding('pages-v2-staging-docs-ver-1'),
    (error) => error instanceof WfpApiError && error.code === 'WFP_API_SETTINGS_INVALID'
  );
});

test('verifyOfficeNetAbsent reports the current binding state', async () => {
  let includeOfficeNet = true;
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    fetch: async () =>
      Response.json({
        success: true,
        result: {
          bindings: includeOfficeNet
            ? [{ type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: 'office-tunnel' }]
            : [{ type: 'service', name: 'OTHER', service: 'other' }],
        },
      }),
  });

  assert.equal(await client.verifyOfficeNetAbsent('pages-v2-staging-docs-ver-1'), false);
  includeOfficeNet = false;
  assert.equal(await client.verifyOfficeNetAbsent('pages-v2-staging-docs-ver-1'), true);
});

test('updateUserWorkerBindings stops before PATCH when its signal aborts after GET', async () => {
  const controller = new globalThis.AbortController();
  const methods = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'xd-cell-workers-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      methods.push(request.method);
      if (request.signal.aborted) throw request.signal.reason;
      controller.abort(new Error('provider timeout'));
      return Response.json({ success: true, result: { bindings: [] } });
    },
  });

  await assert.rejects(
    client.updateUserWorkerBindings('pages-v2-staging-docs-ver-1', {
      bindings: [{ type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' }],
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.code, 'WFP_NETWORK_ERROR');
      assert.equal(error.message, 'Cloudflare WFP request failed before receiving a response.');
      assert.equal(error.operation, 'worker_settings_patch');
      return true;
    }
  );
  assert.deepEqual(methods, ['GET', 'PATCH']);
});

test('normalizeWorkerBindings accepts service plain text secret text and VPC network bindings', () => {
  assert.deepEqual(
    normalizeWorkerBindings([
      { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
      { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
      { type: 'secret_text', name: 'API_TOKEN', text: 'secret-value' },
      {
        type: 'vpc_network',
        name: 'XD_OFFICE_NET',
        tunnel_id: 'test-office-tunnel-id',
      },
    ]),
    [
      { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
      { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
      { type: 'secret_text', name: 'API_TOKEN', text: 'secret-value' },
      {
        type: 'vpc_network',
        name: 'XD_OFFICE_NET',
        tunnel_id: 'test-office-tunnel-id',
      },
    ]
  );
  assert.throws(
    () => normalizeWorkerBindings([{ type: 'plain_text', name: 'bad-name', text: 'x' }]),
    /WORKER_BINDING_NAME_INVALID/
  );
  assert.throws(
    () => normalizeWorkerBindings([{ type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: '' }]),
    /WORKER_VPC_TUNNEL_ID_INVALID/
  );
  assert.throws(
    () => normalizeWorkerBindings([{ type: 'kv_namespace', name: 'KV', namespace_id: 'ns_1' }]),
    /WORKER_BINDING_TYPE_INVALID/
  );
});

test('Cloudflare API errors are redacted', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'super-secret-token',
    dispatchNamespace: 'xd-cell-workers-production',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: 'request with super-secret-token failed' }],
        },
        { status: 403 }
      ),
  });

  await assert.rejects(
    () =>
      client.uploadUserWorker({
        scriptName: 'pages-v2-docs-ver-1',
        mainModule: 'worker.mjs',
        modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
      }),
    (error) => {
      assert.equal(error instanceof WfpApiError, true);
      assert.equal(error.status, 403);
      assert.equal(error.message.includes('super-secret-token'), false);
      assert.equal(error.message.includes('[redacted]'), true);
      return true;
    }
  );
});

test('validateScriptName rejects unsafe script names', () => {
  assert.equal(validateScriptName('pages-v2-docs-ver-1'), 'pages-v2-docs-ver-1');
  assert.throws(() => validateScriptName('../secret'), /WFP_SCRIPT_NAME_INVALID/);
  assert.throws(() => validateScriptName('pages v2'), /WFP_SCRIPT_NAME_INVALID/);
});

function assetsOnlyUploadInput() {
  return {
    scriptName: 'pages-v2-docs-ver-1',
    decision: {
      deploymentShape: 'assets-only',
      requestedFallback: 'auto',
      resolvedFallback: 'index',
      routingMode: 'assets-only',
      workerEntry: null,
    },
    assetManifest: {
      '/index.html': { hash: 'hash_index', size: 5, content_type: 'text/html; charset=utf-8' },
    },
    assetFiles: [{ path: '/index.html', bytes: new globalThis.TextEncoder().encode('hello'), contentType: 'text/html' }],
  };
}

function multipartWorkerScriptResponse() {
  return new Response(
    [
      '--form-boundary',
      'Content-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"',
      'Content-Type: application/javascript+module',
      '',
      'export default {};',
      '--form-boundary--',
      '',
    ].join('\r\n'),
    {
      status: 200,
      headers: { 'Content-Type': 'multipart/form-data; boundary=form-boundary' },
    }
  );
}
