import assert from 'node:assert/strict';
import test from 'node:test';

import { PagesSDKError, createPagesRuntime } from '../dist/worker.js';

test('createPagesRuntime().kv.get calls the gateway service binding and returns value', async () => {
  let captured;
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (request) => {
          captured = request;
          return Response.json({ ok: true, found: true, value: { enabled: true } });
        },
      },
    },
  });

  const value = await runtime.kv.get('app/config');

  assert.deepEqual(value, { enabled: true });
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/get');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('Authorization'), 'Bearer capability-token');
  assert.equal(captured.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'json' });
});

test('createPagesRuntime rejects gateway error envelopes', async () => {
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => Response.json({ ok: false, error: { code: 'KV_FAILED', message: 'KV failed' } }),
      },
    },
  });

  await assert.rejects(() => runtime.kv.get('app/config'), {
    code: 'KV_FAILED',
    message: 'KV failed',
  });
});

test('createPagesRuntime throws invalid runtime response for get envelopes without found', async () => {
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => Response.json({ ok: true }),
      },
    },
  });

  await assert.rejects(() => runtime.kv.get('app/config'), {
    code: 'INVALID_RUNTIME_RESPONSE',
  });
});

test('createPagesRuntime throws invalid runtime response for non-JSON gateway responses', async () => {
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => new Response('not json', { headers: { 'Content-Type': 'text/plain' } }),
      },
    },
  });

  await assert.rejects(() => runtime.kv.get('app/config'), (error) => {
    assert.ok(error instanceof PagesSDKError);
    assert.equal(error.code, 'INVALID_RUNTIME_RESPONSE');
    return true;
  });
});

test('createPagesRuntime().kv.put calls the gateway put endpoint', async () => {
  let captured;
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (request) => {
          captured = request;
          return Response.json({ ok: true });
        },
      },
    },
  });

  await runtime.kv.put('app/config', 'hello', { type: 'text', expirationTtl: 60 });

  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/put');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('Authorization'), 'Bearer capability-token');
  assert.deepEqual(await captured.json(), {
    key: 'app/config',
    value: 'hello',
    type: 'text',
    expirationTtl: 60,
  });
});

test('createPagesRuntime().kv.delete calls the gateway delete endpoint', async () => {
  let captured;
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (request) => {
          captured = request;
          return Response.json({ ok: true });
        },
      },
    },
  });

  await runtime.kv.delete('app/config');

  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/delete');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('Authorization'), 'Bearer capability-token');
  assert.deepEqual(await captured.json(), { key: 'app/config' });
});
