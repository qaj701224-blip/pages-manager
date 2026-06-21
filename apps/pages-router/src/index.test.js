import assert from 'node:assert/strict';
import test from 'node:test';

import kvGatewayWorker from '../../kv-gateway/src/index.js';
import { verifyCapability } from '../../kv-gateway/src/auth.js';
import { signSessionJwt, verifySessionJwt } from '../../pages-auth/src/jwt.js';
import worker from './index.js';

const coolToneFragments = [
  '#12b3a8',
  '#2563eb',
  '#f5f7fb',
  '#101828',
  '#5b677a',
  '#dfe7f2',
  '#c8d4e4',
  '#334155',
  '#475569',
  '#0f172a',
  '#718096',
  '#263244',
  '15, 23, 42',
  '37, 99, 235',
  '200, 212, 228',
  'var(--blue)',
];

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
  const body = await response.json();
  assert.equal(body.error.code, 'RESERVED_HOST');
  assert.match(body.error.message, /routable XD Pages site/);
  assert.equal(env.dispatchCount, 0);
});

test('rejects platform reserved paths before dispatch', async () => {
  const env = routeEnv();
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/health', {
      headers: { 'CF-Connecting-IP': '10.1.2.3' },
    }),
    env
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'PLATFORM_PATH_RESERVED');
  assert.equal(env.dispatchCount, 0);
});

test('shows a friendly browser page when the site route is not found', async () => {
  const env = routeEnv({
    routes: {},
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Accept: 'text/html',
      },
    }),
    env
  );

  assert.equal(response.status, 404);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const text = await response.text();
  assert.match(text, /站点没有找到/);
  assert.match(text, /这个站点还没有发布，或者路由已经被移除/);
  assert.match(text, /状态：站点不存在/);
  assertNoCoolToneFragments(text);
  assert.equal(text.includes('ROUTE_NOT_FOUND'), true);
  assert.equal(env.dispatchCount, 0);
});

test('proxies browser runtime KV requests through gateway without dispatching user worker', async () => {
  let gatewayRequest;
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        kv: { enabled: true, scopes: ['kv:get', 'kv:set', 'kv:delete'] },
      }),
    },
    XD_PAGES_KV_GATEWAY: {
      async fetch(request) {
        gatewayRequest = request;
        return Response.json(
          { ok: true, found: true, value: { theme: 'dark' } },
          {
            headers: {
              Deprecation: 'true',
              Authorization: 'Bearer leaked',
              'CF-Platform-KV-Capability': 'leaked',
              'CF-Platform-Data-Site-Capability': 'leaked',
              'CF-Platform-Data-User-Capability': 'leaked',
              'X-Pages-Token': 'leaked',
              'X-XD-Pages-Trace-Id': 'leaked',
              'Set-Cookie': '__Host-pages_site_session=leaked; Path=/; Secure',
            },
          }
        );
      },
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/kv/get', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://demo.pages.xd.team',
      },
      body: JSON.stringify({ key: 'app/config' }),
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, found: true, value: { theme: 'dark' } });
  assert.equal(response.headers.get('Deprecation'), 'true');
  assert.equal(response.headers.get('Authorization'), null);
  assert.equal(response.headers.get('CF-Platform-KV-Capability'), null);
  assert.equal(response.headers.get('CF-Platform-Data-Site-Capability'), null);
  assert.equal(response.headers.get('CF-Platform-Data-User-Capability'), null);
  assert.equal(response.headers.get('X-Pages-Token'), null);
  assert.equal(response.headers.get('X-XD-Pages-Trace-Id'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(env.dispatchCount, 0);
  assert.equal(gatewayRequest.url, 'https://pages-kv-gateway.local/v1/kv/get');
  assert.equal(gatewayRequest.headers.get('CF-Platform-KV-Capability'), null);
  const claims = await verifyCapability(gatewayRequest.headers.get('Authorization'), gatewayEnv(), {
    requiredScope: 'kv:get',
    now: 1_700_000_000,
  });
  assert.equal(claims.siteId, 'demo');
  assert.equal(claims.siteUuid, '4b4c8e8361ef4b47b64f5c20a7db7c47');
});

