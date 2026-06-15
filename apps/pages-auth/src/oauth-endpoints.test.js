import assert from 'node:assert/strict';
import test from 'node:test';

import { readAuthConfig } from './config.js';
import { buildAuthSessionCookie } from './cookies.js';
import { consumeStoredOAuthState, createStoredOAuthState, createStoredSession } from './do-storage.js';
import { handleOAuthAuthorize, handleOAuthCallback } from './oauth-endpoints.js';
import { verifySessionJwt } from './jwt.js';

const now = 1_800_000_000;

test('authorize redirects to SSO with client id, redirect uri, response type, and opaque state', async () => {
  let createdInput;
  const env = testEnv({
    createOAuthStateRecord: async (input) => {
      createdInput = input;
      return {
        publicState: 'ost_test.state-secret',
        record: {
          id: 'ost_test',
          siteHost: input.siteHost,
          returnTo: input.returnTo,
          expiresAt: input.now + input.ttlSeconds,
        },
      };
    },
  });
  const response = await handleOAuthAuthorize(
    new Request(
      'https://auth.pages.xd.team/.xd-pages/auth/authorize?site_host=demo.pages.xd.team&return_to=https://demo.pages.xd.team/'
    ),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(createdInput, {
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: createdInput.stateId,
    stateSecret: createdInput.stateSecret,
  });

  const location = new URL(response.headers.get('Location'));
  assert.equal(location.origin + location.pathname, 'https://sso.example.test/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'xd_pages_test');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://auth.pages.xd.team/.xd-pages/auth/callback');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('state'), 'ost_test.state-secret');
  assert.equal(location.searchParams.has('client_secret'), false);
  assert.equal(response.headers.get('Location').includes('demo.pages.xd.team'), false);
});

test('authorize rejects open redirect return_to before SSO redirect', async () => {
  const storage = createFakeStorage();
  const env = testEnv({
    createOAuthStateRecord: (input) => createStoredOAuthState(storage, input),
  });
  const response = await handleOAuthAuthorize(
    new Request(
      'https://auth.pages.xd.team/.xd-pages/auth/authorize?site_host=demo.pages.xd.team&return_to=https://evil.example.test/'
    ),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Location'), null);
  assert.equal((await response.json()).error.code, 'OAUTH_AUTHORIZE_INVALID');
});

test('authorize returns provider-unconfigured before creating state when SSO config is missing', async () => {
  let createCalled = false;
  const env = testEnv({
    SSO_AUTHORIZATION_URL: undefined,
    createOAuthStateRecord: async () => {
      createCalled = true;
    },
  });
  const response = await handleOAuthAuthorize(
    new Request(
      'https://auth.pages.xd.team/.xd-pages/auth/authorize?site_host=demo.pages.xd.team&return_to=https://demo.pages.xd.team/'
    ),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'SSO_PROVIDER_UNCONFIGURED');
  assert.equal(createCalled, false);
});

test('callback without code or state returns safe error without echoing OAuth values', async () => {
  const env = testEnv();
  const response = await handleOAuthCallback(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code'),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes('oauth-code'), false);
  assert.equal(JSON.parse(text).error.code, 'OAUTH_CALLBACK_INVALID');
});

test('callback consumes state once, calls SSO hooks, sets auth_session cookie, and redirects', async () => {
  const oauthStorage = createFakeStorage();
  const sessionStorage = createFakeStorage();
  const created = await createStoredOAuthState(oauthStorage, {
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/app',
    now,
    ttlSeconds: 300,
    stateId: 'ost_test',
    stateSecret: 'state-secret',
  });
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    fetchSsoToken: async ({ code, redirectUri }) => {
      assert.equal(code, 'oauth-code');
      assert.equal(redirectUri, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
      return { accessToken: 'sso-access-token' };
    },
    fetchSsoProfile: async ({ accessToken }) => {
      assert.equal(accessToken, 'sso-access-token');
      return { id: 'usr_123', email: 'user@example.test' };
    },
  });
  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(response.headers.get('Location'), 'https://demo.pages.xd.team/app');
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-pages_auth_session=/);
  assert.equal(cookie, buildAuthSessionCookie(cookie.split(';', 1)[0].split('=', 2)[1], { maxAgeSeconds: 1_209_600 }));

  const token = cookie.split(';', 1)[0].split('=', 2)[1];
  const verified = await verifySessionJwt(token, env, {
    purpose: 'auth_session',
    audience: 'pages-auth',
    now,
  });
  assert.equal(verified.sub, 'usr_123');
  assert.equal(typeof verified.sid, 'string');
  assert.deepEqual(await sessionStorage.get(`session:${verified.sid}`), {
    sid: verified.sid,
    userId: 'usr_123',
    purpose: 'auth_session',
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: now + 1_209_600,
    absoluteExpiresAt: now + 2_592_000,
    revokedAt: null,
    authTime: now,
  });

  const repeatedResponse = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(repeatedResponse.status, 409);
  const repeatedText = await repeatedResponse.text();
  assert.equal(repeatedText.includes('oauth-code'), false);
  assert.equal(repeatedText.includes('state-secret'), false);
  assert.equal(JSON.parse(repeatedText).error.code, 'OAUTH_STATE_INVALID');
});

test('callback returns provider-unconfigured error when SSO hooks are absent', async () => {
  const oauthStorage = createFakeStorage();
  const created = await createStoredOAuthState(oauthStorage, {
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/app',
    now,
    ttlSeconds: 300,
    stateId: 'ost_test',
    stateSecret: 'state-secret',
  });
  const env = testEnv({
    fetchSsoToken: undefined,
    fetchSsoProfile: undefined,
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
  });
  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'SSO_PROVIDER_UNCONFIGURED');
});

function testEnv(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
    SSO_CLIENT_ID: 'xd_pages_test',
    PAGES_SESSION_JWT_ACTIVE_KID: 'test',
    PAGES_SESSION_JWT_KEYS: 'test:HS256:JWT_SECRET',
    JWT_SECRET: 'test-secret',
    now: () => now,
    ...overrides,
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
