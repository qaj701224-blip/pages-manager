import assert from 'node:assert/strict';
import test from 'node:test';

import { readAuthConfig } from './config.js';
import { buildAuthSessionCookie } from './cookies.js';
import {
  consumeStoredOAuthSiteCode,
  consumeStoredOAuthState,
  createStoredOAuthSiteCode,
  createStoredOAuthState,
  createStoredSession,
} from './do-storage.js';
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

test('callback consumes state once, calls SSO hooks, sets auth_session cookie, and redirects to site callback', async () => {
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
    createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    syncSsoUserProfile: async (profile, options) => {
      assert.equal(profile.userId, 'usr_123');
      assert.equal(options.now, now);
      return { user: { userId: 'usr_123' } };
    },
    fetchSsoToken: async ({ code, redirectUri }) => {
      assert.equal(code, 'oauth-code');
      assert.equal(redirectUri, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
      return { accessToken: 'sso-access-token' };
    },
    fetchSsoProfile: async ({ accessToken }) => {
      assert.equal(accessToken, 'sso-access-token');
      return {
        id: 'usr_123',
        email: 'user@example.test',
        employeeStatus: 'active',
        departments: ['dept_design'],
        sessionVersion: 4,
      };
    },
  });
  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  const siteCallback = new URL(response.headers.get('Location'));
  assert.equal(siteCallback.origin + siteCallback.pathname, 'https://demo.pages.xd.team/.xd-pages/auth/callback');
  assert.equal(siteCallback.searchParams.has('state'), false);
  assert.equal(siteCallback.searchParams.has('access_token'), false);
  const siteCode = siteCallback.searchParams.get('code');
  assert.match(siteCode, /^ost_test\./);
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
  const consumedSiteCode = await consumeStoredOAuthSiteCode(oauthStorage, siteCode, {
    now: now + 1,
    siteHost: 'demo.pages.xd.team',
  });
  assert.equal(consumedSiteCode.returnTo, 'https://demo.pages.xd.team/app');
  assert.deepEqual(consumedSiteCode.user, {
    id: 'usr_123',
    email: 'user@example.test',
    employeeStatus: 'active',
    departments: [],
    sessionVersion: 4,
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

test('callback exchanges code with configured SSO HTTP endpoints and canonicalizes company profile', async () => {
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
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = new URL(url);
    requests.push({ url: requestUrl, init });
    if (requestUrl.origin + requestUrl.pathname === 'https://sso.example.test/oauth/accessToken') {
      assert.equal(init.method, 'GET');
      assert.equal(requestUrl.searchParams.get('code'), 'oauth-code');
      assert.equal(requestUrl.searchParams.get('client_id'), 'xd_pages_test');
      assert.equal(requestUrl.searchParams.get('client_secret'), 'test-client-secret');
      assert.equal(requestUrl.searchParams.get('grant_type'), 'authorization_code');
      assert.equal(requestUrl.searchParams.get('redirect_uri'), 'https://auth.pages.xd.team/.xd-pages/auth/callback');
      return Response.json({ access_token: 'sso-access-token' });
    }
    if (requestUrl.origin + requestUrl.pathname === 'https://sso.example.test/oauth/profile') {
      assert.equal(init.method, 'GET');
      assert.equal(requestUrl.searchParams.get('access_token'), 'sso-access-token');
      assert.equal(init.headers.Authorization, undefined);
      return Response.json({
        account: 'demo.user@example.test',
        accountId: 'acct_demo_001',
        ad_account: 'demo.user',
        authWay: '13',
        email: 'USER@example.test',
        employee_status: '1',
        employeenum: 'demo.user',
        fs_email: 'USER@example.test',
        fs_id: 'fs_demo_001',
        isPublicAccount: false,
        job_number: '1001',
        loginTime: 1_781_595_126_585,
        permissions: [],
        realname: '示例用户',
        roles: [],
        sort: '0',
        st: 'ST-demo-redacted',
        tgtId: 'TGT-demo-redacted',
        userId: 'usr_xindong_123',
        wechat_work: 'ww_demo_001',
        service: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
        id: 'demo.user@example.test',
        client_id: 'xd_pages_test',
      });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    let syncedProfile;
    const env = testEnv({
      SSO_TOKEN_URL: 'https://sso.example.test/oauth/accessToken',
      SSO_PROFILE_URL: 'https://sso.example.test/oauth/profile',
      SSO_CLIENT_SECRET: 'test-client-secret',
      consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
      createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
      createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
      syncSsoUserProfile: async (profile) => {
        syncedProfile = profile;
        return { user: { userId: profile.userId } };
      },
    });
    const response = await handleOAuthCallback(
      new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
      env,
      readAuthConfig(env)
    );

    assert.equal(response.status, 302, await response.clone().text());

    const siteCode = new URL(response.headers.get('Location')).searchParams.get('code');
    const consumedSiteCode = await consumeStoredOAuthSiteCode(oauthStorage, siteCode, {
      now: now + 1,
      siteHost: 'demo.pages.xd.team',
      environment: 'production',
    });
    assert.deepEqual(consumedSiteCode.user, {
      id: 'usr_xindong_123',
      email: 'user@example.test',
      employeeStatus: 'active',
      departments: [],
      sessionVersion: 1,
    });
    assert.deepEqual(syncedProfile, {
      userId: 'usr_xindong_123',
      email: 'user@example.test',
      realname: '示例用户',
      account: 'demo.user@example.test',
      accountId: 'acct_demo_001',
      employeenum: 'demo.user',
      employeeStatus: 'active',
      departments: [],
      sessionVersion: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callback syncs SSO profile through shared metadata store without pages-api binding', async () => {
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
  let syncedUser;
  const env = testEnv({
    syncSsoUserProfile: undefined,
    PAGES_STORE: {
      async upsertUserFromSso(user) {
        syncedUser = user;
        return {
          id: user.userId,
          email: user.email,
          employeeStatus: user.employeeStatus,
          sessionVersion: user.sessionVersion,
          lastLoginAt: user.lastLoginAt,
        };
      },
    },
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_xindong_123',
      email: 'User@Example.Test',
      employee_status: '1',
      realname: '示例用户',
      account: 'demo.user@example.test',
      accountId: 'acct_demo_001',
      employeenum: 'demo.user',
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(syncedUser.userId, 'usr_xindong_123');
  assert.equal(syncedUser.email, 'user@example.test');
  assert.equal(syncedUser.realname, '示例用户');
  assert.equal(syncedUser.account, 'demo.user@example.test');
  assert.equal(syncedUser.accountId, 'acct_demo_001');
  assert.equal(syncedUser.employeenum, 'demo.user');
  assert.equal(syncedUser.employeeStatus, 'active');
  assert.equal(syncedUser.lastLoginAt, '2027-01-15T08:00:00.000Z');
});

test('callback refuses stale active SSO profiles when the authority store keeps the user disabled', async () => {
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
  let sessionCreated = false;
  const env = testEnv({
    syncSsoUserProfile: undefined,
    PAGES_STORE: {
      async upsertUserFromSso(user) {
        return {
          id: user.userId,
          email: user.email,
          employeeStatus: 'disabled',
          sessionVersion: 7,
          lastLoginAt: user.lastLoginAt,
        };
      },
    },
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
    createAuthSessionRecord: async (input) => {
      sessionCreated = true;
      return createStoredSession(sessionStorage, input);
    },
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_xindong_123',
      email: 'user@example.test',
      employee_status: '1',
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SSO_PROFILE_INACTIVE');
  assert.equal(sessionCreated, false);
});

test('callback rejects profiles without explicit active employee status', async () => {
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
  let sessionCreated = false;
  let syncedProfile;
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({ id: 'usr_123', email: 'user@example.test' }),
    syncSsoUserProfile: async (profile) => {
      syncedProfile = profile;
      return { user: { userId: profile.userId } };
    },
    createAuthSessionRecord: async () => {
      sessionCreated = true;
    },
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SSO_PROFILE_INACTIVE');
  assert.deepEqual(syncedProfile, {
    userId: 'usr_123',
    email: 'user@example.test',
    realname: null,
    account: null,
    accountId: null,
    employeenum: null,
    employeeStatus: 'unknown',
    departments: [],
    sessionVersion: 1,
  });
  assert.equal(sessionCreated, false);
});

test('CLI OAuth callback shows manual device confirmation and does not create a site code', async () => {
  const oauthStorage = createFakeStorage();
  const sessionStorage = createFakeStorage();
  const created = await createStoredOAuthState(oauthStorage, {
    environment: 'production',
    cliLoginId: 'cli_test',
    now,
    ttlSeconds: 300,
    stateId: 'ost_test',
    stateSecret: 'state-secret',
  });
  let siteCodeCreated = false;
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({ userId: 'usr_123', employee_status: '1' }),
    createOAuthSiteCodeRecord: async () => {
      siteCodeCreated = true;
    },
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const text = await response.text();
  assert.match(text, /Confirm Pages CLI Login/);
  assert.match(text, /production/);
  assert.match(text, /https:\/\/auth\.pages\.xd\.team/);
  assert.match(text, /cli_token/);
  assert.match(text, /name="loginId" value="cli_test"/);
  assert.match(text, /name="confirmToken" value="[^"]+"/);
  assert.match(text, /name="deviceCode"/);
  const confirmToken = text.match(/name="confirmToken" value="([^"]+)"/)[1];
  const authToken = response.headers.get('Set-Cookie').split(';', 1)[0].split('=', 2)[1];
  const authPayload = await verifySessionJwt(authToken, env, {
    purpose: 'auth_session',
    audience: 'pages-auth',
    now,
  });
  const confirmPayload = await verifySessionJwt(confirmToken, env, {
    purpose: 'cli_login_confirm',
    audience: 'pages-cli-login-confirm',
    now,
  });
  assert.equal(confirmPayload.sub, 'usr_123');
  assert.equal(confirmPayload.loginId, 'cli_test');
  assert.equal(confirmPayload.sid, authPayload.sid);
  assert.equal(siteCodeCreated, false);
  assert.match(response.headers.get('Set-Cookie'), /^__Host-pages_auth_session=/);
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
    syncSsoUserProfile: async () => ({}),
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