test('proxies browser site data runtime requests with site data capability', async () => {
  let gatewayRequest;
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        kv: { enabled: true, scopes: ['kv:get', 'kv:set', 'kv:delete'] },
      }),
    },
    XD_PAGES_KV_GATEWAY: {
      async fetch(request) {
        gatewayRequest = request;
        return Response.json({ ok: true, found: true, value: { theme: 'dark' } });
      },
    },
  });

  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/data/site/get', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://demo.pages.xd.team',
      },
      body: JSON.stringify({ key: 'app/config' }),
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, found: true, value: { theme: 'dark' } });
  assert.equal(response.headers.get('Authorization'), null);
  assert.equal(response.headers.get('CF-Platform-KV-Capability'), null);
  assert.equal(response.headers.get('CF-Platform-Data-Site-Capability'), null);
  assert.equal(response.headers.get('CF-Platform-Data-User-Capability'), null);
  assert.equal(response.headers.get('X-Pages-Token'), null);
  assert.equal(response.headers.get('X-XD-Pages-Trace-Id'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(gatewayRequest.url, 'https://pages-kv-gateway.local/v1/data/site/get');
  const claims = await verifyCapability(gatewayRequest.headers.get('Authorization'), gatewayEnv(), {
    requiredScope: 'data:site:get',
    requiredDataScope: 'site',
    now: 1_700_000_000,
  });
  assert.equal(claims.dataScope, 'site');
  assert.equal(claims.sub, 'anonymous');
});

test('proxies browser user data runtime requests with request identity capability', async () => {
  let gatewayRequest;
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        visibility: 'org',
        kv: { enabled: true, scopes: ['kv:get', 'kv:set', 'kv:delete'] },
      }),
    },
    XD_PAGES_KV_GATEWAY: {
      async fetch(request) {
        gatewayRequest = request;
        return Response.json({ ok: true, found: true, value: { title: 'hello' } });
      },
    },
  });
  const session = await siteSession({ audience: 'demo.pages.xd.team', userId: 'usr_1' });

  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/data/user/get', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://demo.pages.xd.team',
        Cookie: `__Host-pages_site_session=${session}`,
      },
      body: JSON.stringify({ key: 'draft', userId: 'usr_evil' }),
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, found: true, value: { title: 'hello' } });
  assert.equal(gatewayRequest.url, 'https://pages-kv-gateway.local/v1/data/user/get');
  const claims = await verifyCapability(gatewayRequest.headers.get('Authorization'), gatewayEnv(), {
    requiredScope: 'data:user:get',
    requiredDataScope: 'user',
    now: 1_700_000_000,
  });
  assert.equal(claims.dataScope, 'user');
  assert.equal(claims.sub, 'usr_1');
  assert.equal(claims.anonymous, false);
});

test('protected user data runtime requests redirect before gateway when session is missing', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        visibility: 'org',
        kv: { enabled: true, scopes: ['kv:get'] },
      }),
    },
    XD_PAGES_KV_GATEWAY: {
      async fetch() {
        throw new Error('gateway should not be called');
      },
    },
  });

  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/data/user/get', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://demo.pages.xd.team',
      },
      body: JSON.stringify({ key: 'draft' }),
    }),
    env
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /reason=SITE_SESSION_REQUIRED/);
});

test('browser data write requests do not receive write scope from read-only route snapshots', async () => {
  const captured = [];
  const session = await siteSession({ audience: 'demo.pages.xd.team', userId: 'usr_1' });
  const readOnlyGatewayEnv = gatewayEnv({ nowSeconds: () => 1_700_000_000 });
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        visibility: 'org',
        kv: { enabled: true, scopes: ['kv:get'] },
      }),
    },
    XD_PAGES_KV_GATEWAY: {
      async fetch(request) {
        captured.push(request);
        return kvGatewayWorker.fetch(request, readOnlyGatewayEnv);
      },
    },
  });

  const siteResponse = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/data/site/set', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://demo.pages.xd.team',
        Cookie: `__Host-pages_site_session=${session}`,
      },
      body: JSON.stringify({ key: 'app/config', value: { theme: 'dark' } }),
    }),
    env
  );
  const userResponse = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/data/user/set', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://demo.pages.xd.team',
        Cookie: `__Host-pages_site_session=${session}`,
      },
      body: JSON.stringify({ key: 'draft', value: { title: 'hello' } }),
    }),
    env
  );

  assert.equal(siteResponse.status, 403);
  assert.equal(userResponse.status, 403);
  assert.equal((await siteResponse.json()).error.code, 'CAPABILITY_SCOPE_DENIED');
  assert.equal((await userResponse.json()).error.code, 'CAPABILITY_SCOPE_DENIED');
  assert.equal(captured.length, 2);
  await assert.rejects(
    verifyCapability(captured[0].headers.get('Authorization'), gatewayEnv(), {
      requiredScope: 'data:site:set',
      requiredDataScope: 'site',
      now: 1_700_000_000,
    }),
    /scope/i
  );
  await assert.rejects(
    verifyCapability(captured[1].headers.get('Authorization'), gatewayEnv(), {
      requiredScope: 'data:user:set',
      requiredDataScope: 'user',
      now: 1_700_000_000,
    }),
    /scope/i
  );
});

