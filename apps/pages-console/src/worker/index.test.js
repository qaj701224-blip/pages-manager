import assert from 'node:assert/strict';
import test from 'node:test';

import { signSessionJwt } from '../../../pages-auth/src/jwt.js';
import worker from './index.js';
import { serializeConsoleSessionCookie } from './session.js';

const NOW = 1_800_000_000;

function env(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    IP_ALLOWLIST: '10.0.0.0/8',
    PAGES_SESSION_JWT_KEYS: 'kid-test:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    now: () => NOW,
    PAGES_API: apiBinding(async () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })),
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/assets/app.js') {
          return new Response('console.log("xd-cell");', {
            headers: { 'Content-Type': 'application/javascript' },
          });
        }
        return new Response('<!doctype html><div id="root"></div>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    },
    ...overrides,
  };
}

function authBinding(handler) {
  return {
    async fetch(request) {
      return handler(request);
    },
  };
}

function apiBinding(handler, options = {}) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/.xd-pages/api/console/auth/session') {
        if (typeof options.session === 'function') return options.session(request);
        return Response.json({ session: options.session || echoConsoleSession(request) });
      }
      return handler(request);
    },
  };
}

function echoConsoleSession(request) {
  return {
    userId: request.headers.get('X-Console-User-Id'),
    email: request.headers.get('X-Console-Email') || '',
    employeeStatus: 'active',
    sessionVersion: Number(request.headers.get('X-Console-Session-Version') || 1),
    isPlatformAdmin: request.headers.get('X-Console-Admin') === 'true',
  };
}

async function sessionCookie({ isPlatformAdmin = false, sessionVersion = 7, environment = 'production' } = {}) {
  const token = await signSessionJwt(
    {
      purpose: 'console_session',
      audience: 'xd-cell-console',
      subject: 'user-1',
      now: NOW,
      ttlSeconds: 600,
      claims: {
        email: 'user@example.com',
        isPlatformAdmin,
        sessionVersion,
      },
    },
    jwtSigningEnv({ PAGES_ENV: environment })
  );
  const header = serializeConsoleSessionCookie(token);
  return header.split(';')[0];
}

async function consoleSessionToken({ isPlatformAdmin = false, sessionVersion = 2, environment = 'production' } = {}) {
  return signSessionJwt(
    {
      purpose: 'console_session',
      audience: 'xd-cell-console',
      subject: 'usr_1',
      now: NOW,
      ttlSeconds: 600,
      claims: {
        email: 'user@example.com',
        employeeStatus: 'active',
        isPlatformAdmin,
        sessionVersion,
      },
    },
    jwtSigningEnv({ PAGES_ENV: environment })
  );
}

function jwtSigningEnv(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_SESSION_JWT_ACTIVE_KID: 'kid-test',
    PAGES_SESSION_JWT_KEYS: 'kid-test:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    ...overrides,
  };
}

function request(url, { cookie, method = 'GET', headers = {}, body } = {}) {
  return new Request(url, {
    method,
    headers: {
      'CF-Connecting-IP': '10.1.2.3',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body,
  });
}

test('production root returns app shell', async () => {
  const response = await worker.fetch(request('https://workers.xd.team/'), env());

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.match(await response.text(), /id="root"/);
});

test('workspace route with a session falls back to app shell', async () => {
  const calls = [];
  const response = await worker.fetch(
    request('https://workers.xd.team/workspace/published', { cookie: await sessionCookie() }),
    env({
      PAGES_API: apiBinding(async () => {
        calls.push('api');
        return Response.json({ error: { code: 'UNEXPECTED_API_CALL' } }, { status: 500 });
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.deepEqual(calls, []);
});

test('workspace route without a session redirects browser navigation to login page', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/workspace/published', {
      headers: { Accept: 'text/html' },
    }),
    env()
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/login?returnTo=%2Fworkspace%2Fpublished');
});

test('login route returns app shell without requiring a session', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/login?returnTo=/workspace/published', {
      headers: { Accept: 'text/html' },
    }),
    env()
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
});

