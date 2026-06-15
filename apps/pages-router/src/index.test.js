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

test('fails closed before route lookup when PAGES_ENV is missing', async () => {
  const env = routeEnv({ PAGES_ENV: undefined });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'ROUTER_ENV_INVALID');
  assert.equal(env.lookupCount, 0);
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('fails closed before route lookup when PAGES_ENV is invalid', async () => {
  const env = routeEnv({ PAGES_ENV: 'preview' });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'ROUTER_ENV_INVALID');
  assert.equal(env.lookupCount, 0);
  assert.equal(env.dispatchGetCount, 0);
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
  assert.equal(env.dispatchedEnv, undefined);
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
        workerName: 'pages-v2-staging-demo-worker',
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

test('rejects route snapshots with missing worker names before dispatch', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ workerName: undefined }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ROUTE_WORKER_INVALID');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('rejects route snapshots with invalid worker name syntax before dispatch', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ workerName: 'pages-v2-Demo_worker' }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ROUTE_WORKER_INVALID');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('rejects staging-prefix worker names in production routes before dispatch', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ workerName: 'pages-v2-staging-demo-worker' }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ROUTE_WORKER_INVALID');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('dispatches an allowed staging site with a staging worker name', async () => {
  const env = routeEnv({
    PAGES_ENV: 'staging',
    expectedWorkerName: 'pages-v2-staging-demo-worker',
    routes: {
      'demo-staging.pages.xd.team': routeSnapshot({
        environment: 'staging',
        hostname: 'demo-staging.pages.xd.team',
        workerName: 'pages-v2-staging-demo-worker',
      }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo-staging.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'user worker ok');
  assert.equal(env.dispatchGetCount, 1);
  assert.equal(env.dispatchCount, 1);
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Site-Slug'), 'demo');
  assert.equal(env.dispatchedEnv, undefined);
});

test('rejects production-prefix worker names in staging routes before dispatch', async () => {
  const env = routeEnv({
    PAGES_ENV: 'staging',
    routes: {
      'demo-staging.pages.xd.team': routeSnapshot({
        environment: 'staging',
        hostname: 'demo-staging.pages.xd.team',
        workerName: 'pages-v2-demo-worker',
      }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo-staging.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ROUTE_WORKER_INVALID');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

function routeSnapshot(overrides = {}) {
  return {
    environment: 'production',
    hostname: 'demo.pages.xd.team',
    routeStatus: 'active',
    runtime: 'wfp',
    workerName: 'pages-v2-demo-worker',
    siteId: 'site_demo',
    slug: 'demo',
    activeVersionId: 'ver_demo',
    ...overrides,
  };
}

function routeEnv(overrides = {}) {
  const state = {
    lookupCount: 0,
    dispatchGetCount: 0,
    dispatchCount: 0,
    dispatchedRequest: null,
    dispatchedEnv: null,
  };
  const routes = overrides.routes || {
    'demo.pages.xd.team': routeSnapshot(),
  };
  const userResponse = overrides.userResponse || new Response('user worker ok');
  const expectedWorkerName = overrides.expectedWorkerName || 'pages-v2-demo-worker';

  const env = {
    ...state,
    PAGES_ENV: 'production',
    ROUTER_IP_ALLOWLIST_CIDRS: '10.0.0.0/8',
    ROUTE_SNAPSHOTS: routes,
    TEST_INTERNAL_JWT: 'test.internal.jwt',
    PAGES_DISPATCH: {
      get(workerName) {
        state.dispatchGetCount += 1;
        env.dispatchGetCount = state.dispatchGetCount;
        assert.equal(workerName, expectedWorkerName);
        return {
          async fetch(request, dispatchedEnv) {
            this;
            state.dispatchCount += 1;
            env.dispatchCount = state.dispatchCount;
            state.dispatchedRequest = request;
            env.dispatchedRequest = request;
            state.dispatchedEnv = dispatchedEnv;
            env.dispatchedEnv = dispatchedEnv;
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
    get dispatchGetCount() {
      return state.dispatchGetCount;
    },
    set dispatchGetCount(value) {
      state.dispatchGetCount = value;
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
    get dispatchedEnv() {
      return state.dispatchedEnv;
    },
    set dispatchedEnv(value) {
      state.dispatchedEnv = value;
    },
    lookupRoute(hostname) {
      state.lookupCount += 1;
      return routes[hostname] || null;
    },
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'routes' && key !== 'userResponse' && key !== 'expectedWorkerName') env[key] = value;
  }

  return env;
}
