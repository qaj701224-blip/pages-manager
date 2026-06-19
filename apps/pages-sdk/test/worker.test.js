import assert from 'node:assert/strict';
import test from 'node:test';

import { PagesSDKError, createPagesRuntime, readPlatformContext } from '../dist/worker.js';

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

test('readPlatformContext reads minimal router-injected identity without exposing the JWT as capability', () => {
  const context = readPlatformContext(platformRequest());

  assert.deepEqual(context, {
    authenticated: true,
    anonymous: false,
    userId: 'usr_1',
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

test('readPlatformContext rejects inconsistent platform headers and token claims', () => {
  assert.throws(
    () => readPlatformContext(platformRequest(platformPayload, { 'CF-Platform-Site-Id': 'site_other' })),
    (error) => {
      assert.ok(error instanceof PagesSDKError);
      assert.equal(error.code, 'INVALID_PLATFORM_CONTEXT');
      return true;
    },
  );
});

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

test('createPagesRuntime().data.site.get uses the site data capability header', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-Site-Capability': 'site-request-capability' },
  });
  const runtime = createPagesRuntime({
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

  const value = await runtime.data.site.get('app/config');

  assert.deepEqual(value, { enabled: true });
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer site-request-capability');
});

test('createPagesRuntime().data.site can fall back to env site data capability', async () => {
  let captured;
  const runtime = createPagesRuntime({
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

  assert.equal(await runtime.data.site.get('app/config'), null);
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/site/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer site-env-capability');
});

test('createPagesRuntime().data.site falls back to legacy path for legacy env capability', async () => {
  let captured;
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'legacy-env-capability',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: true, value: { legacy: true } });
        },
      },
    },
  });

  assert.deepEqual(await runtime.data.site.get('app/config'), { legacy: true });
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer legacy-env-capability');
});

test('createPagesRuntime().data.user uses only request user capability header', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-Data-User-Capability': 'user-request-capability' },
  });
  const runtime = createPagesRuntime({
    request,
    env: {
      XD_PAGES_KV_CAPABILITY: 'legacy-env-capability',
      XD_PAGES_DATA_SITE_CAPABILITY: 'site-env-capability',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (gatewayRequest) => {
          captured = gatewayRequest;
          return Response.json({ ok: true, found: true, value: { title: 'hello' } });
        },
      },
    },
  });

  const value = await runtime.data.user.get('draft');

  assert.deepEqual(value, { title: 'hello' });
  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/data/user/get');
  assert.equal(captured.headers.get('Authorization'), 'Bearer user-request-capability');
});

test('createPagesRuntime().data.user rejects env static capabilities', async () => {
  const runtime = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'legacy-env-capability',
      XD_PAGES_DATA_SITE_CAPABILITY: 'site-env-capability',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => {
          throw new Error('gateway should not be called');
        },
      },
    },
  });

  await assert.rejects(() => runtime.data.user.get('draft'), {
    code: 'INVALID_PLATFORM_CONTEXT',
  });
});

test('createPagesRuntime reads per-request KV capability from router header', async () => {
  let captured;
  const request = new Request('https://demo.pages.xd.team/', {
    headers: { 'CF-Platform-KV-Capability': 'request-capability-token' },
  });
  const runtime = createPagesRuntime({
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
});

test('createPagesRuntime rejects gateway error envelopes', async () => {
  const runtime = createPagesRuntime({
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

test('createPagesRuntime().kv.set calls the gateway set endpoint', async () => {
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

  await runtime.kv.set('app/config', 'hello', { type: 'text', expirationTtl: 60 });

  assert.equal(captured.url, 'https://pages-kv-gateway.local/v1/kv/set');
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