test('anonymous browser user data writes return USER_REQUIRED through gateway', async () => {
  const env = routeEnv({
    nowSeconds: () => Math.floor(Date.now() / 1000),
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        kv: { enabled: true, scopes: ['kv:set'] },
      }),
    },
    XD_PAGES_KV_GATEWAY: {
      async fetch(request) {
        return kvGatewayWorker.fetch(request, gatewayEnv());
      },
    },
  });

  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/data/user/set', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://demo.pages.xd.team',
      },
      body: JSON.stringify({ key: 'draft', value: { title: 'hello' } }),
    }),
    env
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'USER_REQUIRED');
});

test('rejects browser runtime KV requests with cross-site origin', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        kv: { enabled: true, scopes: ['kv:get'] },
      }),
    },
    XD_PAGES_KV_GATEWAY: {
      async fetch() {
        throw new Error('gateway should not be called');
      },
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/kv/get', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ key: 'app/config' }),
    }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'RUNTIME_ORIGIN_DENIED');
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
  const internalJwt = env.dispatchedRequest.headers.get('CF-Platform-Auth');
  const internalPayload = await verifySessionJwt(internalJwt, env, {
    purpose: 'internal_worker_jwt',
    audience: 'pages-v2-demo-worker',
    now: 1_700_000_000,
  });
  assert.equal(internalPayload.iss, 'pages-router');
  assert.equal(internalPayload.sub, 'anonymous');
  assert.equal(internalPayload.siteId, 'site_demo');
  assert.equal(internalPayload.versionId, 'ver_demo');
  assert.equal(internalPayload.anonymous, true);
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-User'), 'anonymous');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Site-Id'), 'site_demo');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Site-Slug'), 'demo');
  assert.equal(env.dispatchedRequest.headers.get('Cookie'), 'app=ok');
  assert.equal(env.dispatchedEnv, undefined);
});

test('injects a short-lived KV capability into user worker requests for kv-enabled routes', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        kv: { enabled: true, scopes: ['kv:get', 'kv:set', 'kv:delete'] },
      }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 200);
  const capability = env.dispatchedRequest.headers.get('CF-Platform-KV-Capability');
  const claims = await verifyCapability(`Bearer ${capability}`, gatewayEnv(), {
    requiredScope: 'kv:set',
    now: 1_700_000_000,
  });
  assert.equal(claims.siteId, 'demo');
  assert.equal(claims.env, 'production');
  assert.equal(claims.exp - claims.iat, 60);
});

test('injects separated site and user data capabilities into user worker requests', async () => {
  const session = await siteSession({ audience: 'demo.pages.xd.team', userId: 'usr_1' });
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        visibility: 'org',
        kv: { enabled: true, scopes: ['kv:get', 'kv:set', 'kv:delete'] },
      }),
    },
  });

  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  const siteCapability = env.dispatchedRequest.headers.get('CF-Platform-Data-Site-Capability');
  const userCapability = env.dispatchedRequest.headers.get('CF-Platform-Data-User-Capability');
  const siteClaims = await verifyCapability(`Bearer ${siteCapability}`, gatewayEnv(), {
    requiredScope: 'data:site:set',
    requiredDataScope: 'site',
    now: 1_700_000_000,
  });
  const userClaims = await verifyCapability(`Bearer ${userCapability}`, gatewayEnv(), {
    requiredScope: 'data:user:set',
    requiredDataScope: 'user',
    now: 1_700_000_000,
  });

  assert.equal(siteClaims.dataScope, 'site');
  assert.equal(siteClaims.sub, 'anonymous');
  assert.equal(siteClaims.anonymous, true);
  assert.equal(userClaims.dataScope, 'user');
  assert.equal(userClaims.sub, 'usr_1');
});

