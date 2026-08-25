import assert from 'node:assert/strict';
import test from 'node:test';

import { signSessionJwt } from '@xd/session-kit';

import worker, { AuthSessionDO, CliLoginDO, OAuthStateDO } from './index.js';

test('health endpoint returns non-sensitive environment status without cache', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'production',
    createRequestId: () => 'req_test_health',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Request-Id'), 'req_test_health');
  assert.deepEqual(await response.json(), { status: 'ok', service: 'pages-auth', environment: 'production' });
});

test('unknown paths return safe no-store errors', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/not-found'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});

test('worker adds server-generated requestId to JSON errors without trusting public headers', async () => {
  const response = await worker.fetch(
    new Request('https://auth.pages.xd.team/not-found', {
      headers: {
        'X-Request-Id': 'attacker-request',
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        'CF-Platform-Trace-Id': 'attacker-trace',
      },
    }),
    {
      PAGES_ENV: 'production',
      createRequestId: () => 'req_test_server',
    }
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('X-Request-Id'), 'req_test_server');
  assert.deepEqual(await response.json(), {
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found.',
      requestId: 'req_test_server',
    },
  });
});

test('worker falls back when the injected requestId is unsafe', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/not-found'), {
    PAGES_ENV: 'production',
    createRequestId: () => 'req_bad\nrequest',
  });

  const body = await response.json();
  const requestId = response.headers.get('X-Request-Id');
  assert.match(requestId, /^req_[a-f0-9]{32}$/);
  assert.deepEqual(body, {
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found.',
      requestId,
    },
  });
});

test('worker adds requestId to routed JSON errors', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/.xd-pages/cli/login/start', { method: 'GET' }), {
    ...testJwtEnv(),
    createRequestId: () => 'req_test_routed',
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('X-Request-Id'), 'req_test_routed');
  assert.deepEqual(await response.json(), {
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed.',
      requestId: 'req_test_routed',
    },
  });
});

test('worker adds server-generated requestId to browser auth errors', async () => {
  const response = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code', {
      headers: {
        Accept: 'text/html',
        'X-Request-Id': 'attacker-request',
      },
    }),
    {
      ...testJwtEnv(),
      SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
      SSO_CLIENT_ID: 'xd_pages_test',
      SSO_CLIENT_SECRET: 'test-client-secret',
      SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
      createRequestId: () => 'req_test_html',
    }
  );

  const text = await response.text();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('X-Request-Id'), 'req_test_html');
  assert.match(text, /req_test_html/);
  assert.equal(text.includes('attacker-request'), false);
});

test('invalid PAGES_ENV fails closed', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'preview',
  });

  assert.equal(response.status, 500);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).error.code, 'AUTH_ENV_INVALID');
});

test('routes CLI login start and poll public endpoints', async () => {
  const env = {
    ...testJwtEnv(),
    now: () => 1_800_000_000,
    createCliLoginRecord: async () => ({
      loginId: 'cli_test',
      loginSecret: 'login-secret',
      deviceCode: '12345678',
      record: {
        id: 'cli_test',
        status: 'pending',
        environment: 'production',
        expiresAt: 1_800_000_600,
      },
    }),
    peekCliLoginRecord: async () => ({
      status: 'confirmed',
      userId: 'usr_123',
      environment: 'production',
      record: {
        id: 'cli_test',
        status: 'confirmed',
        userId: 'usr_123',
        environment: 'production',
      },
    }),
    consumeCliLoginRecord: async () => ({
      userId: 'usr_123',
      environment: 'production',
      record: {
        id: 'cli_test',
        status: 'consumed',
        userId: 'usr_123',
        environment: 'production',
        consumedAt: 1_800_000_001,
      },
    }),
    createCliAccessKey: async () => ({ plaintext: 'xdp_prod_ak_cli_test_secret', expiresAt: '2027-06-15T00:00:00.000Z' }),
  };

  const startResponse = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/cli/login/start', { method: 'POST' }),
    env
  );

  assert.equal(startResponse.status, 200);
  assert.equal(
    (await startResponse.json()).browserUrl,
    'https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_test'
  );

  const pollResponse = await worker.fetch(
    jsonRequest('https://auth.pages.xd.team/.xd-pages/cli/login/poll', {
      loginId: 'cli_test',
      loginSecret: 'login-secret',
    }),
    env
  );

  assert.equal(pollResponse.status, 200);
  assert.equal((await pollResponse.json()).status, 'confirmed');
});

