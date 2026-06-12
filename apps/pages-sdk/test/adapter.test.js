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

test('handlePagesRuntimeRequest rejects mismatched Origin with 403', async () => {
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
      headers: { Origin: 'https://evil.example' },
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
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual(await responseJson(response), { ok: true, found: true, value: 'ok' });
});

test('handlePagesRuntimeRequest returns checkAccess responses without dispatching', async () => {
  let dispatched = false;
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get'),
    {
      ...env,
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => {
          dispatched = true;
          return Response.json({ ok: true });
        },
      },
    },
    { checkAccess: async () => new Response('blocked', { status: 401 }) }
  );

  assert.equal(response.status, 401);
  assert.equal(await response.text(), 'blocked');
  assert.equal(dispatched, false);
});

test('handlePagesRuntimeRequest rejects invalid JSON with INVALID_JSON', async () => {
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', { body: '{' }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 400);
  assert.equal((await responseJson(response)).error.code, 'INVALID_JSON');
});

test('handlePagesRuntimeRequest validates key and type', async () => {
  const invalidKey = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
      body: JSON.stringify({ key: '.xd-pages/runtime', type: 'json' }),
    }),
    env,
    { checkAccess: async () => null }
  );
  const invalidType = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
      body: JSON.stringify({ key: 'app/config', type: 'binary' }),
    }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(invalidKey.status, 400);
  assert.equal((await responseJson(invalidKey)).error.code, 'INVALID_KEY');
  assert.equal(invalidType.status, 400);
  assert.equal((await responseJson(invalidType)).error.code, 'INVALID_TYPE');
});

test('handlePagesRuntimeRequest validates put ttl', async () => {
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/put', {
      body: JSON.stringify({ key: 'app/config', value: 'hello', type: 'text', expirationTtl: 59 }),
    }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 400);
  assert.equal((await responseJson(response)).error.code, 'INVALID_TTL');
});

test('handlePagesRuntimeRequest dispatches valid put and delete requests', async () => {
  const calls = [];
  const dispatchEnv = {
    XD_PAGES_KV_CAPABILITY: 'capability-token',
    XD_PAGES_KV_GATEWAY: {
      fetch: async (request) => {
        calls.push({ url: request.url, body: await request.json() });
        return Response.json({ ok: true });
      },
    },
  };

  const putResponse = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/put', {
      body: JSON.stringify({ key: 'app/config', value: 'hello', type: 'text', expirationTtl: 60 }),
    }),
    dispatchEnv,
    { checkAccess: async () => null }
  );
  const deleteResponse = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/delete', {
      body: JSON.stringify({ key: 'app/config' }),
    }),
    dispatchEnv,
    { checkAccess: async () => null }
  );

  assert.equal(putResponse.status, 200);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(calls, [
    {
      url: 'https://pages-kv-gateway.local/v1/kv/put',
      body: { key: 'app/config', value: 'hello', type: 'text', expirationTtl: 60 },
    },
    {
      url: 'https://pages-kv-gateway.local/v1/kv/delete',
      body: { key: 'app/config' },
    },
  ]);
});
