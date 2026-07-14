import assert from 'node:assert/strict';
import test from 'node:test';

import { SDKError, createRuntime, getCurrentUser, readContext } from '../dist/worker/index.js';

const platformPayload = {
  iss: 'pages-router',
  aud: 'pages-v2-demo-worker',
  env: 'production',
  purpose: 'internal_worker_jwt',
  sub: 'usr_1',
  iat: 1_700_000_000,
  nbf: 1_700_000_000,
  exp: 1_700_000_060,
  siteId: 'site_demo',
  siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
  routeId: 'route_demo',
  slug: 'demo',
  versionId: 'ver_demo',
  policyVersion: 3,
  traceId: 'trace_demo',
  anonymous: false,
  user: {
    id: 'usr_1',
    email: 'user@example.com',
    accountId: 'acct_user_1',
    name: 'Example User',
    departments: ['XD/Platform/Web'],
    employeeStatus: 'active',
  },
};

function unsignedJwt(payload = platformPayload) {
  return [
    base64UrlJson({ alg: 'HS256', typ: 'JWT', kid: 'session-2026-06' }),
    base64UrlJson(payload),
    'signature',
  ].join('.');
}

function platformRequest(payload = platformPayload, headers = {}) {
  return new Request('https://demo.pages.xd.team/', {
    headers: {
      'CF-Platform-Auth': unsignedJwt(payload),
      'CF-Platform-User': payload.sub,
      'CF-Platform-Site-Id': payload.siteId,
      'CF-Platform-Site-Slug': payload.slug,
      'CF-Platform-Version': payload.versionId,
      'CF-Platform-Trace-Id': payload.traceId,
      ...headers,
    },
  });
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('readContext reads minimal router-injected identity without exposing the JWT as capability', () => {
  const context = readContext(platformRequest());

  assert.deepEqual(context, {
    authenticated: true,
    anonymous: false,
    userId: 'usr_1',
    user: {
      id: 'usr_1',
      email: 'user@example.com',
      accountId: 'acct_user_1',
      name: 'Example User',
      departments: ['XD/Platform/Web'],
      employeeStatus: 'active',
    },
    siteId: 'site_demo',
    siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
    siteSlug: 'demo',
    routeId: 'route_demo',
    versionId: 'ver_demo',
    policyVersion: 3,
    traceId: 'trace_demo',
    environment: 'production',
  });
  assert.equal(Object.hasOwn(context, 'token'), false);
  assert.equal(Object.hasOwn(context, 'capability'), false);
});

test('getCurrentUser returns the authenticated user from readContext', () => {
  assert.deepEqual(getCurrentUser(platformRequest()), {
    id: 'usr_1',
    email: 'user@example.com',
    accountId: 'acct_user_1',
    name: 'Example User',
    departments: ['XD/Platform/Web'],
    employeeStatus: 'active',
  });
});

test('getCurrentUser keeps legacy platform tokens compatible', () => {
  const legacyPayload = { ...platformPayload };
  delete legacyPayload.user;

  assert.deepEqual(getCurrentUser(platformRequest(legacyPayload)), {
    id: 'usr_1',
    email: null,
    accountId: null,
    name: null,
    departments: [],
    employeeStatus: 'unknown',
  });
});

test('getCurrentUser returns null for anonymous requests', () => {
  const anonymousPayload = { ...platformPayload, sub: 'anonymous', anonymous: true, user: null };
  assert.equal(getCurrentUser(platformRequest(anonymousPayload)), null);
});

test('readContext rejects user identity that does not match the platform subject', () => {
  const payload = { ...platformPayload, user: { ...platformPayload.user, id: 'usr_other' } };
  assert.throws(() => readContext(platformRequest(payload)), { code: 'INVALID_PLATFORM_CONTEXT' });
});

test('getCurrentUser tolerates invalid optional profile fields without losing the platform context', () => {
  const payload = {
    ...platformPayload,
    user: {
      id: 'usr_1',
      email: 'bad\u0000email',
      accountId: '',
      name: 'x'.repeat(300),
      departments: ['XD/Platform/Web', '', 42],
      employeeStatus: 'unexpected',
    },
  };

  const context = readContext(platformRequest(payload));

  assert.equal(context.siteId, 'site_demo');
  assert.deepEqual(context.user, {
    id: 'usr_1',
    email: null,
    accountId: null,
    name: null,
    departments: ['XD/Platform/Web'],
    employeeStatus: 'unknown',
  });
});

test('readContext rejects inconsistent platform headers and token claims', () => {
  assert.throws(
    () => readContext(platformRequest(platformPayload, { 'CF-Platform-Site-Id': 'site_other' })),
    (error) => {
      assert.ok(error instanceof SDKError);
      assert.equal(error.code, 'INVALID_PLATFORM_CONTEXT');
      return true;
    },
  );
});

test('createRuntime().kv.get uses the site KV namespace with Cloudflare text default', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: true, value: 'hello' });
        },
      },
    },
  });

  const value = await runtime.kv.get('app/config');

  assert.equal(value, 'hello');
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer site-request-capability');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'text' });
});

