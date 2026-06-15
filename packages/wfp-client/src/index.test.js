import assert from 'node:assert/strict';
import test from 'node:test';

import { WfpApiError, createWfpClient, readWfpConfig, validateScriptName } from './index.js';

test('readWfpConfig enforces production and staging namespace isolation', () => {
  assert.deepEqual(
    readWfpConfig(
      {
        CF_ACCOUNT_ID: 'account_1',
        CF_API_TOKEN: 'cf_secret_token',
        WFP_DISPATCH_NAMESPACE: 'pages-production',
      },
      { environment: 'production' }
    ),
    {
      accountId: 'account_1',
      apiToken: 'cf_secret_token',
      dispatchNamespace: 'pages-production',
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
          WFP_DISPATCH_NAMESPACE: 'pages-staging',
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
          WFP_DISPATCH_NAMESPACE: 'pages-production',
        },
        { environment: 'staging' }
      ),
    /WFP_DISPATCH_NAMESPACE/
  );
});

test('readWfpConfig fails closed on missing credentials and unsafe API origins', () => {
  assert.throws(() => readWfpConfig({ CF_API_TOKEN: 'token', WFP_DISPATCH_NAMESPACE: 'pages-production' }), /CF_ACCOUNT_ID/);
  assert.throws(() => readWfpConfig({ CF_ACCOUNT_ID: 'account', WFP_DISPATCH_NAMESPACE: 'pages-production' }), /CF_API_TOKEN/);
  assert.throws(
    () =>
      readWfpConfig(
        {
          CF_ACCOUNT_ID: 'account',
          CF_API_TOKEN: 'token',
          WFP_DISPATCH_NAMESPACE: 'pages-production',
          CF_API_BASE_URL: 'https://api.cloudflare.com/client/v4/path',
        },
        { environment: 'production' }
      ),
    /CF_API_BASE_URL/
  );
});

test('uploadUserWorker sends multipart metadata and module to dispatch namespace endpoint', async () => {
  const requests = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    dispatchNamespace: 'pages-production',
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
  });

  assert.deepEqual(result, {
    scriptName: 'pages-v2-docs-ver-1',
    dispatchNamespace: 'pages-production',
    artifactRef: 'wfp://pages-production/pages-v2-docs-ver-1',
  });
  assert.equal(
    requests[0].url,
    [
      'https://api.cloudflare.com/client/v4/accounts/account_1',
      'workers/dispatch/namespaces/pages-production/scripts/pages-v2-docs-ver-1',
    ].join('/')
  );
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer cf_secret_token');
  const form = await requests[0].formData();
  assert.deepEqual(JSON.parse(await form.get('metadata').text()), {
    main_module: 'worker.mjs',
    compatibility_date: '2026-06-15',
    tags: ['pages-v2', 'production'],
  });
  assert.equal(await form.get('worker.mjs').text(), 'export default {};');
  assert.equal(form.get('worker.mjs').type, 'application/javascript+module');
});

test('get and delete user worker use dispatch namespace script endpoint', async () => {
  const calls = [];
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'token',
    dispatchNamespace: 'pages-staging',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ success: true, result: { id: 'pages-v2-staging-docs-ver-1' } });
    },
  });

  await client.getUserWorker('pages-v2-staging-docs-ver-1');
  await client.deleteUserWorker('pages-v2-staging-docs-ver-1');

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[0].url, calls[1].url);
});

test('Cloudflare API errors are redacted', async () => {
  const client = createWfpClient({
    accountId: 'account_1',
    apiToken: 'super-secret-token',
    dispatchNamespace: 'pages-production',
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
