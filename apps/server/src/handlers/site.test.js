import assert from 'node:assert/strict';
import test from 'node:test';

import { handleDeleteSite, handleGetSite } from './site.js';

function siteRequest(path = '/site/demo', token) {
  return new Request(`https://api.workers.xd.team${path}`, {
    headers: token ? { 'X-Pages-Token': token } : {},
  });
}

function envWithSite(site) {
  const deleted = [];
  return {
    CF_API_TOKEN: 'dummy-token',
    CF_ACCOUNT_ID: 'dummy-account',
    WORKER_PREFIX: 'pages-',
    deleted,
    SITES: {
      async get() {
        return site;
      },
      async delete(name) {
        deleted.push(name);
      },
    },
  };
}

function hostnameClaimsBinding(handler) {
  return {
    async fetch(request) {
      const body = await request.json();
      const result = await handler(body.claim);
      if (result instanceof Response) return result;
      if (result?.ok === false) {
        return Response.json({ error: { code: result.code, message: result.message } }, { status: 409 });
      }
      return Response.json(result || { claim: body.claim });
    },
  };
}

test('site detail requires a token before reading metadata', async () => {
  const response = await handleGetSite(
    siteRequest(),
    {
      SITES: {
        async get() {
          throw new Error('missing token requests must not read metadata');
        },
      },
    },
    { name: 'demo' }
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, '缺少 token');
});

test('site detail rejects a token that does not own the site', async () => {
  const response = await handleGetSite(
    siteRequest('/site/demo', 'pages_other@xd.com'),
    envWithSite({ name: 'demo', token: 'pages_owner@xd.com', scriptName: 'pages-demo' }),
    { name: 'demo' }
  );
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error, '无权访问该站点');
  assert.equal(body.name, 'demo');
  assert.doesNotMatch(JSON.stringify(body), /pages_owner@xd\.com/);
});

test('site detail accepts token query parameter', async () => {
  const response = await handleGetSite(
    siteRequest('/site/demo?token=pages_owner@xd.com'),
    envWithSite({ name: 'demo', token: 'pages_owner@xd.com', scriptName: 'pages-demo' }),
    { name: 'demo' }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.name, 'demo');
  assert.equal(body.token, undefined);
  assert.doesNotMatch(JSON.stringify(body), /pages_owner@xd\.com/);
});

test('site detail strips owner token from successful response', async () => {
  const response = await handleGetSite(
    siteRequest('/site/demo', 'pages_owner@xd.com'),
    envWithSite({
      name: 'demo',
      preset: 'static',
      token: 'pages_owner@xd.com',
      scriptName: 'pages-demo',
      url: 'https://demo.workers.xd.team',
    }),
    { name: 'demo' }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.name, 'demo');
  assert.equal(body.token, undefined);
  assert.doesNotMatch(JSON.stringify(body), /pages_owner@xd\.com/);
});