test('createRuntime().officeNet.fetch preserves the native binding fetch contract', async () => {
  const binding = {
    marker: 'office-net',
    async fetch(input, init) {
      assert.equal(this.marker, 'office-net');
      assert.equal(input, 'https://internal.example.test/users');
      assert.equal(init.method, 'POST');
      return new Response('ok', { status: 201 });
    },
  };
  const runtime = createRuntime({
    env: {
      XD_PAGES_KV_GATEWAY: { fetch: async () => Response.json({ ok: true }) },
      XD_OFFICE_NET: binding,
    },
  });

  const response = await runtime.officeNet.fetch('https://internal.example.test/users', { method: 'POST' });

  assert.equal(runtime.officeNet, binding);
  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'ok');
});

test('createRuntime().officeNet.fetch returns an unsupported response when the capability is unavailable', async () => {
  const runtime = createRuntime({
    env: {
      XD_PAGES_KV_GATEWAY: { fetch: async () => Response.json({ ok: true }) },
    },
  });

  const response = await runtime.officeNet.fetch('https://internal.example.test/users');

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: 'OFFICE_NET_UNAVAILABLE',
      message: 'Office network access is not supported for this Worker.',
    },
  });
});

test('createRuntime().kv.get reads JSON only when explicitly requested', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: true, value: { enabled: true } });
        },
      },
    },
  });

  const value = await runtime.kv.get('app/config', { type: 'json' });

  assert.deepEqual(value, { enabled: true });
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/get');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'json' });
});

test('createRuntime().kv.put uses the Cloudflare KV text default', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true });
        },
      },
    },
  });

  await runtime.kv.put('app/config', 'hello', { expirationTtl: 60 });

  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/set');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('Authorization'), 'Bearer site-request-capability');
  assert.deepEqual(await captured.json(), {
    key: 'app/config',
    value: 'hello',
    type: 'text',
    expirationTtl: 60,
  });
});

test('createRuntime().kv.put writes JSON only when explicitly requested', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true });
        },
      },
    },
  });

  await runtime.kv.put('app/config', { enabled: true }, { type: 'json' });

  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/set');
  assert.deepEqual(await captured.json(), {
    key: 'app/config',
    value: { enabled: true },
    type: 'json',
  });
});

test('createRuntime().kv.put forwards user metadata and absolute expiration', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true });
        },
      },
    },
  });

  await runtime.kv.put('app/config', 'hello', {
    expiration: 1_900_000_000,
    metadata: { owner: 'docs' },
  });

  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/set');
  assert.deepEqual(await captured.json(), {
    key: 'app/config',
    value: 'hello',
    type: 'text',
    expiration: 1_900_000_000,
    metadata: { owner: 'docs' },
  });
});