test('static assets are served by assets binding', async () => {
  const response = await worker.fetch(request('https://workers.xd.team/assets/app.js'), env());

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/javascript/);
  assert.match(await response.text(), /xd-cell/);
});

test('missing console API returns safe JSON 404', async () => {
  const response = await worker.fetch(request('https://workers.xd.team/api/console/missing'), env());

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('directory proxies to pages-api internal service binding without forged console headers', async () => {
  const calls = [];
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/directory', {
      headers: {
        'X-Console-Admin': 'true',
        'X-Console-User-Id': 'attacker',
      },
    }),
    env({
      PAGES_API: apiBinding(async (apiRequest) => {
        calls.push({
          url: apiRequest.url,
          host: apiRequest.headers.get('Host'),
          bff: apiRequest.headers.get('X-Console-BFF'),
          userId: apiRequest.headers.get('X-Console-User-Id'),
          admin: apiRequest.headers.get('X-Console-Admin'),
        });
        return Response.json({ sites: [] }, { status: 200, headers: { 'Cache-Control': 'private' } });
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(calls, [
    {
      url: 'https://pages-api.internal/.xd-pages/api/console/directory',
      host: 'pages-api.internal',
      bff: 'pages-console',
      userId: null,
      admin: null,
    },
  ]);
});

test('workspace proxy forwards only signed session identity to pages-api', async () => {
  const cookie = await sessionCookie({ isPlatformAdmin: true });
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/workspace/sites?owner=personal', {
      cookie,
      headers: { 'X-Console-User-Id': 'attacker' },
    }),
    env({
      PAGES_API: apiBinding(async (apiRequest) => {
        assert.equal(apiRequest.url, 'https://pages-api.internal/.xd-pages/api/console/workspace/sites?owner=personal');
        assert.equal(apiRequest.headers.get('X-Console-User-Id'), 'user-1');
        assert.equal(apiRequest.headers.get('X-Console-Email'), 'user@example.com');
        assert.equal(apiRequest.headers.get('X-Console-Admin'), null);
        return Response.json({ sites: [] }, { status: 200 });
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sites: [] });
});

test('workspace proxy forwards signed identity without auth session preflight', async () => {
  const cookie = await sessionCookie();
  const calls = [];

  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/workspace/sites?owner=personal', { cookie }),
    env({
      PAGES_API: apiBinding(
        async (apiRequest) => {
          calls.push(new URL(apiRequest.url).pathname);
          return Response.json({ sites: [] }, { status: 200 });
        },
        {
          session: async (apiRequest) => {
            calls.push(new URL(apiRequest.url).pathname);
            return Response.json({ session: echoConsoleSession(apiRequest) });
          },
        }
      ),
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(calls, ['/.xd-pages/api/console/workspace/sites']);
});

test('teams proxy forwards signed session identity to pages-api', async () => {
  const cookie = await sessionCookie();
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/teams/team_department_XD_Platform_Web', {
      cookie,
      headers: { 'X-Console-User-Id': 'attacker' },
    }),
    env({
      PAGES_API: apiBinding(async (apiRequest) => {
        assert.equal(apiRequest.url, 'https://pages-api.internal/.xd-pages/api/console/teams/team_department_XD_Platform_Web');
        assert.equal(apiRequest.headers.get('X-Console-User-Id'), 'user-1');
        assert.equal(apiRequest.headers.get('X-Console-Email'), 'user@example.com');
        assert.equal(apiRequest.headers.get('X-Console-BFF'), 'pages-console');
        return Response.json({ team: { id: 'team_department_XD_Platform_Web', name: 'XD/Platform/Web' } });
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { team: { id: 'team_department_XD_Platform_Web', name: 'XD/Platform/Web' } });
});

test('console users proxy forwards signed session identity to pages-api', async () => {
  const cookie = await sessionCookie();
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/users?query=xutianqi', {
      cookie,
      headers: { 'X-Console-User-Id': 'attacker' },
    }),
    env({
      PAGES_API: apiBinding(async (apiRequest) => {
        assert.equal(apiRequest.url, 'https://pages-api.internal/.xd-pages/api/console/users?query=xutianqi');
        assert.equal(apiRequest.headers.get('X-Console-User-Id'), 'user-1');
        assert.equal(apiRequest.headers.get('X-Console-BFF'), 'pages-console');
        return Response.json({ users: [] });
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { users: [] });
});

test('access key proxy forwards signed session identity and JSON body to pages-api', async () => {
  const cookie = await sessionCookie();
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/teams/team_1/access-keys', {
      method: 'POST',
      cookie,
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${cookie}; xd_cell_csrf=csrf-1`,
        Origin: 'https://workers.xd.team',
        'X-CSRF-Token': 'csrf-1',
        'X-Console-User-Id': 'attacker',
      },
      body: JSON.stringify({ name: 'team key', scopes: ['deploy:site'] }),
    }),
    env({
      PAGES_API: apiBinding(async (apiRequest) => {
        assert.equal(apiRequest.url, 'https://pages-api.internal/.xd-pages/api/console/teams/team_1/access-keys');
        assert.equal(apiRequest.method, 'POST');
        assert.equal(apiRequest.headers.get('X-Console-User-Id'), 'user-1');
        assert.equal(apiRequest.headers.get('X-Console-BFF'), 'pages-console');
        assert.equal(apiRequest.headers.get('Content-Type'), 'application/json');
        assert.deepEqual(await apiRequest.json(), { name: 'team key', scopes: ['deploy:site'] });
        return Response.json({ accessKey: { id: 'ak_team' } }, { status: 201 });
      }),
    })
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(await response.json(), { accessKey: { id: 'ak_team' } });
});

test('site management proxy forwards access and runtime config writes to pages-api', async () => {
  const cookie = await sessionCookie();
  const calls = [];
  const apiEnv = env({
    PAGES_API: apiBinding(async (apiRequest) => {
      calls.push({
        url: apiRequest.url,
        method: apiRequest.method,
        userId: apiRequest.headers.get('X-Console-User-Id'),
        bff: apiRequest.headers.get('X-Console-BFF'),
        contentType: apiRequest.headers.get('Content-Type'),
        body: apiRequest.method === 'DELETE' ? null : await apiRequest.json(),
      });
      return Response.json({ ok: true }, { status: 200 });
    }),
  });

  const writeHeaders = {
    'Content-Type': 'application/json',
    Cookie: `${cookie}; xd_cell_csrf=csrf-1`,
    Origin: 'https://workers.xd.team',
    'X-CSRF-Token': 'csrf-1',
    'X-Console-User-Id': 'attacker',
  };

  const accessResponse = await worker.fetch(
    request('https://workers.xd.team/api/console/sites/site_1/access', {
      method: 'PATCH',
      headers: writeHeaders,
      body: JSON.stringify({ visibility: 'acl', aclEntries: [] }),
    }),
    apiEnv
  );
  const varResponse = await worker.fetch(
    request('https://workers.xd.team/api/console/sites/site_1/config/vars/API_BASE', {
      method: 'PUT',
      headers: writeHeaders,
      body: JSON.stringify({ value: 'https://api.example.test' }),
    }),
    apiEnv
  );
  const secretResponse = await worker.fetch(
    request('https://workers.xd.team/api/console/sites/site_1/config/secrets/API_TOKEN', {
      method: 'DELETE',
      headers: writeHeaders,
    }),
    apiEnv
  );

  assert.equal(accessResponse.status, 200, await accessResponse.clone().text());
  assert.equal(varResponse.status, 200, await varResponse.clone().text());
  assert.equal(secretResponse.status, 200, await secretResponse.clone().text());
  assert.deepEqual(calls, [
    {
      url: 'https://pages-api.internal/.xd-pages/api/console/sites/site_1/access',
      method: 'PATCH',
      userId: 'user-1',
      bff: 'pages-console',
      contentType: 'application/json',
      body: { visibility: 'acl', aclEntries: [] },
    },
    {
      url: 'https://pages-api.internal/.xd-pages/api/console/sites/site_1/config/vars/API_BASE',
      method: 'PUT',
      userId: 'user-1',
      bff: 'pages-console',
      contentType: 'application/json',
      body: { value: 'https://api.example.test' },
    },
    {
      url: 'https://pages-api.internal/.xd-pages/api/console/sites/site_1/config/secrets/API_TOKEN',
      method: 'DELETE',
      userId: 'user-1',
      bff: 'pages-console',
      contentType: 'application/json',
      body: null,
    },
  ]);
});

test('admin proxy forwards signed platform admin session and JSON body to pages-api', async () => {
  const cookie = await sessionCookie({ isPlatformAdmin: true });
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/admin/platform-admins', {
      method: 'POST',
      cookie,
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${cookie}; xd_cell_csrf=csrf-1`,
        Origin: 'https://workers.xd.team',
        'X-CSRF-Token': 'csrf-1',
        'X-Console-Admin': 'false',
      },
      body: JSON.stringify({ userId: 'usr_admin', reason: 'bootstrap' }),
    }),
    env({
      PAGES_API: apiBinding(async (apiRequest) => {
        assert.equal(apiRequest.url, 'https://pages-api.internal/.xd-pages/api/console/admin/platform-admins');
        assert.equal(apiRequest.method, 'POST');
        assert.equal(apiRequest.headers.get('X-Console-User-Id'), 'user-1');
        assert.equal(apiRequest.headers.get('X-Console-Admin'), null);
        assert.equal(apiRequest.headers.get('Content-Type'), 'application/json');
        assert.deepEqual(await apiRequest.json(), { userId: 'usr_admin', reason: 'bootstrap' });
        return Response.json({ admin: { userId: 'usr_admin' } }, { status: 200 });
      }),
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { admin: { userId: 'usr_admin' } });
});

test('pages-api proxy preserves JSON error status and code', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/directory'),
    env({
      PAGES_API: apiBinding(async () =>
        Response.json({ error: { code: 'CONSOLE_FORBIDDEN', message: 'Forbidden' } }, { status: 403 })
      ),
    })
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { error: { code: 'CONSOLE_FORBIDDEN', message: 'Forbidden' } });
});

test('auth login calls pages-auth service binding and redirects to authorize URL', async () => {
  const calls = [];
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/auth/login?returnTo=/workspace'),
    env({
      PAGES_AUTH: authBinding(async (authRequest) => {
        calls.push({
          url: authRequest.url,
          host: authRequest.headers.get('Host'),
          body: await authRequest.json(),
        });
        return Response.json({ authorizeUrl: 'https://auth.pages.xd.team/.xd-pages/auth/authorize?console=1' });
      }),
    })
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://auth.pages.xd.team/.xd-pages/auth/authorize?console=1');
  assert.deepEqual(calls, [
    {
      url: 'https://pages-auth.internal/.xd-pages/internal/console/login-code',
      host: 'pages-auth.internal',
      body: { returnTo: '/workspace' },
    },
  ]);
});

test('staging login page is reachable without an existing admin session', async () => {
  const response = await worker.fetch(
    request('https://staging.workers.xd.team/login?returnTo=/admin', {
      headers: { Accept: 'text/html' },
    }),
    env({ PAGES_ENV: 'staging' })
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
});

test('auth callback exchanges code, sets host-only console cookie, and redirects to relative returnTo', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/auth/callback?code=ost_console.console-secret'),
    env({
      PAGES_AUTH: authBinding(async (authRequest) => {
        assert.equal(authRequest.url, 'https://pages-auth.internal/.xd-pages/internal/console/exchange');
        assert.equal(authRequest.headers.get('Host'), 'pages-auth.internal');
        assert.deepEqual(await authRequest.json(), { code: 'ost_console.console-secret' });
        return Response.json({
          userId: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          sessionVersion: 2,
          environment: 'production',
          returnTo: '/workspace',
          isPlatformAdmin: false,
          consoleSessionToken: await consoleSessionToken(),
        });
      }),
    })
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/workspace');
  const setCookie = response.headers.get('Set-Cookie');
  assert.match(setCookie, /^xd_cell_session=/);
  assert.match(setCookie, /xd_cell_csrf=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.doesNotMatch(setCookie, /Domain=/i);
});

test('auth callback fails closed when pages-auth does not return a session token', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/auth/callback?code=ost_console.console-secret'),
    env({
      PAGES_AUTH: authBinding(async () =>
        Response.json({
          userId: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          sessionVersion: 2,
          environment: 'production',
          returnTo: '/workspace',
          isPlatformAdmin: false,
        })
      ),
    })
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'CONSOLE_SESSION_TOKEN_MISSING');
  assert.doesNotMatch(response.headers.get('Set-Cookie') || '', /^xd_cell_session=/);
});

test('auth callback redirects back to login and clears cookies when code exchange fails', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/auth/callback?code=expired-code'),
    env({
      PAGES_AUTH: authBinding(async () =>
        Response.json({ error: { code: 'CONSOLE_CODE_INVALID' } }, { status: 400 })
      ),
    })
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/login?error=auth_failed');
  const setCookie = response.headers.get('Set-Cookie') || '';
  assert.match(setCookie, /xd_cell_session=;/);
  assert.match(setCookie, /xd_cell_csrf=;/);
});

test('staging auth callback rejects non-platform admins and clears session cookie', async () => {
  const response = await worker.fetch(
    request('https://staging.workers.xd.team/api/console/auth/callback?code=ost_console.console-secret'),
    env({
      PAGES_ENV: 'staging',
      PAGES_AUTH: authBinding(async () =>
        Response.json({
          userId: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          sessionVersion: 2,
          environment: 'staging',
          returnTo: '/workspace',
          isPlatformAdmin: false,
          consoleSessionToken: await consoleSessionToken({ environment: 'staging' }),
        })
      ),
    })
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ADMIN_REQUIRED');
  assert.match(response.headers.get('Set-Cookie'), /^xd_cell_session=;/);
});

test('staging API proxy requires a session before pages-api binding', async () => {
  const calls = [];
  const response = await worker.fetch(
    request('https://staging.workers.xd.team/api/console/directory'),
    env({
      PAGES_ENV: 'staging',
      PAGES_API: apiBinding(async () => {
        calls.push('api');
        return Response.json({ sites: [] });
      }),
    })
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'SESSION_REQUIRED');
  assert.deepEqual(calls, []);
});

test('staging API proxy marks internal pages-api requests as admin required', async () => {
  const cookie = await sessionCookie({ isPlatformAdmin: true, environment: 'staging' });
  const calls = [];
  const response = await worker.fetch(
    request('https://staging.workers.xd.team/api/console/directory', { cookie }),
    env({
      PAGES_ENV: 'staging',
      PAGES_API: apiBinding(
        async (apiRequest) => {
          calls.push(new URL(apiRequest.url).pathname);
          assert.equal(apiRequest.headers.get('X-Console-Require-Admin'), 'true');
          assert.equal(apiRequest.headers.get('X-Console-Admin'), null);
          return Response.json({ sites: [] });
        },
        {
          session: async (apiRequest) => {
            calls.push(new URL(apiRequest.url).pathname);
            return Response.json({
              session: {
                userId: 'user-1',
                email: 'user@example.com',
                employeeStatus: 'active',
                sessionVersion: 7,
                isPlatformAdmin: true,
              },
            });
          },
        }
      ),
    })
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { sites: [] });
  assert.deepEqual(calls, ['/.xd-pages/api/console/directory']);
});

test('admin browser navigation redirects missing session to login', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/admin', {
      headers: { Accept: 'text/html' },
    }),
    env()
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/login?returnTo=%2Fadmin');
});

