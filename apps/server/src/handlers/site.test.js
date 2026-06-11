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

test('site delete allows the owning token', async () => {
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ success: true, result: {} }));
  };
  const env = envWithSite({ name: 'demo', token: 'pages_owner@xd.com', scriptName: 'pages-demo' });

  try {
    const response = await handleDeleteSite(siteRequest('/site/demo', 'pages_owner@xd.com'), env, { name: 'demo' });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.deepEqual(env.deleted, ['demo']);
    assert.equal(fetchCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