test('rejects unsupported methods on CLI login endpoints', async () => {
  const response = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/cli/login/start', { method: 'GET' }),
    testJwtEnv()
  );
  const confirmResponse = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/cli/login/confirm', { method: 'GET' }),
    testJwtEnv()
  );

  assert.equal(response.status, 405);
  assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(confirmResponse.status, 405);
  assert.equal((await confirmResponse.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('routes OAuth authorize and callback public endpoints', async () => {
  const env = {
    ...testJwtEnv(),
    SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
    SSO_CLIENT_ID: 'xd_pages_test',
    now: () => 1_800_000_000,
    createOAuthStateRecord: async () => ({
      publicState: 'ost_test.state-secret',
      record: {
        id: 'ost_test',
        expiresAt: 1_800_000_300,
      },
    }),
    consumeOAuthStateRecord: async () => ({
      returnTo: 'https://demo.pages.xd.team/app',
      siteHost: 'demo.pages.xd.team',
      record: {
        id: 'ost_test',
        consumedAt: 1_800_000_000,
      },
    }),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({ id: 'usr_123', employeeStatus: 'active' }),
    syncSsoUserProfile: async () => ({}),
    createAuthSessionRecord: async () => ({}),
    createOAuthSiteCodeRecord: async () => ({ siteCode: 'ost_test.site-secret' }),
  };

  const authorizeResponse = await worker.fetch(
    new Request(
      'https://auth.pages.xd.team/.xd-pages/auth/authorize?site_host=demo.pages.xd.team&return_to=https://demo.pages.xd.team/app'
    ),
    env
  );

  assert.equal(authorizeResponse.status, 302);
  assert.equal(new URL(authorizeResponse.headers.get('Location')).origin, 'https://sso.example.test');

  const callbackResponse = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=ost_test.state-secret'),
    env
  );

  assert.equal(callbackResponse.status, 302);
  assert.equal(
    callbackResponse.headers.get('Location'),
    'https://demo.pages.xd.team/.xd-pages/auth/callback?code=ost_test.site-secret&' +
      'return_to=https%3A%2F%2Fdemo.pages.xd.team%2Fapp'
  );
  assert.match(callbackResponse.headers.get('Set-Cookie'), /^__Host-pages_auth_session=/);
});

test('OAuth logout clears auth session cookie and redirects to console login', async () => {
  const response = await worker.fetch(
    new Request(
      'https://auth.pages.xd.team/.xd-pages/auth/logout?return_to=https%3A%2F%2Fworkers.xd.team%2Flogin%3FloggedOut%3D1'
    ),
    testJwtEnv()
  );
  const unsafe = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/logout?return_to=https%3A%2F%2Fevil.example%2F'),
    testJwtEnv()
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://workers.xd.team/login?loggedOut=1');
  assert.match(response.headers.get('Set-Cookie'), /^__Host-pages_auth_session=;/);
  assert.equal(unsafe.status, 302);
  assert.equal(unsafe.headers.get('Location'), 'https://workers.xd.team/login?loggedOut=1');
});

test('OAuth logout revokes the durable auth session before clearing cookies', async () => {
  const now = 1_800_000_000;
  const revoked = [];
  const env = {
    ...testJwtEnv(),
    now: () => now,
    revokeAuthSession: async (sid) => revoked.push(sid),
  };
  const token = await signSessionJwt(
    {
      purpose: 'auth_session',
      audience: 'pages-auth',
      subject: 'usr_123',
      now,
      ttlSeconds: 600,
      claims: { sid: 'ses_logout_test' },
    },
    env
  );

  const response = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/logout', {
      headers: { Cookie: `__Host-pages_auth_session=${token}` },
    }),
    env
  );

  assert.equal(response.status, 302);
  assert.deepEqual(revoked, ['ses_logout_test']);
  assert.match(response.headers.get('Set-Cookie'), /^__Host-pages_auth_session=;/);
});

