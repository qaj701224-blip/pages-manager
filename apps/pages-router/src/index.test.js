import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';

test('fails closed before route lookup when IP allowlist is missing', async () => {
  const env = routeEnv({ ROUTER_IP_ALLOWLIST_CIDRS: undefined });
  const response = await worker.fetch(new Request('https://demo.pages.xd.team/'), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'IP_DENIED');
  assert.equal(env.lookupCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('fails closed when CF-Connecting-IP is missing', async () => {
  const env = routeEnv();
  const response = await worker.fetch(new Request('https://demo.pages.xd.team/'), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'IP_DENIED');
  assert.equal(env.lookupCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('rejects reserved platform hosts before dispatch', async () => {
  const env = routeEnv();
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'RESERVED_HOST');
  assert.equal(env.dispatchCount, 0);
});

test('rejects platform reserved paths before dispatch', async () => {
  const env = routeEnv();
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/kv/get', {
      headers: { 'CF-Connecting-IP': '10.1.2.3' },
    }),
    env
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'PLATFORM_PATH_RESERVED');
  assert.equal(env.dispatchCount, 0);
});

test('dispatches an allowed production site with sanitized request headers', async () => {
  const env = routeEnv();
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'CF-Platform-Auth': 'fake',
        Cookie: 'app=ok; __Host-pages_site_session=secret',
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'user worker ok');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Auth'), 'test.internal.jwt');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-User'), 'anonymous');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Site-Id'), 'site_demo');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Site-Slug'), 'demo');
  assert.equal(env.dispatchedRequest.headers.get('Cookie'), 'app=ok');
});

test('sanitizes platform response headers and cookies', async () => {
  const env = routeEnv({
    userResponse: new Response('ok', {
      headers: {
        'CF-Platform-Trace-Id': 'fake',
        'Set-Cookie': '__Host-pages_site_session=evil; Path=/; Secure',
      },
    }),
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.headers.get('CF-Platform-Trace-Id'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
});

test('rejects route snapshot environment mismatches', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': {
        environment: 'staging',
        hostname: 'demo.pages.xd.team',
        routeStatus: 'active',
        runtime: 'wfp',
        workerName: 'demo-worker',
        siteId: 'site_demo',
        slug: 'demo',
        activeVersionId: 'ver_demo',
      },
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ROUTE_ENV_MISMATCH');
  assert.equal(env.dispatchCount, 0);
});

function routeEnv(overrides = {}) {
  const state = {
    lookupCount: 0,
    dispatchCount: 0,
    dispatchedRequest: null,
  };
  const routes = overrides.routes || {
    'demo.pages.xd.team': {
      environment: 'production',
      hostname: 'demo.pages.xd.team',
      routeStatus: 'active',
      runtime: 'wfp',
      workerName: 'demo-worker',
      siteId: 'site_demo',
      slug: 'demo',
      activeVersionId: 'ver_demo',
    },
  };
  const userResponse = overrides.userResponse || new Response('user worker ok');

  const env = {
    ...state,
    PAGES_ENV: 'production',
    ROUTER_IP_ALLOWLIST_CIDRS: '10.0.0.0/8',
    ROUTE_SNAPSHOTS: routes,
    TEST_INTERNAL_JWT: 'test.internal.jwt',
    PAGES_DISPATCH: {
      get(workerName) {
        assert.equal(workerName, 'demo-worker');
        return {
          async fetch(request) {
            this;
            state.dispatchCount += 1;
            env.dispatchCount = state.dispatchCount;
            state.dispatchedRequest = request;
            env.dispatchedRequest = request;
            return userResponse;
          },
        };
      },
    },
    get lookupCount() {
      return state.lookupCount;
    },
    set lookupCount(value) {
      state.lookupCount = value;
    },
    get dispatchCount() {
      return state.dispatchCount;
    },
    set dispatchCount(value) {
      state.dispatchCount = value;
    },
    get dispatchedRequest() {
      return state.dispatchedRequest;
    },
    set dispatchedRequest(value) {
      state.dispatchedRequest = value;
    },
    lookupRoute(hostname) {
      state.lookupCount += 1;
      return routes[hostname] || null;
    },
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'routes' && key !== 'userResponse') env[key] = value;
  }

  return env;
}
