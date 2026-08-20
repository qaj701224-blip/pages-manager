import assert from 'node:assert/strict';
import test from 'node:test';

import { WfpApiError } from '@xd/wfp-client';
import * as executionProvider from './execution-provider.js';

const SCRIPT_NAME = 'pages-v2-production-slot-007';
const encoder = new globalThis.TextEncoder();

test('ordinary Worker client exposes fixed safe diagnostics for every Cloudflare operation', async () => {
  assert.equal(typeof executionProvider.createOrdinaryWorkerClient, 'function');

  const operationCases = [
    {
      operation: 'worker_subdomain_disable',
      failureAt: 1,
      invoke: (client) => client.uploadWorker(workerOnlyInput()),
    },
    {
      operation: 'worker_put',
      failureAt: 2,
      invoke: (client) => client.uploadWorker(workerOnlyInput()),
    },
    {
      operation: 'worker_get',
      failureAt: 1,
      invoke: (client) => client.getWorker(SCRIPT_NAME),
    },
    {
      operation: 'worker_delete',
      failureAt: 1,
      invoke: (client) => client.deleteWorker(SCRIPT_NAME),
    },
    {
      operation: 'worker_placeholder_put',
      failureAt: 2,
      invoke: (client) => client.putPlaceholderWorker({ scriptName: SCRIPT_NAME }),
    },
    {
      operation: 'assets_upload_session',
      failureAt: 2,
      invoke: (client) => client.uploadWorker(assetsOnlyInput()),
    },
    {
      operation: 'assets_upload',
      failureAt: 3,
      invoke: (client) => client.uploadWorker(assetsOnlyInput()),
    },
  ];
  const failureModes = [
    {
      code: 'WFP_API_ERROR',
      response: () =>
        Response.json(
          {
            success: false,
            errors: [
              {
                code: 1000,
                message:
                  'provider rejected cf_secret_token runtime-secret-value ' +
                  'https://api.cloudflare.com/client/v4/accounts/account_1',
              },
            ],
          },
          { status: 502, headers: { 'cf-ray': 'ordinary-ray-1' } }
        ),
    },
    {
      code: 'WFP_API_INVALID_JSON',
      response: () => new Response('{not-json', { status: 502, headers: { 'cf-ray': 'ordinary-ray-1' } }),
    },
    {
      code: 'WFP_NETWORK_ERROR',
      response: () => {
        throw new Error('network internals must not escape');
      },
    },
  ];

  for (const operationCase of operationCases) {
    for (const failureMode of failureModes) {
      let requestCount = 0;
      const client = executionProvider.createOrdinaryWorkerClient(
        {
          CF_ACCOUNT_ID: 'account_1',
          CF_API_TOKEN: 'cf_secret_token',
          fetch: async (request) => {
            requestCount += 1;
            if (requestCount === operationCase.failureAt) return failureMode.response();
            if (request.url.includes('/assets-upload-session')) {
              return Response.json({ success: true, result: { jwt: 'session-jwt-secret', buckets: [['hash_index']] } });
            }
            if (request.url.includes('/workers/assets/upload')) {
              return Response.json({ success: true, result: { jwt: 'completion-jwt-secret' } });
            }
            return Response.json({ success: true, result: { id: 'ok' } });
          },
        },
        { environment: 'production' }
      );

      await assert.rejects(
        () => operationCase.invoke(client),
        (error) => {
          assert.equal(error instanceof WfpApiError, true);
          assert.equal(error.operation, operationCase.operation);
          assert.equal(error.code, failureMode.code);
          if (failureMode.code === 'WFP_API_ERROR') {
            assert.equal(error.status, 502);
            assert.equal(error.providerCode, '1000');
            assert.equal(error.providerRequestId, 'ordinary-ray-1');
            assert.equal(error.providerMessage.includes('cf_secret_token'), false);
            if (operationCase.operation === 'worker_put') {
              assert.equal(error.providerMessage.includes('runtime-secret-value'), false);
            }
            assert.equal(error.providerMessage.includes('https://'), false);
          } else if (failureMode.code === 'WFP_API_INVALID_JSON') {
            assert.equal(error.status, 502);
            assert.equal(error.providerRequestId, 'ordinary-ray-1');
            assert.equal('providerCode' in error, false);
          } else {
            assert.equal('status' in error, false);
            assert.equal('providerCode' in error, false);
            assert.equal('providerRequestId' in error, false);
          }
          assert.equal(JSON.stringify(error).includes('cf_secret_token'), false);
          if (operationCase.operation === 'worker_put') {
            assert.equal(JSON.stringify(error).includes('runtime-secret-value'), false);
          }
          return true;
        },
        `${operationCase.operation}/${failureMode.code}`
      );
    }
  }
});

function workerOnlyInput() {
  return {
    scriptName: SCRIPT_NAME,
    mainModule: 'worker.mjs',
    modules: [{ name: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' }],
    decision: { deploymentShape: 'worker-only' },
    bindings: [{ type: 'secret_text', name: 'API_TOKEN', text: 'runtime-secret-value' }],
  };
}

function assetsOnlyInput() {
  return {
    scriptName: SCRIPT_NAME,
    decision: {
      deploymentShape: 'assets-only',
      resolvedFallback: 'not-found',
      routingMode: 'assets-only',
    },
    assetManifest: {
      '/index.html': { hash: 'hash_index', size: 5, content_type: 'text/html' },
    },
    assetFiles: [{ path: '/index.html', bytes: encoder.encode('hello'), contentType: 'text/html' }],
  };
}
