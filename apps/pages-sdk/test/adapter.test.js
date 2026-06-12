import assert from 'node:assert/strict';
import test from 'node:test';

import { handlePagesRuntimeRequest } from '../dist/worker.js';

const env = {
  XD_PAGES_KV_CAPABILITY: 'capability-token',
  XD_PAGES_KV_GATEWAY: {
    fetch: async () => Response.json({ ok: true, found: true, value: 'ok' }),
  },
};

function runtimeRequest(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-XD-Pages-Runtime': '1',
    ...init.headers,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) delete headers[name];
  }

  return new Request(`https://site.example${path}`, {
    method: 'POST',
    body: JSON.stringify({ key: 'app/config' }),
    ...init,
    headers,
  });
}

async function responseJson(response) {
  assert.ok(response);
  return response.json();
}

test('handlePagesRuntimeRequest returns null for non-runtime paths', async () => {
  assert.equal(await handlePagesRuntimeRequest(new Request('https://site.example/app')), null);
});

test('handlePagesRuntimeRequest fails closed without checkAccess', async () => {
  const response = await handlePagesRuntimeRequest(runtimeRequest('/.xd-pages/runtime/v1/kv/get'), env);

  assert.equal(response.status, 403);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: { code: 'FORBIDDEN', message: 'Forbidden' },
  });
});

test('handlePagesRuntimeRequest rejects GET with 405', async () => {
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', { method: 'GET', body: undefined }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 405);
});

test('handlePagesRuntimeRequest rejects missing JSON content type with 415', async () => {
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
      headers: { 'Content-Type': undefined },
    }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 415);
});

test('handlePagesRuntimeRequest rejects missing runtime header with 403', async () => {
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
      headers: { 'X-XD-Pages-Runtime': undefined },
    }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 403);
});

test('handlePagesRuntimeRequest rejects cross-site fetch metadata with 403', async () => {
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 403);
});

test('handlePagesRuntimeRequest dispatches valid get requests', async () => {
  const response = await handlePagesRuntimeRequest(runtimeRequest('/.xd-pages/runtime/v1/kv/get'), env, {
    checkAccess: async () => null,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { ok: true, found: true, value: 'ok' });
});