test('site detail exposes only public fields', async () => {
  const response = await handleGetSite(
    siteRequest('/site/demo', 'pages_owner@xd.com'),
    envWithSite({
      name: 'demo',
      preset: 'spa',
      token: 'pages_owner@xd.com',
      scriptName: 'pages-demo',
      url: 'https://demo.workers.xd.team',
      devUrl: 'https://pages-demo.xd-cf-2022.workers.dev',
      fileCount: 12,
      ipRestrict: true,
      kvEnabled: true,
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      siteGeneration: 3,
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
    }),
    { name: 'demo' }
  );
  const body = await response.json();

  assert.deepEqual(body, {
    name: 'demo',
    preset: 'spa',
    scriptName: 'pages-demo',
    url: 'https://demo.workers.xd.team',
    devUrl: 'https://pages-demo.xd-cf-2022.workers.dev',
    fileCount: 12,
    ipRestrict: true,
    kvEnabled: false,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(body), /token|siteUuid|siteGeneration|pages_owner@xd\.com/);
});

test('site delete rejects a token that does not own the site before deleting Cloudflare resources', async () => {
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ success: true, result: {} }));
  };
  const env = envWithSite({ name: 'demo', token: 'pages_owner@xd.com', scriptName: 'pages-demo' });

  try {
    const response = await handleDeleteSite(siteRequest('/site/demo', 'pages_other@xd.com'), env, { name: 'demo' });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.error, '无权访问该站点');
    assert.equal(env.deleted.length, 0);
    assert.equal(fetchCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(body), /pages_owner@xd\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('site delete rejects platform reserved names before deleting Cloudflare resources', async () => {
  const reservedNames = ['kv-gateway', 'auth', 'router', 'v2-production-slot-001', 'v2-staging-slot-001'];
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ success: true, result: {} }));
  };

  try {
    for (const name of reservedNames) {
      const response = await handleDeleteSite(
        siteRequest(`/site/${name}`, 'pages_owner@xd.com'),
        {
          SITES: {
            async get() {
              throw new Error('reserved names must not read metadata');
            },
          },
        },
        { name }
      );
      const body = await response.json();

      assert.equal(response.status, 403);
      assert.equal(body.error, '站点名称为平台保留名称');
      assert.equal(body.name, name);
    }
    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('site delete allows the owning token', async () => {
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method || 'GET', body: options.body || null });
    if (String(url).endsWith('/zones/dummy-zone/workers/routes')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: 'route_1', pattern: 'demo.workers.xd.team/*', script: 'pages-demo' }],
        })
      );
    }
    return new Response(JSON.stringify({ success: true, result: {} }));
  };
  const env = envWithSite({
    name: 'demo',
    token: 'pages_owner@xd.com',
    scriptName: 'pages-demo',
    url: 'https://demo.workers.xd.team',
  });
  env.CF_ZONE_ID_NEW = 'dummy-zone';

  try {
    const response = await handleDeleteSite(siteRequest('/site/demo', 'pages_owner@xd.com'), env, { name: 'demo' });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.deepEqual(env.deleted, ['demo']);
    assert.deepEqual(
      fetchCalls.map((call) => [call.method, call.url.replace(/https:\/\/api\.cloudflare\.com\/client\/v4/, '')]),
      [
        ['GET', '/zones/dummy-zone/workers/routes'],
        ['DELETE', '/zones/dummy-zone/workers/routes/route_1'],
        ['DELETE', '/accounts/dummy-account/workers/scripts/pages-demo?force=true'],
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('site delete refuses to unbind wildcard or script-mismatched routes', async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      name: 'wildcard route',
      routes: [{ id: 'route_wildcard', pattern: '*.workers.xd.team/*', script: 'pages-router' }],
      message: /精确 route/,
    },
    {
      name: 'script mismatch',
      routes: [{ id: 'route_other', pattern: 'demo.workers.xd.team/*', script: 'pages-other' }],
      message: /script/i,
    },
  ];

  try {
    for (const item of cases) {
      const fetchCalls = [];
      globalThis.fetch = async (url, options = {}) => {
        fetchCalls.push({ url: String(url), method: options.method || 'GET' });
        if (String(url).endsWith('/zones/dummy-zone/workers/routes')) {
          return new Response(JSON.stringify({ success: true, result: item.routes }));
        }
        return new Response(JSON.stringify({ success: true, result: {} }));
      };
      const env = envWithSite({
        name: 'demo',
        token: 'pages_owner@xd.com',
        scriptName: 'pages-demo',
        url: 'https://demo.workers.xd.team',
      });
      env.CF_ZONE_ID_NEW = 'dummy-zone';

      const response = await handleDeleteSite(siteRequest('/site/demo', 'pages_owner@xd.com'), env, { name: 'demo' });
      const body = await response.json();

      assert.equal(response.status, 403, item.name);
      assert.match(body.error, item.message, item.name);
      assert.equal(env.deleted.length, 0, item.name);
      assert.equal(fetchCalls.some((call) => call.method === 'DELETE'), false, item.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('site delete releases hostname claim into a short reuse hold after metadata delete', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/zones/dummy-zone/workers/routes')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: 'route_1', pattern: 'demo.workers.xd.team/*', script: 'pages-demo' }],
        })
      );
    }
    return new Response(JSON.stringify({ success: true, result: {} }));
  };
  const releases = [];
  const env = envWithSite({
    name: 'demo',
    token: 'pages_owner@xd.com',
    scriptName: 'pages-demo',
    url: 'https://demo.workers.xd.team',
  });
  env.CF_ZONE_ID_NEW = 'dummy-zone';
  env.HOSTNAME_CLAIMS_MODE = 'enforce';
  env.now = () => '2026-06-15T00:00:00.000Z';
  env.HOSTNAME_CLAIMS = hostnameClaimsBinding(async (claim) => {
    releases.push(claim);
    return { claim };
  });

  try {
    const response = await handleDeleteSite(siteRequest('/site/demo', 'pages_owner@xd.com'), env, { name: 'demo' });

    assert.equal(response.status, 200);
    assert.deepEqual(releases, [
      {
        environment: 'production',
        hostname: 'demo.workers.xd.team',
        normalizedSlug: 'demo',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:demo',
        ownerRef: 'pages-demo',
        source: 'v1_delete',
        status: 'active',
        releaseReason: 'site_deleted',
        reuseHoldUntil: '2026-06-15T00:05:00.000Z',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('site delete uses service binding fetch even when hostname claim release method exists', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/zones/dummy-zone/workers/routes')) {
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: 'route_1', pattern: 'demo.workers.xd.team/*', script: 'pages-demo' }],
        })
      );
    }
    return new Response(JSON.stringify({ success: true, result: {} }));
  };
  const serviceRequests = [];
  const env = envWithSite({
    name: 'demo',
    token: 'pages_owner@xd.com',
    scriptName: 'pages-demo',
    url: 'https://demo.workers.xd.team',
  });
  env.CF_ZONE_ID_NEW = 'dummy-zone';
  env.HOSTNAME_CLAIMS_MODE = 'enforce';
  env.HOSTNAME_CLAIMS = {
    async release() {
      throw new Error('rpc release must not be called');
    },
    async fetch(request) {
      serviceRequests.push({
        url: request.url,
        method: request.method,
      });
      return Response.json({ claim: { hostname: 'demo.workers.xd.team' } });
    },
  };

  try {
    const response = await handleDeleteSite(siteRequest('/site/demo', 'pages_owner@xd.com'), env, { name: 'demo' });

    assert.equal(response.status, 200);
    assert.deepEqual(serviceRequests, [
      {
        url: 'https://pages-api.internal/.xd-pages/internal/hostname-claims/release',
        method: 'POST',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