test('createRuntime().kv.getWithMetadata maps gateway metadata envelope', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({
            ok: true,
            found: true,
            value: { enabled: true },
            metadata: { owner: 'docs' },
          });
        },
      },
    },
  });

  const result = await runtime.kv.getWithMetadata('app/config', { type: 'json' });

  assert.deepEqual(result, { value: { enabled: true }, metadata: { owner: 'docs' } });
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/get-with-metadata');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'json' });
});

test('createRuntime().kv.list maps gateway list envelope', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({
            ok: true,
            keys: [{ name: 'app/config', metadata: { owner: 'docs' }, expiration: 1_900_000_000 }],
            list_complete: false,
            cursor: 'cursor_2',
          });
        },
      },
    },
  });

  const result = await runtime.kv.list({ prefix: 'app/', limit: 10, cursor: 'cursor_1' });

  assert.deepEqual(result, {
    keys: [{ name: 'app/config', metadata: { owner: 'docs' }, expiration: 1_900_000_000 }],
    list_complete: false,
    cursor: 'cursor_2',
  });
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/list');
  assert.deepEqual(await captured.json(), { prefix: 'app/', limit: 10, cursor: 'cursor_1' });
});

test('createRuntime().kv can fall back to env site data capability', async () => {
  let captured;
  const runtime = createRuntime({
    env: {
      XD_PAGES_DATA_SITE_CAPABILITY: 'site-env-capability',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: false, value: null });
        },
      },
    },
  });

  assert.equal(await runtime.kv.get('app/config'), null);
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer site-env-capability');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'text' });
});

test('createRuntime reads XD Cell env bindings without changing the public API shape', async () => {
  let captured;
  const runtime = createRuntime({
    env: {
      XD_CELL_DATA_SITE_CAPABILITY: 'cell-site-env-capability',
      XD_CELL_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: true, value: 'cell' });
        },
      },
    },
  });

  assert.equal(await runtime.kv.get('app/config'), 'cell');
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer cell-site-env-capability');
});

test('createRuntime().kv falls back to legacy path for legacy env capability', async () => {
  let captured;
  const runtime = createRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'legacy-env-capability',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: true, value: 'legacy' });
        },
      },
    },
  });

  assert.equal(await runtime.kv.get('app/config'), 'legacy');
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer legacy-env-capability');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'text' });
});

test('createRuntime reads per-request KV capability from router header for legacy compatibility', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-KV-Capability': 'request-capability-token' },
  });
  const runtime = createRuntime({
    request,
    env: {
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: false, value: null });
        },
      },
    },
  });

  const value = await runtime.kv.get('app/config');

  assert.equal(value, null);
  assert.equal(captured.headers.get('Authorization'), 'Bearer request-capability-token');
  assert.deepEqual(await captured.json(), { key: 'app/config', type: 'text' });
});

test('createRuntime rejects gateway error envelopes', async () => {
  const runtime = createRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => Response.json({ ok: false, error: { code: 'KV_FAILED', message: 'Data failed' } }),
      },
    },
  });

  await assert.rejects(() => runtime.kv.get('app/config'), {
    code: 'KV_FAILED',
    message: 'Data failed',
  });
});

test('createRuntime throws invalid runtime response for get envelopes without found', async () => {
  const runtime = createRuntime({
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

test('createRuntime throws invalid runtime response for non-JSON gateway responses', async () => {
  const runtime = createRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability-token',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => new Response('not json', { headers: { 'Content-Type': 'text/plain' } }),
      },
    },
  });

  await assert.rejects(() => runtime.kv.get('app/config'), (error) => {
    assert.ok(error instanceof SDKError);
    assert.equal(error.code, 'INVALID_RUNTIME_RESPONSE');
    return true;
  });
});

test('createRuntime().kv.delete calls the gateway delete endpoint', async () => {
  let captured;
  const runtime = createRuntime({
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