test('OAuth callback redirects console login code to console worker callback', async () => {
  const env = {
    ...testJwtEnv(),
    now: () => 1_800_000_000,
    consumeOAuthStateRecord: async () => ({
      kind: 'console',
      returnTo: '/workspace',
      environment: 'production',
      record: {
        id: 'ost_console',
        consumedAt: 1_800_000_000,
      },
    }),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({ id: 'usr_123', email: 'user@example.com', employeeStatus: 'active' }),
    syncSsoUserProfile: async () => ({ user: { userId: 'usr_123', email: 'user@example.com', employeeStatus: 'active' } }),
    createAuthSessionRecord: async () => ({}),
    createConsoleLoginCodeRecord: async (input) => {
      assert.equal(input.stateId, 'ost_console');
      assert.equal(input.user.userId, 'usr_123');
      assert.equal(input.user.email, 'user@example.com');
      return { consoleCode: 'ost_console.console-secret' };
    },
  };

  const callbackResponse = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=ost_console.state-secret'),
    env
  );

  assert.equal(callbackResponse.status, 302);
  assert.equal(
    callbackResponse.headers.get('Location'),
    'https://workers.xd.team/api/console/auth/callback?code=ost_console.console-secret'
  );
  assert.match(callbackResponse.headers.get('Set-Cookie'), /^__Host-pages_auth_session=/);
});

