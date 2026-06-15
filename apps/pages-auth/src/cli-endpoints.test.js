import assert from 'node:assert/strict';
import test from 'node:test';

import { readAuthConfig } from './config.js';
import { buildAuthSessionCookie } from './cookies.js';
import { buildCliLoginBrowserUrl, handleCliLoginConfirm, handleCliLoginPoll, handleCliLoginStart } from './cli-endpoints.js';
import { signSessionJwt, verifySessionJwt } from './jwt.js';

const now = 1_800_000_000;

test('starts CLI login transaction with browser URL on current auth base', async () => {
  const env = testEnv({
    createCliLoginRecord: async (input) => {
      assert.equal(input.environment, 'production');
      assert.equal(input.ttlSeconds, 600);
      return {
        loginId: 'cli_test',
        loginSecret: 'login-secret',
        deviceCode: '12345678',
        record: {
          id: 'cli_test',
          status: 'pending',
          environment: 'production',
          expiresAt: now + 600,
        },
      };
    },
  });
  const response = await handleCliLoginStart(
    new Request('https://auth.pages.xd.team/.xd-pages/cli/login/start', { method: 'POST' }),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, {
    loginId: 'cli_test',
    loginSecret: 'login-secret',
    deviceCode: '12345678',
    browserUrl: 'https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_test',
    expiresAt: now + 600,
  });
  assert.equal(new URL(body.browserUrl).searchParams.has('device_code'), false);
  assert.equal(JSON.stringify(body).includes('secretHash'), false);
});

test('builds local CLI login browser URL from auth base instead of API host', () => {
  const config = readAuthConfig({
    PAGES_ENV: 'local',
    PUBLIC_AUTH_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
    PUBLIC_API_BASE: 'http://api.127.0.0.1.nip.io:8787',
    SSO_REDIRECT_URI: 'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback',
  });

  assert.equal(
    buildCliLoginBrowserUrl(config, 'cli_test'),
    'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/authorize?cli_login_id=cli_test'
  );
});

test('confirm requires auth_session and manually entered device code', async () => {
  let confirmedInput;
  const env = testEnv({
    confirmCliLoginRecord: async (input, options) => {
      confirmedInput = { input, options };
      return { record: { status: 'confirmed' } };
    },
  });
  const token = await signSessionJwt(
    {
      purpose: 'auth_session',
      audience: 'pages-auth',
      subject: 'usr_123',
      now,
      ttlSeconds: 600,
      claims: { sid: 'sid_test' },
    },
    env
  );
  const response = await handleCliLoginConfirm(
    new Request('https://auth.pages.xd.team/.xd-pages/cli/login/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: buildAuthSessionCookie(token, { maxAgeSeconds: 600 }).split(';', 1)[0],
      },
      body: JSON.stringify({ loginId: 'cli_test', deviceCode: '12345678' }),
    }),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(confirmedInput, {
    input: { loginId: 'cli_test', deviceCode: '12345678', userId: 'usr_123' },
    options: { now },
  });
});

test('confirm rejects requests without auth_session before touching CLI transaction', async () => {
  let confirmed = false;
  const env = testEnv({
    confirmCliLoginRecord: async () => {
      confirmed = true;
    },
  });
  const response = await handleCliLoginConfirm(
    new Request('https://auth.pages.xd.team/.xd-pages/cli/login/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: 'cli_test', deviceCode: '12345678' }),
    }),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'AUTH_SESSION_REQUIRED');
  assert.equal(confirmed, false);
});

test('poll returns pending before browser confirmation', async () => {
  const env = testEnv({
    peekCliLoginRecord: async () => ({ status: 'pending', expiresAt: now + 600 }),
  });
  const response = await handleCliLoginPoll(pollRequest('cli_test', 'login-secret'), env, readAuthConfig(env));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'pending' });
});

