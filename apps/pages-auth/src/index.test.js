import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { AuthSessionDO, CliLoginDO, OAuthStateDO } from './index.js';
import { signSessionJwt } from './jwt.js';

test('health endpoint returns non-sensitive environment status without cache', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
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

test('public auth host cannot call internal endpoints', async () => {
  const consumeResponse = await worker.fetch(
    jsonRequest('https://auth.pages.xd.team/.xd-pages/internal/consume-site-code', {
      siteCode: 'ost_test.site-secret',
      siteHost: 'demo.pages.xd.team',
    }),
    testJwtEnv()
  );
  const verifyResponse = await worker.fetch(
    jsonRequest('https://auth.pages.xd.team/.xd-pages/internal/verify-cli-token', {
      token: 'cli-token',
    }),
    testJwtEnv()
  );

  assert.equal(consumeResponse.status, 404);
  assert.equal((await consumeResponse.json()).error.code, 'NOT_FOUND');
  assert.equal(verifyResponse.status, 404);
  assert.equal((await verifyResponse.json()).error.code, 'NOT_FOUND');
});

test('internal endpoint verifies CLI token for API service binding', async () => {
  const env = { ...testJwtEnv(), now: () => 1_800_000_000 };
  const token = await signSessionJwt(
    {
      purpose: 'cli_token',
      audience: 'pages-cli',
      subject: 'usr_123',
      now: 1_800_000_000,
      ttlSeconds: 600,
      claims: { jti: 'cli_123' },
    },
    env
  );

  const response = await worker.fetch(
    jsonRequest('https://pages-auth.internal/.xd-pages/internal/verify-cli-token', {
      token,
      audience: 'pages-cli',
    }),
    env
  );

  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.sub, 'usr_123');
  assert.equal(payload.purpose, 'cli_token');
  assert.equal(payload.aud, 'pages-cli');
  assert.equal(payload.env, 'production');
  assert.equal(payload.jti, 'cli_123');
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
  assert.equal((await refreshResponse.json()).expiresAt, 1_800_000_220);

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