test('rejects unsupported methods on OAuth endpoints', async () => {
  const response = await worker.fetch(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/callback', { method: 'POST' }),
    testJwtEnv()
  );

  assert.equal(response.status, 405);
  assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('internal endpoint consumes site code for router service binding', async () => {
  const env = {
    ...testJwtEnv(),
    now: () => 1_800_000_000,
    consumeOAuthSiteCodeRecord: async (siteCode, options) => {
      assert.equal(siteCode, 'ost_test.site-secret');
      assert.deepEqual(options, {
        now: 1_800_000_000,
        siteHost: 'demo.pages.xd.team',
        environment: 'production',
      });
      return {
        returnTo: 'https://demo.pages.xd.team/private',
        user: {
          id: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          departments: ['dept_design'],
          sessionVersion: 2,
        },
      };
    },
  };

  const response = await worker.fetch(
    jsonRequest('https://pages-auth.internal/.xd-pages/internal/consume-site-code', {
      siteCode: 'ost_test.site-secret',
      siteHost: 'demo.pages.xd.team',
      now: 1_800_000_000,
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    returnTo: 'https://demo.pages.xd.team/private',
    user: {
      id: 'usr_1',
      email: 'user@example.com',
      employeeStatus: 'active',
      departments: ['dept_design'],
      sessionVersion: 2,
    },
  });
});

test('internal endpoint creates console login authorize URL', async () => {
  const response = await worker.fetch(
    jsonRequest('https://pages-auth.internal/.xd-pages/internal/console/login-code', {
      returnTo: '/workspace',
    }),
    {
      ...testJwtEnv(),
      SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
      SSO_CLIENT_ID: 'xd_pages_test',
    }
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.authorizeUrl, 'https://auth.pages.xd.team/.xd-pages/auth/authorize?console=1&return_to=%2Fworkspace');
});

test('internal console login rejects an unsafe return path', async () => {
  const bindings = {
    ...testJwtEnv(),
    SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
    SSO_CLIENT_ID: 'xd_pages_test',
  };
  const unsafeResponse = await worker.fetch(
    jsonRequest('https://pages-auth.internal/.xd-pages/internal/console/login-code', {
      returnTo: 'https://evil.example/workspace',
    }),
    bindings
  );

  assert.equal(unsafeResponse.status, 400);
});

test('internal endpoint exchanges console login code once', async () => {
  const env = {
    ...testJwtEnv(),
    now: () => 1_800_000_000,
    consumeConsoleLoginCodeRecord: async (code, options) => {
      assert.equal(code, 'ost_console.console-secret');
      assert.deepEqual(options, { now: 1_800_000_000, environment: 'production' });
      return {
        environment: 'production',
        returnTo: '/workspace',
        user: {
          userId: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          sessionVersion: 2,
        },
      };
    },
    isPlatformAdmin: async () => {
      throw new Error('console exchange must not query platform admins');
    },
  };

  const response = await worker.fetch(
    jsonRequest('https://pages-auth.internal/.xd-pages/internal/console/exchange', {
      code: 'ost_console.console-secret',
    }),
    env
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body, {
    userId: 'usr_1',
    email: 'user@example.com',
    employeeStatus: 'active',
    sessionVersion: 2,
    environment: 'production',
    returnTo: '/workspace',
  });
});

test('internal console exchange does not require session JWT signing config', async () => {
  const response = await worker.fetch(
    jsonRequest('https://pages-auth.internal/.xd-pages/internal/console/exchange', {
      code: 'ost_console.console-secret',
    }),
    {
      ...testJwtEnv(),
      PAGES_SESSION_JWT_KEYS: '',
      PAGES_SESSION_JWT_ACTIVE_KID: '',
      now: () => 1_800_000_000,
      consumeConsoleLoginCodeRecord: async () => ({
        environment: 'production',
        returnTo: '/workspace',
        user: {
          userId: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          sessionVersion: 2,
        },
      }),
      isPlatformAdmin: async () => {
        throw new Error('console exchange must not query platform admins');
      },
    }
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    userId: 'usr_1',
    email: 'user@example.com',
    employeeStatus: 'active',
    sessionVersion: 2,
    environment: 'production',
    returnTo: '/workspace',
  });
});

test('public auth host cannot call internal endpoints', async () => {
  const consumeResponse = await worker.fetch(
    jsonRequest('https://auth.pages.xd.team/.xd-pages/internal/consume-site-code', {
      siteCode: 'ost_test.site-secret',
      siteHost: 'demo.pages.xd.team',
    }),
    testJwtEnv()
  );
  const consoleLoginResponse = await worker.fetch(
    jsonRequest('https://auth.pages.xd.team/.xd-pages/internal/console/login-code', {
      returnTo: '/workspace',
    }),
    testJwtEnv()
  );
  const consoleExchangeResponse = await worker.fetch(
    jsonRequest('https://auth.pages.xd.team/.xd-pages/internal/console/exchange', {
      code: 'ost_console.console-secret',
    }),
    testJwtEnv()
  );

  assert.equal(consumeResponse.status, 404);
  assert.equal((await consumeResponse.json()).error.code, 'NOT_FOUND');
  assert.equal(consoleLoginResponse.status, 404);
  assert.equal((await consoleLoginResponse.json()).error.code, 'NOT_FOUND');
  assert.equal(consoleExchangeResponse.status, 404);
  assert.equal((await consoleExchangeResponse.json()).error.code, 'NOT_FOUND');
});

test('exports Durable Object shell classes', () => {
  assert.equal(typeof OAuthStateDO, 'function');
  assert.equal(typeof CliLoginDO, 'function');
  assert.equal(typeof AuthSessionDO, 'function');
});

test('OAuthStateDO stores, consumes, and rejects repeated consume without leaking secretHash', async () => {
  const durableObject = new OAuthStateDO(createDoState(), {});
  const createResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/create', {
      environment: 'production',
      siteHost: 'demo.pages.xd.team',
      returnTo: 'https://demo.pages.xd.team/app',
      now: 1_800_000_000,
      ttlSeconds: 300,
      stateId: 'ost_test',
      stateSecret: 'state-secret',
    })
  );

  assert.equal(createResponse.status, 200);
  assert.equal(createResponse.headers.get('Cache-Control'), 'no-store');
  const createText = await createResponse.text();
  assert.equal(createText.includes('secretHash'), false);
  assert.equal(JSON.parse(createText).publicState, 'ost_test.state-secret');

  const consumeResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/consume', {
      publicState: 'ost_test.state-secret',
      now: 1_800_000_001,
    })
  );

  assert.equal(consumeResponse.status, 200);
  const consumeText = await consumeResponse.text();
  assert.equal(consumeText.includes('secretHash'), false);
  assert.equal(JSON.parse(consumeText).record.consumedAt, 1_800_000_001);

  const siteCodeResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/create-site-code', {
      stateId: 'ost_test',
      user: { id: 'usr_123', email: 'user@example.com', employeeStatus: 'active', departments: [], sessionVersion: 1 },
      now: 1_800_000_002,
      ttlSeconds: 60,
      codeSecret: 'site-secret',
    })
  );

  assert.equal(siteCodeResponse.status, 200);
  const siteCodeText = await siteCodeResponse.text();
  assert.equal(siteCodeText.includes('secretHash'), false);
  assert.equal(JSON.parse(siteCodeText).siteCode, 'ost_test.site-secret');

  const consumeSiteCodeResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/consume-site-code', {
      siteCode: 'ost_test.site-secret',
      siteHost: 'demo.pages.xd.team',
      now: 1_800_000_003,
    })
  );

  assert.equal(consumeSiteCodeResponse.status, 200);
  assert.equal((await consumeSiteCodeResponse.json()).returnTo, 'https://demo.pages.xd.team/app');

  const repeatedResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/consume', {
      publicState: 'ost_test.state-secret',
      now: 1_800_000_004,
    })
  );

  assert.equal(repeatedResponse.status, 409);
  assert.equal((await repeatedResponse.json()).error.code, 'STATE_INVALID');
});

