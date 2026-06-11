import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDeploy } from './deploy.js';

function deployRequest({ token } = {}) {
  const form = new FormData();
  form.set('name', 'demo');
  form.append('index', new Blob(['ok'], { type: 'text/html' }), 'index.html');

  return new Request('https://api.workers.xd.team/deploy', {
    method: 'POST',
    headers: token ? { 'X-Pages-Token': token } : {},
    body: form,
  });
}

function envWithExistingSite(existing) {
  return {
    CF_API_TOKEN: 'dummy-token',
    CF_ACCOUNT_ID: 'dummy-account',
    CF_ZONE_ID_NEW: 'dummy-zone',
    WORKER_PREFIX: 'pages-',
    DOMAIN_LABEL: '',
    DOMAIN_BASE: 'workers.xd.team',
    WORKERS_DEV_SUBDOMAIN: 'xd-cf-2022',
    IP_ALLOWLIST: '127.0.0.1',
    SITES: {
      async get() {
        return existing;
      },
      async put() {
        throw new Error('conflicting deployments must not write metadata');
      },
    },
  };
}

test('deploy rejects existing site when request omits token', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ success: true, result: {} }));
  };

  try {
    const response = await handleDeploy(
      deployRequest(),
      envWithExistingSite({ token: 'pages_owner@xd.com', createdAt: '2026-01-01T00:00:00.000Z' })
    );

    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error, '站点名称已被占用');
    assert.equal(body.name, 'demo');
    assert.equal(calls.length, 0);
    assert.doesNotMatch(JSON.stringify(body), /pages_owner@xd\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deploy conflict response does not expose existing owner token', async () => {
  const response = await handleDeploy(
    deployRequest({ token: 'pages_other@xd.com' }),
    envWithExistingSite({ token: 'pages_owner@xd.com', createdAt: '2026-01-01T00:00:00.000Z' })
  );

  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, '站点名称已被占用');
  assert.equal(body.name, 'demo');
  assert.equal(body.owner, undefined);
  assert.doesNotMatch(JSON.stringify(body), /pages_owner@xd\.com/);
});