test('admin browser navigation for non-admin session returns guarded app shell', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/admin', {
      cookie: await sessionCookie({ isPlatformAdmin: false }),
      headers: { Accept: 'text/html' },
    }),
    env()
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
});

test('admin gate uses authoritative session validation instead of cookie admin claim', async () => {
  const calls = [];
  const response = await worker.fetch(
    request('https://workers.xd.team/admin/dashboard', {
      cookie: await sessionCookie({ isPlatformAdmin: true }),
      headers: { Accept: 'application/json' },
    }),
    env({
      PAGES_API: apiBinding(async () => Response.json({ error: { code: 'UNEXPECTED_PROXY' } }, { status: 500 }), {
        session: async (apiRequest) => {
          calls.push(new URL(apiRequest.url).pathname);
          return Response.json({
            session: {
              userId: 'user-1',
              email: 'user@example.com',
              employeeStatus: 'active',
              sessionVersion: 7,
              isPlatformAdmin: false,
            },
          });
        },
      }),
    })
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ADMIN_REQUIRED');
  assert.deepEqual(calls, ['/.xd-pages/api/console/auth/session']);
});

test('auth session endpoint returns current console session without exposing cookie payload', async () => {
  const anonymous = await worker.fetch(request('https://workers.xd.team/api/console/auth/session'), env());
  const admin = await worker.fetch(
    request('https://workers.xd.team/api/console/auth/session', {
      cookie: await sessionCookie({ isPlatformAdmin: true }),
    }),
    env({
      PAGES_API: apiBinding(async () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }), {
        session: async (apiRequest) =>
          Response.json({
            session: {
              ...echoConsoleSession(apiRequest),
              realname: '徐天麒',
              departmentPath: '心动/平台支撑部/Web',
              isPlatformAdmin: true,
            },
          }),
      }),
    })
  );

  assert.equal(anonymous.status, 200);
  assert.deepEqual(await anonymous.json(), { authenticated: false, user: null });
  assert.equal(admin.status, 200);
  assert.deepEqual(await admin.json(), {
    authenticated: true,
    user: {
      userId: 'user-1',
      email: 'user@example.com',
      realname: '徐天麒',
      departmentPath: '心动/平台支撑部/Web',
      isPlatformAdmin: true,
    },
  });
});