test('OAuthStateDO creates and consumes console login code without leaking secretHash', async () => {
  const durableObject = new OAuthStateDO(createDoState(), {});
  const createResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/create', {
      environment: 'production',
      consoleLogin: true,
      returnTo: '/workspace',
      now: 1_800_000_000,
      ttlSeconds: 300,
      stateId: 'ost_console',
      stateSecret: 'state-secret',
    })
  );

  assert.equal(createResponse.status, 200);
  assert.equal(JSON.parse(await createResponse.text()).publicState, 'ost_console.state-secret');

  const consumeResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/consume', {
      publicState: 'ost_console.state-secret',
      now: 1_800_000_001,
      environment: 'production',
    })
  );

  assert.equal(consumeResponse.status, 200);

  const createConsoleCodeResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/create-console-code', {
      stateId: 'ost_console',
      user: {
        userId: 'usr_1',
        email: 'user@example.com',
        employeeStatus: 'active',
        sessionVersion: 2,
      },
      now: 1_800_000_002,
      ttlSeconds: 60,
      codeSecret: 'console-secret',
    })
  );

  assert.equal(createConsoleCodeResponse.status, 200);
  const createText = await createConsoleCodeResponse.text();
  assert.equal(createText.includes('secretHash'), false);
  assert.equal(JSON.parse(createText).consoleCode, 'ost_console.console-secret');

  const exchangeResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/consume-console-code', {
      consoleCode: 'ost_console.console-secret',
      now: 1_800_000_003,
      environment: 'production',
    })
  );

  assert.equal(exchangeResponse.status, 200);
  assert.deepEqual(await exchangeResponse.json(), {
    ok: true,
    record: {
      id: 'ost_console',
      kind: 'console',
      environment: 'production',
      siteHost: null,
      returnTo: '/workspace',
      cliLoginId: null,
      deviceCode: null,
      recoveryAttempt: false,
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
      consumedAt: 1_800_000_001,
      consoleCode: {
        user: {
          userId: 'usr_1',
          email: 'user@example.com',
          employeeStatus: 'active',
          sessionVersion: 2,
        },
        issuedAt: 1_800_000_002,
        expiresAt: 1_800_000_062,
        consumedAt: 1_800_000_003,
      },
    },
    returnTo: '/workspace',
    environment: 'production',
    user: {
      userId: 'usr_1',
      email: 'user@example.com',
      employeeStatus: 'active',
      sessionVersion: 2,
    },
  });
});