test('data capabilities injected into user workers inherit legacy kv scopes', async () => {
  const session = await siteSession({ audience: 'demo.pages.xd.team', userId: 'usr_1' });
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        visibility: 'org',
        kv: { enabled: true, scopes: ['kv:get'] },
      }),
    },
  });

  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  const siteCapability = env.dispatchedRequest.headers.get('CF-Platform-Data-Site-Capability');
  const userCapability = env.dispatchedRequest.headers.get('CF-Platform-Data-User-Capability');
  await verifyCapability(`Bearer ${siteCapability}`, gatewayEnv(), {
    requiredScope: 'data:site:get',
    requiredDataScope: 'site',
    now: 1_700_000_000,
  });
  await verifyCapability(`Bearer ${userCapability}`, gatewayEnv(), {
    requiredScope: 'data:user:get',
    requiredDataScope: 'user',
    now: 1_700_000_000,
  });
  await assert.rejects(
    verifyCapability(`Bearer ${siteCapability}`, gatewayEnv(), {
      requiredScope: 'data:site:set',
      requiredDataScope: 'site',
      now: 1_700_000_000,
    }),
    /scope/i
  );
  await assert.rejects(
    verifyCapability(`Bearer ${userCapability}`, gatewayEnv(), {
      requiredScope: 'data:user:set',
      requiredDataScope: 'user',
      now: 1_700_000_000,
    }),
    /scope/i
  );
});

test('reads route snapshots from KV pointer records when lookupRoute is absent', async () => {
  const snapshot = routeSnapshot({ routeGeneration: 4, policyVersion: 2 });
  const env = routeEnv({
    lookupRoute: undefined,
    ROUTE_SNAPSHOTS: kvRouteSnapshots({
      'production:route_pointer:demo.pages.xd.team': {
        hostname: 'demo.pages.xd.team',
        environment: 'production',
        routeGeneration: 4,
        policyVersion: 2,
        snapshotKey: 'production:route_snapshot:demo.pages.xd.team:4:2',
      },
      'production:route_snapshot:demo.pages.xd.team:4:2': snapshot,
    }),
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Version'), 'ver_demo');
});

test('fails closed when KV route pointer and snapshot versions do not match', async () => {
  const env = routeEnv({
    lookupRoute: undefined,
    ROUTE_SNAPSHOTS: kvRouteSnapshots({
      'production:route_pointer:demo.pages.xd.team': {
        hostname: 'demo.pages.xd.team',
        environment: 'production',
        routeGeneration: 4,
        policyVersion: 3,
        snapshotKey: 'production:route_snapshot:demo.pages.xd.team:4:2',
      },
      'production:route_snapshot:demo.pages.xd.team:4:2': routeSnapshot({ routeGeneration: 4, policyVersion: 2 }),
    }),
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_INVALID');
  assert.equal(env.dispatchCount, 0);
});

test('fails closed when KV route pointer environment does not match router environment', async () => {
  const env = routeEnv({
    lookupRoute: undefined,
    ROUTE_SNAPSHOTS: kvRouteSnapshots({
      'production:route_pointer:demo.pages.xd.team': {
        hostname: 'demo.pages.xd.team',
        environment: 'staging',
        routeGeneration: 4,
        policyVersion: 2,
        snapshotKey: 'production:route_snapshot:demo.pages.xd.team:4:2',
      },
      'production:route_snapshot:demo.pages.xd.team:4:2': routeSnapshot({ routeGeneration: 4, policyVersion: 2 }),
    }),
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_INVALID');
  assert.equal(env.dispatchCount, 0);
});

test('consumes auth callback site code and sets host-only site_session before redirecting', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org', policyVersion: 3 }),
    },
    consumeSiteCode: async ({ code, siteHost }) => {
      assert.equal(code, 'ost_test.site-secret');
      assert.equal(siteHost, 'demo.pages.xd.team');
      return {
        returnTo: 'https://demo.pages.xd.team/private',
        user: {
          id: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          departments: ['dept_design'],
          sessionVersion: 5,
        },
      };
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/auth/callback?code=ost_test.site-secret', {
      headers: { 'CF-Connecting-IP': '10.1.2.3' },
    }),
    env
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://demo.pages.xd.team/private');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);

  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-pages_site_session=/);
  assert.equal(cookie.includes('Domain='), false);
  const token = cookie.split(';', 1)[0].split('=', 2)[1];
  const payload = await verifySessionJwt(token, env, {
    purpose: 'site_session',
    audience: 'demo.pages.xd.team',
    now: 1_700_000_000,
  });
  assert.equal(payload.sub, 'usr_1');
  assert.equal(payload.siteId, 'site_demo');
  assert.equal(payload.policyVersion, 3);
  assert.equal(payload.sessionVersion, 5);
  assert.equal(payload.userCheckedAt, 1_700_000_000);
  assert.equal(payload.employeeStatus, 'active');
  assert.deepEqual(payload.departments, ['dept_design']);
});

test('recovers an invalid browser site auth callback by restarting auth once', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org' }),
    },
    consumeSiteCode: async () => {
      throw new Error('invalid site code');
    },
  });
  const response = await worker.fetch(
    new Request(
      'https://demo.pages.xd.team/.xd-pages/auth/callback?code=ost_bad.site-secret&' +
        'return_to=https%3A%2F%2Fdemo.pages.xd.team%2Fprivate',
      {
        headers: {
          'CF-Connecting-IP': '10.1.2.3',
          Accept: 'text/html',
        },
      }
    ),
    env
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.origin + location.pathname, 'https://auth.pages.xd.team/.xd-pages/auth/authorize');
  assert.equal(location.searchParams.get('site_host'), 'demo.pages.xd.team');
  assert.equal(location.searchParams.get('return_to'), 'https://demo.pages.xd.team/private');
  assert.equal(location.searchParams.get('reason'), 'SITE_AUTH_CODE_INVALID');
  assert.equal(location.searchParams.get('auth_recovery'), '1');
});