test('auth session endpoint fails closed when session JWT config is missing', async () => {
  const forged = serializeConsoleSessionCookie(await consoleSessionToken({ isPlatformAdmin: true }));

  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/auth/session', { cookie: forged.split(';')[0] }),
    env({ PAGES_SESSION_JWT_KEYS: '' })
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'CONSOLE_SESSION_JWT_CONFIG_MISSING');
});

test('logout clears console session cookie and redirects through pages-auth logout', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/api/console/auth/logout', {
      headers: {
        Cookie: 'xd_cell_csrf=csrf-1',
      },
    }),
    env()
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get('Location'),
    'https://auth.pages.xd.team/.xd-pages/auth/logout?return_to=https%3A%2F%2Fworkers.xd.team%2Flogin%3FloggedOut%3D1'
  );
  assert.match(response.headers.get('Set-Cookie'), /^xd_cell_session=;/);
  assert.match(response.headers.get('Set-Cookie'), /xd_cell_csrf=;/);
});

test('app shell issues a readable csrf cookie for subsequent write requests', async () => {
  const response = await worker.fetch(
    request('https://workers.xd.team/workspace/published', {
      cookie: await sessionCookie(),
      headers: { Accept: 'text/html' },
    }),
    env()
  );

  assert.equal(response.status, 200);
  const setCookie = response.headers.get('Set-Cookie') || '';
  assert.match(setCookie, /xd_cell_csrf=/);
  assert.doesNotMatch(setCookie, /xd_cell_csrf=[^;]+;[^,]*HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/);
});

test('staging root returns app shell for platform admin session', async () => {
  const response = await worker.fetch(
    request('https://staging.workers.xd.team/', {
      cookie: await sessionCookie({ isPlatformAdmin: true, environment: 'staging' }),
    }),
    env({
      PAGES_ENV: 'staging',
      PAGES_API: apiBinding(async () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }), {
        session: async (apiRequest) =>
          Response.json({
            session: {
              ...echoConsoleSession(apiRequest),
              isPlatformAdmin: true,
            },
          }),
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
});