test('CliLoginDO confirms and consumes login transactions without leaking secretHash', async () => {
  const durableObject = new CliLoginDO(createDoState(), {});
  const createResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/create', {
      environment: 'production',
      now: 1_800_000_000,
      ttlSeconds: 600,
      loginId: 'cli_test',
      loginSecret: 'login-secret',
      deviceCode: '12345678',
    })
  );

  assert.equal(createResponse.status, 200);
  const createText = await createResponse.text();
  assert.equal(createText.includes('secretHash'), false);
  assert.equal(JSON.parse(createText).record.status, 'pending');

  const pendingResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/poll', {
      loginId: 'cli_test',
      loginSecret: 'login-secret',
      now: 1_800_000_001,
    })
  );

  assert.equal(pendingResponse.status, 200);
  assert.deepEqual(await pendingResponse.json(), { status: 'pending', expiresAt: 1_800_000_600 });

  const authorizeReadResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/read-for-authorize', {
      loginId: 'cli_test',
      now: 1_800_000_001,
    })
  );

  assert.equal(authorizeReadResponse.status, 200);
  const authorizeReadText = await authorizeReadResponse.text();
  assert.equal(authorizeReadText.includes('secretHash'), false);
  assert.deepEqual(JSON.parse(authorizeReadText), {
    status: 'pending',
    environment: 'production',
    deviceCode: '12345678',
    expiresAt: 1_800_000_600,
  });

  const confirmResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/confirm', {
      deviceCode: '12345678',
      userId: 'usr_123',
      now: 1_800_000_002,
    })
  );

  assert.equal(confirmResponse.status, 200);
  assert.equal((await confirmResponse.json()).record.status, 'confirmed');

  const pollResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/poll', {
      loginId: 'cli_test',
      loginSecret: 'login-secret',
      now: 1_800_000_003,
    })
  );

  assert.equal(pollResponse.status, 200);
  const pollText = await pollResponse.text();
  assert.equal(pollText.includes('secretHash'), false);
  assert.equal(JSON.parse(pollText).userId, 'usr_123');
});

test('AuthSessionDO creates, refreshes, and revokes session records', async () => {
  const durableObject = new AuthSessionDO(createDoState(), {});
  const createResponse = await durableObject.fetch(
    jsonRequest('https://auth-session-do/create', {
      sid: 'sid_test',
      userId: 'usr_123',
      purpose: 'auth_session',
      now: 1_800_000_000,
      idleTtlSeconds: 120,
      absoluteTtlSeconds: 300,
    })
  );

  assert.equal(createResponse.status, 200);
  assert.equal((await createResponse.json()).expiresAt, 1_800_000_120);

  const refreshResponse = await durableObject.fetch(
    jsonRequest('https://auth-session-do/refresh', {
      sid: 'sid_test',
      now: 1_800_000_100,
      idleTtlSeconds: 120,
    })
  );

  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.equal(refreshed.expiresAt, 1_800_000_220);
  assert.equal(refreshed.authTime, 1_800_000_000);

  const revokeResponse = await durableObject.fetch(
    jsonRequest('https://auth-session-do/revoke', {
      sid: 'sid_test',
      now: 1_800_000_110,
    })
  );

  assert.equal(revokeResponse.status, 200);
  assert.equal((await revokeResponse.json()).revokedAt, 1_800_000_110);
});

test('Durable Object fetch returns safe no-store errors for unknown paths and invalid JSON', async () => {
  const durableObject = new OAuthStateDO(createDoState(), {});

  const unknownResponse = await durableObject.fetch(jsonRequest('https://oauth-state-do/missing', {}));

  assert.equal(unknownResponse.status, 404);
  assert.equal(unknownResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal((await unknownResponse.json()).error.code, 'NOT_FOUND');

  const invalidJsonResponse = await durableObject.fetch(
    new Request('https://oauth-state-do/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"state":',
    })
  );

  assert.equal(invalidJsonResponse.status, 400);
  assert.equal(invalidJsonResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal((await invalidJsonResponse.json()).error.code, 'INVALID_JSON');
});

function jsonRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createDoState() {
  return {
    storage: createFakeStorage(),
  };
}

function createFakeStorage() {
  const records = new Map();
  return {
    async get(key) {
      return clone(records.get(key));
    },
    async put(key, value) {
      records.set(key, clone(value));
    },
    async delete(key) {
      records.delete(key);
    },
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function testJwtEnv() {
  return {
    PAGES_ENV: 'production',
    PAGES_SESSION_JWT_ACTIVE_KID: 'test',
    PAGES_SESSION_JWT_KEYS: 'test:HS256:JWT_SECRET',
    JWT_SECRET: 'test-secret',
  };
}
