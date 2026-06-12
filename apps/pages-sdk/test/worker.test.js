import assert from 'node:assert/strict';
import test from 'node:test';

import { createPagesRuntime } from '../dist/worker.js';

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
