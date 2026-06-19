import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGES_RUNTIME_SOURCE } from '../dist/internal/runtime-source.js';

test('PAGES_RUNTIME_SOURCE is self-contained runtime source text', () => {
  assert.equal(typeof PAGES_RUNTIME_SOURCE, 'string');
  assert.match(PAGES_RUNTIME_SOURCE, /handlePagesRuntimeRequest/);
  assert.doesNotMatch(PAGES_RUNTIME_SOURCE, /from\s+['"]@xd\//);
  assert.doesNotMatch(PAGES_RUNTIME_SOURCE, /import\(['"]@xd\//);
});

test('PAGES_RUNTIME_SOURCE handles valid get requests', async () => {
  const { handlePagesRuntimeRequest } = loadInlineRuntime();
  let captured;
  const response = await handlePagesRuntimeRequest(runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
    headers: { 'CF-Platform-KV-Capability': 'request-capability-token' },
  }), {
    XD_PAGES_KV_GATEWAY: {
      fetch: async (request) => {
        captured = request;
        return Response.json({ ok: true, found: true, value: { enabled: true } });
      },
    },
  }, {
    checkAccess: async () => null,
  });

  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer request-capability-token');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'json' });
  assert.deepEqual(await response.json(), { ok: true, found: true, value: { enabled: true } });
});

test('PAGES_RUNTIME_SOURCE handles site and user data capabilities', async () => {
  const { handlePagesRuntimeRequest } = loadInlineRuntime();
  const calls = [];
  const headers = {
    'CF-Platform-Data-Site-Capability': 'site-request-capability',
    'CF-Platform-Data-User-Capability': 'user-request-capability',
  };
  const env = {
    XD_PAGES_KV_GATEWAY: {
      fetch: async (request) => {
        calls.push({
          url: request.url,
          authorization: request.headers.get('Authorization'),
          body: await request.json(),
        });
        return Response.json({ ok: true, found: false, value: null });
      },
    },
  };

  const siteResponse = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/data/site/get', { headers }),
    env,
    { checkAccess: async () => null }
  );
  const userResponse = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/data/user/get', { headers }),
    env,
    { checkAccess: async () => null }
  );

  assert.equal(siteResponse.status, 200);
  assert.equal(userResponse.status, 200);
  assert.deepEqual(calls, [
    {
      url: 'https://pages-kv-gateway.local/v1/data/site/get',
      authorization: 'Bearer site-request-capability',
      body: { key: 'app/config', type: 'json' },
    },
    {
      url: 'https://pages-kv-gateway.local/v1/data/user/get',
      authorization: 'Bearer user-request-capability',
      body: { key: 'app/config', type: 'json' },
    },
  ]);
});

test('PAGES_RUNTIME_SOURCE uses legacy path for site data when only legacy capability exists', async () => {
  const { handlePagesRuntimeRequest } = loadInlineRuntime();
  let captured;
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/data/site/get'),
    {
      XD_PAGES_KV_CAPABILITY: 'legacy-env-capability',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (request) => {
          captured = request;
          return Response.json({ ok: true, found: true, value: 'legacy-ok' }, { headers: { Deprecation: 'true' } });
        },
      },
    },
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Deprecation'), 'true');
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer legacy-env-capability');
  assert.deepEqual(await response.json(), { ok: true, found: true, value: 'legacy-ok' });
});

test('PAGES_RUNTIME_SOURCE validates data requests with data wording', async () => {
  const { handlePagesRuntimeRequest } = loadInlineRuntime();
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/data/user/get', {
      body: JSON.stringify({ key: '.xd-pages/runtime', type: 'binary' }),
    }),
    {},
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).error, { code: 'INVALID_KEY', message: 'Invalid data key' });
});

test('PAGES_RUNTIME_SOURCE returns null for non-runtime paths and fails closed without access checks', async () => {
  const { handlePagesRuntimeRequest } = loadInlineRuntime();

  assert.equal(await handlePagesRuntimeRequest(new Request('https://site.example/app'), {}), null);

  const response = await handlePagesRuntimeRequest(runtimeRequest('/.xd-pages/runtime/v1/kv/get'), {});
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FORBIDDEN');
});

test('PAGES_RUNTIME_SOURCE validates runtime request type', async () => {
  const { handlePagesRuntimeRequest } = loadInlineRuntime();
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get', {
      body: JSON.stringify({ key: 'app/config', type: 'binary' }),
    }),
    {},
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_TYPE');
});

test('PAGES_RUNTIME_SOURCE returns KV_FAILED envelope when gateway fetch throws', async () => {
  const { handlePagesRuntimeRequest } = loadInlineRuntime();
  const response = await handlePagesRuntimeRequest(
    runtimeRequest('/.xd-pages/runtime/v1/kv/get'),
    {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => {
          throw new Error('gateway unavailable');
        },
      },
    },
    { checkAccess: async () => null }
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'KV_FAILED');
});

function loadInlineRuntime() {
  const source = PAGES_RUNTIME_SOURCE.replace(
    'export async function handlePagesRuntimeRequest',
    'async function handlePagesRuntimeRequest'
  );
  return new Function(`${source}; return { handlePagesRuntimeRequest };`)();
}

function runtimeRequest(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-XD-Pages-Runtime': '1',
    ...init.headers,
  };

  return new Request(`https://site.example${path}`, {
    method: 'POST',
    body: JSON.stringify({ key: 'app/config' }),
    ...init,
    headers,
  });
}
