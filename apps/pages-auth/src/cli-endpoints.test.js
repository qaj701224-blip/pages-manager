import assert from 'node:assert/strict';
import test from 'node:test';

import { readAuthConfig } from './config.js';
import { buildCliLoginBrowserUrl, handleCliLoginPoll, handleCliLoginStart } from './cli-endpoints.js';
import { verifySessionJwt } from './jwt.js';

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

test('poll returns pending before browser confirmation', async () => {
  const env = testEnv({
    consumeCliLoginRecord: async () => {
      throw new Error('CLI login invalid: still pending');
    },
  });
  const response = await handleCliLoginPoll(pollRequest('cli_test', 'login-secret'), env, readAuthConfig(env));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'pending' });
});

test('poll with wrong secret does not consume transaction', async () => {
  let consumed = false;
  const env = testEnv({
    consumeCliLoginRecord: async ({ loginSecret }) => {
      if (loginSecret === 'wrong-secret') throw new Error('CLI login invalid: secret mismatch');
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

test('poll after confirmation returns signed CLI token once', async () => {
  let calls = 0;
  const env = testEnv({
    consumeCliLoginRecord: async () => {
      calls += 1;
      if (calls > 1) throw new Error('CLI login invalid: already consumed');
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