test('shows a friendly browser page when recovered site auth callback still fails', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org' }),
    },
    consumeSiteCode: async () => {
      throw new Error('invalid site code');
    },
  });
  const response = await worker.fetch(
    new Request(
      'https://demo.pages.xd.team/.xd-pages/auth/callback?code=ost_bad.site-secret&' +
        'return_to=https%3A%2F%2Fdemo.pages.xd.team%2Fprivate&auth_recovery=1',
      {
        headers: {
          'CF-Connecting-IP': '10.1.2.3',
          Accept: 'text/html',
        },
      }
    ),
    env
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const text = await response.text();
  assert.match(text, /XD Pages/);
  assert.match(text, /访问验证没有完成/);
  assert.match(text, /这次验证凭证已经失效或已经使用过/);
  assert.match(text, /重新打开站点会自动再次发起验证/);
  assert.match(text, /状态：需要重新验证/);
  assertNoCoolToneFragments(text);
  assert.equal(text.includes('ost_bad'), false);
});

test('redirects protected org sites to auth when site_session is missing', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org' }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /^https:\/\/auth\.pages\.xd\.team\/\.xd-pages\/auth\/authorize\?/);
  assert.equal(new URL(response.headers.get('Location')).searchParams.get('site_host'), 'demo.pages.xd.team');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('rejects disabled sites before dispatch even with a valid site_session', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'disabled' }),
    },
  });
  const session = await siteSession({ audience: 'demo.pages.xd.team', siteId: 'site_demo' });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SITE_DISABLED');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('shows a friendly browser page for disabled sites', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'disabled' }),
    },
  });
  const session = await siteSession({ audience: 'demo.pages.xd.team', siteId: 'site_demo' });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Accept: 'text/html',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 403);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const text = await response.text();
  assert.match(text, /站点暂时不可访问/);
  assert.match(text, /这个站点当前没有开放访问/);
  assert.match(text, /状态：暂停访问/);
  assertNoCoolToneFragments(text);
  assert.equal(text.includes('SITE_DISABLED'), false);
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('fails closed when route snapshot has an unknown visibility', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'public' }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SITE_POLICY_INVALID');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('shows a friendly browser page when site access policy is invalid', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'public' }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Accept: 'text/html',
      },
    }),
    env
  );

  assert.equal(response.status, 403);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const text = await response.text();
  assert.match(text, /站点访问配置需要确认/);
  assert.match(text, /这个站点的访问策略暂时无法确认/);
  assert.match(text, /状态：访问策略异常/);
  assertNoCoolToneFragments(text);
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('dispatches org sites for active employees with a valid site_session', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org', policyVersion: 2 }),
    },
  });
  const session = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    policyVersion: 2,
    userId: 'usr_1',
    employeeStatus: 'active',
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}; app=ok`,
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-User'), 'usr_1');
  assert.equal(env.dispatchedRequest.headers.get('Cookie'), 'app=ok');
});

test('rejects org sites for inactive employees', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org' }),
    },
  });
  const session = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    employeeStatus: 'left',
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SITE_ACCESS_FORBIDDEN');
  assert.equal(env.dispatchCount, 0);
});

test('shows a friendly browser page when the signed-in user has no site access', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'owner', ownerUserId: 'owner_1' }),
    },
  });
  const session = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    userId: 'usr_2',
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Accept: 'text/html',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 403);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const text = await response.text();
  assert.match(text, /你暂时没有访问权限/);
  assert.match(text, /当前账号还没有被加入这个站点的访问名单/);
  assert.match(text, /联系站点管理员开通权限/);
  assert.match(text, /状态：没有访问权限/);
  assertNoCoolToneFragments(text);
  assert.equal(env.dispatchCount, 0);
});

test('owner sites require the active owner identity', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'owner', ownerUserId: 'owner_1' }),
    },
  });
  const nonOwner = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    userId: 'usr_2',
  });
  const owner = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    userId: 'owner_1',
  });

  const rejected = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${nonOwner}`,
      },
    }),
    env
  );
  const allowed = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${owner}`,
      },
    }),
    env
  );

  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, 'SITE_ACCESS_FORBIDDEN');
  assert.equal(allowed.status, 200);
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-User'), 'owner_1');
});

test('rejects acl sites when no allow entry matches', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        visibility: 'acl',
        acl: [{ effect: 'allow', subjectType: 'email', subjectValue: 'blocked@example.com' }],
      }),
    },
  });
  const session = await siteSession({ audience: 'demo.pages.xd.team', siteId: 'site_demo', userId: 'usr_1' });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SITE_ACCESS_FORBIDDEN');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('dispatches acl sites when any allow entry matches', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        visibility: 'acl',
        acl: [
          { effect: 'allow', subjectType: 'email', subjectValue: 'teammate@example.com' },
          { effect: 'allow', subjectType: 'department', subjectValue: 'dept_design' },
        ],
      }),
    },
  });
  const session = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    userId: 'usr_1',
    departments: ['dept_design'],
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-User'), 'usr_1');
});

test('redirects stale site_session when policyVersion no longer matches', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org', policyVersion: 3 }),
    },
  });
  const session = await siteSession({ audience: 'demo.pages.xd.team', siteId: 'site_demo', policyVersion: 2 });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /reason=SITE_SESSION_STALE/);
  assert.equal(env.dispatchCount, 0);
});

test('redirects protected sites when site_session identity freshness expires', async () => {
  const env = routeEnv({
    SITE_SESSION_FRESHNESS_TTL_SECONDS: '60',
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org', policyVersion: 2 }),
    },
  });
  const session = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    policyVersion: 2,
    userCheckedAt: 1_699_999_900,
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /reason=SITE_SESSION_STALE/);
  assert.equal(env.dispatchCount, 0);
});

test('clamps oversized site_session freshness to 15 minutes', async () => {
  const env = routeEnv({
    SITE_SESSION_FRESHNESS_TTL_SECONDS: '3600',
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org', policyVersion: 2 }),
    },
  });
  const session = await siteSession({
    audience: 'demo.pages.xd.team',
    siteId: 'site_demo',
    policyVersion: 2,
    userCheckedAt: 1_699_999_099,
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: `__Host-pages_site_session=${session}`,
      },
    }),
    env
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /reason=SITE_SESSION_STALE/);
  assert.equal(env.dispatchCount, 0);
});

test('redirects malformed site_session to auth without dispatching', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({ visibility: 'org' }),
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/private', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        Cookie: '__Host-pages_site_session=not-a-valid-jwt',
      },
    }),
    env
  );

  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /reason=SITE_SESSION_REQUIRED/);
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.dispatchCount, 0);
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

test('dispatches normal worker slot routes through static service binding', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': routeSnapshot({
        runtime: 'worker',
        executionProvider: 'normal-worker-slot',
        workerName: 'pages-v2-production-slot-007',
        dispatch: {
          type: 'service-binding',
          slotId: 'slot_007',
          bindingName: 'SITE_SLOT_007',
        },
      }),
    },
    expectedSlotBinding: 'SITE_SLOT_007',
  });

  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'slot worker ok');
  assert.equal(env.dispatchGetCount, 0);
  assert.equal(env.slotDispatchCount, 1);
});

function assertNoCoolToneFragments(text) {
  for (const fragment of coolToneFragments) {
    assert.equal(text.includes(fragment), false, `unexpected cool tone fragment: ${fragment}`);
  }
}

function routeSnapshot(overrides = {}) {
  return {
    routeId: 'route_demo',
    environment: 'production',
    hostname: 'demo.pages.xd.team',
    routeStatus: 'active',
    runtime: 'worker',
    executionProvider: 'wfp',
    workerName: 'pages-v2-demo-worker',
    dispatch: {
      type: 'dispatch-namespace',
    },
    siteId: 'site_demo',
    siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
    slug: 'demo',
    visibility: 'internal',
    policyVersion: 1,
    ownerUserId: 'owner_1',
    acl: [],
    requiredSessionVersion: 1,
    activeVersionId: 'ver_demo',
    ...overrides,
  };
}

function routeEnv(overrides = {}) {
  const state = {
    lookupCount: 0,
    dispatchGetCount: 0,
    dispatchCount: 0,
    slotDispatchCount: 0,
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
    PAGES_SESSION_JWT_ISSUER: 'pages-router',
    PUBLIC_AUTH_BASE: 'https://auth.pages.xd.team',
    ROUTER_IP_ALLOWLIST_CIDRS: '10.0.0.0/8',
    PAGES_SESSION_JWT_ACTIVE_KID: 'prod-hs-2026-06',
    PAGES_SESSION_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    PAGES_CAP_JWT_ACTIVE_KID: 'cap-hs-2026-06',
    PAGES_CAP_JWT_KEYS: 'cap-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_TEST',
    PAGES_CAP_JWT_SECRET_TEST: 'test-capability-secret',
    nowSeconds: () => 1_700_000_000,
    ROUTE_SNAPSHOTS: routes,
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
    SITE_SLOT_007: {
      async fetch(request, dispatchedEnv) {
        state.slotDispatchCount += 1;
        env.slotDispatchCount = state.slotDispatchCount;
        state.dispatchedRequest = request;
        env.dispatchedRequest = request;
        state.dispatchedEnv = dispatchedEnv;
        env.dispatchedEnv = dispatchedEnv;
        return new Response('slot worker ok');
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
    get slotDispatchCount() {
      return state.slotDispatchCount;
    },
    set slotDispatchCount(value) {
      state.slotDispatchCount = value;
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
    lookupRoute:
      overrides.lookupRoute === undefined
        ? undefined
        : function lookupRoute(hostname) {
            state.lookupCount += 1;
            return routes[hostname] || null;
          },
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'routes' && key !== 'userResponse' && key !== 'expectedWorkerName') env[key] = value;
  }

  return env;
}

function gatewayEnv(overrides = {}) {
  const env = {
    XD_PAGES_ENV: 'production',
    PAGES_CAP_JWT_KEYS: 'cap-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_TEST',
    PAGES_CAP_JWT_SECRET_TEST: 'test-capability-secret',
    SITE_DATA: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    },
  };
  return { ...env, ...overrides };
}

function kvRouteSnapshots(records) {
  return {
    async get(key) {
      return Object.hasOwn(records, key) ? JSON.stringify(records[key]) : null;
    },
  };
}

async function siteSession({
  audience,
  userId = 'usr_1',
  siteId = 'site_demo',
  policyVersion = 1,
  sessionVersion = 1,
  employeeStatus = 'active',
  email = 'user@example.com',
  departments = [],
  userCheckedAt = 1_700_000_000,
} = {}) {
  return signSessionJwt(
    {
      purpose: 'site_session',
      audience,
      subject: userId,
      now: 1_700_000_000,
      ttlSeconds: 600,
      claims: {
        sid: 'sid_site',
        siteId,
        policyVersion,
        sessionVersion,
        userCheckedAt,
        employeeStatus,
        email,
        departments,
      },
    },
    {
      PAGES_ENV: 'production',
      PAGES_SESSION_JWT_ISSUER: 'pages-router',
      PAGES_SESSION_JWT_ACTIVE_KID: 'prod-hs-2026-06',
      PAGES_SESSION_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST',
      PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    }
  );
}
