import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { assertConsoleNetworkAllowed, assertSafeWriteRequest, isAllowedConsoleHost, isWriteMethod } from './security.js';

function env(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    IP_ALLOWLIST: '10.0.0.0/8',
    PAGES_SESSION_JWT_KEYS: 'kid-test:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    ASSETS: {
      async fetch() {
        return new Response('<!doctype html><div id="root"></div>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    },
    ...overrides,
  };
}

function request(path, { ip = '10.1.2.3', method = 'GET', headers = {}, host = 'workers.xd.team' } = {}) {
  return new Request(`https://${host}${path}`, {
    method,
    headers: {
      'CF-Connecting-IP': ip,
      ...headers,
    },
  });
}

test('only production and staging console hosts are allowed', () => {
  assert.equal(isAllowedConsoleHost(new URL('https://workers.xd.team/')), true);
  assert.equal(isAllowedConsoleHost(new URL('https://staging.workers.xd.team/')), true);
  assert.equal(isAllowedConsoleHost(new URL('https://evil.workers.xd.team/')), false);
  assert.equal(isAllowedConsoleHost(new URL('https://api.pages.xd.team/')), false);
});

test('console network guard allows only requests from IP allowlist', () => {
  assert.equal(assertConsoleNetworkAllowed(request('/'), env()), null);

  const denied = assertConsoleNetworkAllowed(request('/', { ip: '203.0.113.9' }), env());
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Cache-Control'), 'no-store');
});

test('console network guard rejects unexpected host before other checks', () => {
  const denied = assertConsoleNetworkAllowed(request('/', { host: 'admin.workers.xd.team' }), env());

  assert.equal(denied.status, 403);
});

test('all console routes are blocked outside IP allowlist before assets or bindings are used', async () => {
  const calls = [];
  const guardedEnv = env({
    ASSETS: {
      async fetch() {
        calls.push('assets');
        return new Response('asset');
      },
    },
    PAGES_AUTH: {
      async fetch() {
        calls.push('auth');
        return new Response('{}');
      },
    },
    PAGES_API: {
      async fetch() {
        calls.push('api');
        return new Response('{}');
      },
    },
  });

  for (const path of ['/', '/workspace/published', '/assets/app.js', '/api/console/auth/login', '/api/console/directory']) {
    const response = await worker.fetch(request(path, { ip: '203.0.113.9' }), guardedEnv);
    assert.equal(response.status, 403, path);
    const body = await response.json();
    assert.equal(body.error.code, 'IP_DENIED');
  }

  assert.deepEqual(calls, []);
});

test('IP allowlist does not replace workspace or admin identity checks', async () => {
  const workspaceHtml = await worker.fetch(request('/workspace/published', { headers: { Accept: 'text/html' } }), env());
  assert.equal(workspaceHtml.status, 302);
  assert.equal(workspaceHtml.headers.get('Location'), '/login?returnTo=%2Fworkspace%2Fpublished');

  const workspaceJson = await worker.fetch(request('/workspace/published', { headers: { Accept: 'application/json' } }), env());
  assert.equal(workspaceJson.status, 401);
  assert.equal((await workspaceJson.json()).error.code, 'SESSION_REQUIRED');

  const admin = await worker.fetch(request('/admin/webhooks'), env());
  assert.equal(admin.status, 401);
  assert.equal((await admin.json()).error.code, 'SESSION_REQUIRED');
});

test('staging public directory is reachable after IP allowlist while protected pages still require a session', async () => {
  const root = await worker.fetch(request('/', { host: 'staging.workers.xd.team' }), env({ PAGES_ENV: 'staging' }));
  assert.equal(root.status, 200);
  assert.match(root.headers.get('Content-Type'), /text\/html/);

  const workspace = await worker.fetch(
    request('/workspace/published', { host: 'staging.workers.xd.team' }),
    env({ PAGES_ENV: 'staging' })
  );
  assert.equal(workspace.status, 401);
  assert.equal((await workspace.json()).error.code, 'SESSION_REQUIRED');

  const admin = await worker.fetch(request('/admin', { host: 'staging.workers.xd.team' }), env({ PAGES_ENV: 'staging' }));
  assert.equal(admin.status, 401);
  assert.equal((await admin.json()).error.code, 'SESSION_REQUIRED');
});

test('safe write guard rejects missing same-origin evidence or csrf token', async () => {
  assert.equal(isWriteMethod('GET'), false);
  assert.equal(isWriteMethod('HEAD'), false);
  assert.equal(isWriteMethod('POST'), true);
  assert.equal(isWriteMethod('DELETE'), true);

  const missing = await assertSafeWriteRequest(request('/api/console/auth/logout', { method: 'POST' }));
  assert.equal(missing.status, 403);

  const crossOrigin = await assertSafeWriteRequest(
    request('/api/console/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: '__Host-xd_cell_csrf=csrf-1',
        Origin: 'https://evil.example',
        'X-CSRF-Token': 'csrf-1',
      },
    })
  );
  assert.equal(crossOrigin.status, 403);
});

test('safe write guard accepts same-origin request with matching csrf cookie and header', async () => {
  const result = await assertSafeWriteRequest(
    request('/api/console/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: '__Host-xd_cell_csrf=csrf-1',
        Origin: 'https://workers.xd.team',
        Referer: 'https://workers.xd.team/workspace',
        'X-CSRF-Token': 'csrf-1',
      },
    })
  );

  assert.equal(result, null);
});