test('poll with wrong secret does not consume transaction', async () => {
  let consumed = false;
  const env = testEnv({
    peekCliLoginRecord: async ({ loginSecret }) => {
      if (loginSecret === 'wrong-secret') throw new Error('CLI login invalid: secret mismatch');
      return confirmedLogin();
    },
    consumeCliLoginRecord: async () => {
      consumed = true;
      return confirmedLogin();
    },
  });
  const config = readAuthConfig(env);
  const wrongResponse = await handleCliLoginPoll(pollRequest('cli_test', 'wrong-secret'), env, config);

  assert.equal(wrongResponse.status, 401);
  assert.equal((await wrongResponse.json()).error.code, 'CLI_LOGIN_INVALID');
  assert.equal(consumed, false);

  const okResponse = await handleCliLoginPoll(pollRequest('cli_test', 'login-secret'), env, config);

  assert.equal(okResponse.status, 200);
  assert.equal(consumed, true);
});

test('poll rejects non-object JSON bodies with safe error envelope', async () => {
  const env = testEnv();
  const response = await handleCliLoginPoll(
    new Request('https://auth.pages.xd.team/.xd-pages/cli/login/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    }),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).error.code, 'CLI_LOGIN_INVALID');
});

test('poll does not consume confirmed login when CLI token signing fails', async () => {
  let consumed = false;
  const env = {
    PAGES_ENV: 'production',
    now: () => now,
    peekCliLoginRecord: async () => ({
      status: 'confirmed',
      userId: 'usr_123',
      environment: 'production',
      record: { id: 'cli_test' },
    }),
    consumeCliLoginRecord: async () => {
      consumed = true;
      return confirmedLogin();
    },
  };
  const response = await handleCliLoginPoll(pollRequest('cli_test', 'login-secret'), env, readAuthConfig(env));

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'CLI_TOKEN_SIGN_FAILED');
  assert.equal(consumed, false);
});

test('poll after confirmation returns signed CLI token once', async () => {
  let consumed = false;
  const env = testEnv({
    peekCliLoginRecord: async () => {
      if (consumed) throw new Error('CLI login invalid: already consumed');
      return { status: 'confirmed', userId: 'usr_123', environment: 'production', record: { id: 'cli_test' } };
    },
    consumeCliLoginRecord: async () => {
      if (consumed) throw new Error('CLI login invalid: already consumed');
      consumed = true;
      return confirmedLogin();
    },
  });
  const config = readAuthConfig(env);
  const response = await handleCliLoginPoll(pollRequest('cli_test', 'login-secret'), env, config);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'confirmed');
  assert.equal(body.tokenType, 'Bearer');
  assert.equal(typeof body.cliToken, 'string');
  assert.equal(JSON.stringify(body).includes('secretHash'), false);

  const verified = await verifySessionJwt(body.cliToken, env, {
    purpose: 'cli_token',
    audience: 'pages-cli',
    now,
  });

  assert.equal(verified.sub, 'usr_123');
  assert.equal(verified.env, 'production');
  assert.equal(verified.jti, 'cli_test');

  const repeatedResponse = await handleCliLoginPoll(pollRequest('cli_test', 'login-secret'), env, config);

  assert.equal(repeatedResponse.status, 409);
  assert.equal((await repeatedResponse.json()).error.code, 'CLI_LOGIN_CONSUMED');
});

test('poll maps Durable Object consumed responses to CLI_LOGIN_CONSUMED', async () => {
  const env = testEnv({
    CLI_LOGINS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ error: { code: 'STATE_INVALID', message: 'State transition is invalid.' } }), {
            status: 409,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json',
            },
          }),
      }),
    },
  });
  const response = await handleCliLoginPoll(pollRequest('cli_test', 'login-secret'), env, readAuthConfig(env));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'CLI_LOGIN_CONSUMED');
});

function pollRequest(loginId, loginSecret) {
  return new Request('https://auth.pages.xd.team/.xd-pages/cli/login/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, loginSecret }),
  });
}

function confirmedLogin() {
  return {
    userId: 'usr_123',
    environment: 'production',
    record: {
      id: 'cli_test',
      status: 'consumed',
      userId: 'usr_123',
      environment: 'production',
      consumedAt: now + 1,
    },
  };
}

function testEnv(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_SESSION_JWT_ACTIVE_KID: 'test',
    PAGES_SESSION_JWT_KEYS: 'test:HS256:JWT_SECRET',
    JWT_SECRET: 'test-secret',
    now: () => now,
    ...overrides,
  };
}
