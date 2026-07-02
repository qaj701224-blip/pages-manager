import assert from 'node:assert/strict';
import test from 'node:test';

import { readAuthConfig } from './config.js';
import { buildAuthSessionCookie } from './cookies.js';
import {
  consumeStoredOAuthSiteCode,
  consumeStoredOAuthState,
  consumeStoredConsoleLoginCode,
  createStoredOAuthSiteCode,
  createStoredOAuthState,
  createStoredConsoleLoginCode,
  createStoredSession,
} from './do-storage.js';
import { handleOAuthAuthorize, handleOAuthCallback } from './oauth-endpoints.js';
import { signSessionJwt, verifySessionJwt } from './jwt.js';
import { createTestPagesStore } from '../../pages-api/src/test-store.js';

const now = 1_800_000_000;
const coolToneFragments = [
  '#12b3a8',
  '#2563eb',
  '#f5f7fb',
  '#101828',
  '#5b677a',
  '#dfe7f2',
  '#c8d4e4',
  '#334155',
  '#475569',
  '#0f172a',
  '#718096',
  '#263244',
  '15, 23, 42',
  '37, 99, 235',
  '200, 212, 228',
  'var(--blue)',
];

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

test('authorize for CLI login stores the server-side device code in OAuth state', async () => {
  let createdInput;
  const env = testEnv({
    readCliLoginRecordForAuthorize: async ({ loginId }, options) => {
      assert.equal(loginId, 'cli_test');
      assert.equal(options.now, now);
      return {
        status: 'pending',
        environment: 'production',
        deviceCode: '12345678',
        expiresAt: now + 600,
      };
    },
    createOAuthStateRecord: async (input) => {
      createdInput = input;
      return {
        publicState: 'ost_test.state-secret',
        record: {
          id: 'ost_test',
          kind: 'cli',
          cliLoginId: input.cliLoginId,
          deviceCode: input.deviceCode,
          expiresAt: input.now + input.ttlSeconds,
        },
      };
    },
  });

  const response = await handleOAuthAuthorize(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_test'),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.deepEqual(createdInput, {
    environment: 'production',
    cliLoginId: 'cli_test',
    deviceCode: '12345678',
    now,
    ttlSeconds: 300,
    stateId: createdInput.stateId,
    stateSecret: createdInput.stateSecret,
  });
  const location = response.headers.get('Location');
  assert.equal(location.includes('cli_test'), false);
  assert.equal(location.includes('12345678'), false);
});

test('authorize with an existing auth session creates a site code without redirecting to SSO', async () => {
  const oauthStorage = createFakeStorage();
  let requestedUserId;
  let createdSiteCodeInput;
  const env = testEnv({
    createOAuthStateRecord: (input) => createStoredOAuthState(oauthStorage, input),
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => {
      createdSiteCodeInput = input;
      return createStoredOAuthSiteCode(oauthStorage, input);
    },
    getUserForAuthSession: async (userId) => {
      requestedUserId = userId;
      return {
        id: userId,
        email: 'user@example.test',
        employeeStatus: 'active',
        departmentPath: 'XD/Platform/Web',
        sessionVersion: 7,
      };
    },
  });
  const authToken = await signSessionJwt(
    {
      purpose: 'auth_session',
      audience: 'pages-auth',
      subject: 'usr_123',
      now,
      ttlSeconds: 600,
      claims: { sid: 'sid_auth' },
    },
    env
  );

  const response = await handleOAuthAuthorize(
    new Request(
      'https://auth.pages.xd.team/.xd-pages/auth/authorize?' +
        'site_host=demo.pages.xd.team&return_to=https://demo.pages.xd.team/private',
      {
        headers: {
          Cookie: buildAuthSessionCookie(authToken, { maxAgeSeconds: 600 }),
          Accept: 'text/html',
        },
      }
    ),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(requestedUserId, 'usr_123');
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.origin + location.pathname, 'https://demo.pages.xd.team/.xd-pages/auth/callback');
  assert.match(location.searchParams.get('code'), /^ost_/);
  assert.equal(location.searchParams.get('return_to'), 'https://demo.pages.xd.team/private');
  assert.equal(location.origin, 'https://demo.pages.xd.team');
  assert.deepEqual(createdSiteCodeInput.user.departments, ['XD/Platform/Web']);
});

test('authorize with an existing auth session creates a console code without redirecting to SSO', async () => {
  const oauthStorage = createFakeStorage();
  let requestedUserId;
  const env = testEnv({
    createOAuthStateRecord: (input) => createStoredOAuthState(oauthStorage, input),
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createConsoleLoginCodeRecord: (input) => createStoredConsoleLoginCode(oauthStorage, input),
    createOAuthSiteCodeRecord: async () => {
      throw new Error('site code should not be created for console login');
    },
    getUserForAuthSession: async (userId) => {
      requestedUserId = userId;
      return {
        id: userId,
        email: 'admin@example.test',
        employeeStatus: 'active',
        sessionVersion: 9,
      };
    },
  });
  const authToken = await signSessionJwt(
    {
      purpose: 'auth_session',
      audience: 'pages-auth',
      subject: 'usr_admin',
      now,
      ttlSeconds: 600,
      claims: { sid: 'sid_console' },
    },
    env
  );

  const response = await handleOAuthAuthorize(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/authorize?console=1&return_to=/admin/dashboard', {
      headers: {
        Cookie: buildAuthSessionCookie(authToken, { maxAgeSeconds: 600 }),
        Accept: 'text/html',
      },
    }),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(requestedUserId, 'usr_admin');
  const location = new URL(response.headers.get('Location'));
  assert.equal(location.origin + location.pathname, 'https://workers.xd.team/api/console/auth/callback');
  const consoleCode = location.searchParams.get('code');
  assert.match(consoleCode, /^ost_/);
  assert.equal(location.searchParams.has('state'), false);
  const consumed = await consumeStoredConsoleLoginCode(oauthStorage, consoleCode, {
    now: now + 1,
    environment: 'production',
  });
  assert.equal(consumed.returnTo, '/admin/dashboard');
  assert.deepEqual(consumed.user, {
    userId: 'usr_admin',
    email: 'admin@example.test',
    employeeStatus: 'active',
    sessionVersion: 9,
  });
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

test('callback errors render a friendly browser page for navigations', async () => {
  const env = testEnv();
  const response = await handleOAuthCallback(
    new Request('https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code', {
      headers: { Accept: 'text/html' },
    }),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  const text = await response.text();
  assert.match(text, /XD Cell/);
  assert.match(text, /登录没有完成/);
  assert.match(text, /这次登录链接可能已经过期或已经使用过/);
  assert.match(text, /重新打开站点或重新执行登录操作即可再次验证/);
  assert.match(text, /状态：需要重新验证/);
  assert.doesNotMatch(text, /身份验证没有完成/);
  assertNoCoolToneFragments(text);
  assert.equal(text.includes('oauth-code'), false);
});

test('callback browser errors link back to configured auth base', async () => {
  const env = testEnv();
  const response = await handleOAuthCallback(
    new Request('https://unexpected.example.test/.xd-pages/auth/callback?code=oauth-code', {
      headers: { Accept: 'text/html' },
    }),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 400);
  const text = await response.text();
  assert.match(text, /href="https:\/\/auth\.pages\.xd\.team\/\.xd-pages\/auth\/authorize"/);
  assert.equal(text.includes('unexpected.example.test/.xd-pages/auth/authorize'), false);
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
    departments: ['dept_design'],
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
  assert.deepEqual(JSON.parse(repeatedText).error, {
    code: 'OAUTH_STATE_INVALID',
    message: 'OAuth state is invalid.',
    reason: 'oauth_state_invalid_or_expired',
    step: 'oauth.state',
  });
});

test('callback does not call pages-api service binding after SSO user sync', async () => {
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
  let pagesApiCalled = false;
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    syncSsoUserProfile: async (profile) => ({
      user: {
        userId: profile.userId,
        email: profile.email,
        employeeStatus: profile.employeeStatus,
        sessionVersion: profile.sessionVersion,
      },
    }),
    PAGES_API: {
      fetch: async () => {
        pagesApiCalled = true;
        return Response.json({ hydration: { status: 'hydrated' } });
      },
    },
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_123',
      email: 'User@XD.com',
      employeeStatus: 'active',
      sessionVersion: 4,
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(pagesApiCalled, false);
});

test('callback ignores department hydration hook failures after SSO user sync', async () => {
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
  let hydrationCalled = false;
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    syncSsoUserProfile: async (profile) => ({
      user: {
        userId: profile.userId,
        email: profile.email,
        employeeStatus: profile.employeeStatus,
      },
    }),
    hydrateDepartmentAfterSso: async () => {
      hydrationCalled = true;
      throw new Error('xds unavailable');
    },
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_123',
      email: 'user@xd.com',
      employeeStatus: 'active',
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(hydrationCalled, true);
});

test('callback propagates hydrated department path into site login code payload', async () => {
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
  let createdSiteCodeInput;
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => {
      createdSiteCodeInput = input;
      return createStoredOAuthSiteCode(oauthStorage, input);
    },
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    syncSsoUserProfile: async (profile) => ({
      user: {
        userId: profile.userId,
        email: profile.email,
        employeeStatus: profile.employeeStatus,
      },
    }),
    hydrateDepartmentAfterSso: async () => ({ departmentPath: 'XD/Platform/Web' }),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_123',
      email: 'user@xd.com',
      employeeStatus: 'active',
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.deepEqual(createdSiteCodeInput.user.departments, ['XD/Platform/Web']);
});

test('callback hydrates department through XDS VPC fetch without pages-api service binding', async () => {
  const oauthStorage = createFakeStorage();
  const sessionStorage = createFakeStorage();
  const store = createTestPagesStore({ now: () => '2027-01-15T08:00:00.000Z' });
  const created = await createStoredOAuthState(oauthStorage, {
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/app',
    now,
    ttlSeconds: 300,
    stateId: 'ost_test',
    stateSecret: 'state-secret',
  });
  let createdSiteCodeInput;
  let vpcFetchCalled = false;
  let pagesApiCalled = false;
  const env = testEnv({
    PAGES_STORE: store,
    XDS_OPENAI_TOKEN: 'secret-token',
    XD_OFFICE_NET: {
      fetch: async (url, init = {}) => {
        vpcFetchCalled = true;
        assert.equal(url, 'https://xds.xindong.com/xds-open-api/v1/oa-user/list-by-email');
        assert.equal(init.method, 'POST');
        return Response.json({
          code: 0,
          data: [{ email: 'user@xd.com', departmentPath: '心动/平台支撑部/Web' }],
        });
      },
    },
    PAGES_API: {
      fetch: async () => {
        pagesApiCalled = true;
        return Response.json({ error: { code: 'UNEXPECTED_PAGES_API_CALL' } }, { status: 500 });
      },
    },
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => {
      createdSiteCodeInput = input;
      return createStoredOAuthSiteCode(oauthStorage, input);
    },
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    syncSsoUserProfile: async (profile) => ({
      user: await store.upsertUserFromSso({
        userId: profile.userId,
        email: profile.email,
        employeeStatus: profile.employeeStatus,
        departments: profile.departments,
        sessionVersion: profile.sessionVersion,
      }),
    }),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_123',
      email: 'user@xd.com',
      employeeStatus: 'active',
      sessionVersion: 4,
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(vpcFetchCalled, true);
  assert.equal(pagesApiCalled, false);
  assert.deepEqual(createdSiteCodeInput.user.departments, ['心动/平台支撑部/Web']);
  assert.equal((await store.getUser('usr_123')).departmentPath, '心动/平台支撑部/Web');
  assert.deepEqual(
    (await store.listTeamsForUser({ environment: 'production', userId: 'usr_123' })).map((team) => [
      team.departmentPath,
      team.currentUserRole,
    ]),
    [['心动/平台支撑部/Web', 'admin']]
  );
});

test('callback continues when no department hydration hook is configured', async () => {
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
    syncSsoUserProfile: async (profile) => ({
      user: {
        userId: profile.userId,
        email: profile.email,
        employeeStatus: profile.employeeStatus,
      },
    }),
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_123',
      email: 'user@xd.com',
      employeeStatus: 'active',
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
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

test('callback SSO HTTP endpoint failures return public diagnostics without provider URL data', async () => {
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('provider unavailable', { status: 503 });

  try {
    const env = testEnv({
      SSO_TOKEN_URL: 'https://sso.example.test/oauth/accessToken',
      SSO_PROFILE_URL: 'https://sso.example.test/oauth/profile',
      SSO_CLIENT_SECRET: 'test-client-secret',
      consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    });
    const response = await handleOAuthCallback(
      new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
      env,
      readAuthConfig(env)
    );

    assert.equal(response.status, 502);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text).error, {
      code: 'SSO_EXCHANGE_FAILED',
      message: 'SSO exchange failed.',
      reason: 'sso_token_unavailable',
      step: 'sso.token',
      details: {
        providerEndpointType: 'sso_token',
      },
    });
    assert.equal(text.includes('oauth-code'), false);
    assert.equal(text.includes('state-secret'), false);
    assert.equal(text.includes('test-client-secret'), false);
    assert.equal(text.includes('sso.example.test'), false);
    assert.equal(text.includes('provider unavailable'), false);
    assert.equal(text.includes('internalReason'), false);
    assert.equal(text.includes('internalStep'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callback SSO profile failures return profile diagnostics without provider URL data', async () => {
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.origin + requestUrl.pathname === 'https://sso.example.test/oauth/accessToken') {
      return Response.json({ access_token: 'sso-access-token' });
    }
    return new Response('profile unavailable', { status: 503 });
  };

  try {
    const env = testEnv({
      SSO_TOKEN_URL: 'https://sso.example.test/oauth/accessToken',
      SSO_PROFILE_URL: 'https://sso.example.test/oauth/profile',
      SSO_CLIENT_SECRET: 'test-client-secret',
      consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    });
    const response = await handleOAuthCallback(
      new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
      env,
      readAuthConfig(env)
    );

    assert.equal(response.status, 502);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text).error, {
      code: 'SSO_EXCHANGE_FAILED',
      message: 'SSO exchange failed.',
      reason: 'sso_profile_unavailable',
      step: 'sso.profile',
      details: {
        providerEndpointType: 'sso_profile',
      },
    });
    assert.equal(text.includes('oauth-code'), false);
    assert.equal(text.includes('state-secret'), false);
    assert.equal(text.includes('sso-access-token'), false);
    assert.equal(text.includes('profile unavailable'), false);
    assert.equal(text.includes('sso.example.test'), false);
    assert.equal(text.includes('internalReason'), false);
    assert.equal(text.includes('internalStep'), false);
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

test('callback accepts active SSO profiles from non-xindong email domains', async () => {
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
  let syncedProfile;
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    syncSsoUserProfile: async (profile) => {
      syncedProfile = profile;
      return { user: { userId: profile.userId, email: profile.email, employeeStatus: profile.employeeStatus } };
    },
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_mandy',
      email: 'mandy.shen@starforce.tw',
      employee_status: '1',
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(new URL(response.headers.get('Location')).origin, 'https://demo.pages.xd.team');
  assert.equal(syncedProfile.email, 'mandy.shen@starforce.tw');
  assert.equal(syncedProfile.employeeStatus, 'active');
});

test('callback normalizes email when the company email only appears in profile id', async () => {
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
  let syncedProfile;
  const env = testEnv({
    consumeOAuthStateRecord: (publicState, options) => consumeStoredOAuthState(oauthStorage, publicState, options),
    createOAuthSiteCodeRecord: (input) => createStoredOAuthSiteCode(oauthStorage, input),
    createAuthSessionRecord: (input) => createStoredSession(sessionStorage, input),
    syncSsoUserProfile: async (profile) => {
      syncedProfile = profile;
      return { user: { userId: profile.userId, email: profile.email } };
    },
    fetchSsoToken: async () => ({ accessToken: 'sso-access-token' }),
    fetchSsoProfile: async () => ({
      userId: 'usr_xindong_123',
      id: 'User@XD.com',
      employee_status: '1',
    }),
  });

  const response = await handleOAuthCallback(
    new Request(`https://auth.pages.xd.team/.xd-pages/auth/callback?code=oauth-code&state=${created.publicState}`),
    env,
    readAuthConfig(env)
  );

  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(new URL(response.headers.get('Location')).origin, 'https://demo.pages.xd.team');
  assert.equal(syncedProfile.email, 'user@xd.com');
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
    deviceCode: '12345678',
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
  assert.equal(response.headers.get('Referrer-Policy'), 'same-origin');
  const text = await response.text();
  assert.match(text, /XD Cell CLI 登录确认/);
  assert.match(text, /--brand: #f37022/);
  assertNoCoolToneFragments(text);
  assert.match(text, /production/);
  assert.match(text, /https:\/\/auth\.pages\.xd\.team/);
  assert.match(text, /cli_token/);
  assert.match(text, /name="loginId" value="cli_test"/);
  assert.match(text, /name="confirmToken" value="[^"]+"/);
  assert.match(text, /设备码/);
  assert.match(text, /12345678/);
  assert.match(text, /name="deviceCode" value="12345678"/);
  assert.doesNotMatch(text, /inputmode="numeric"/);
  assert.match(text, /确认授权/);
  assert.equal(text.includes('state-secret'), false);
  assert.equal(text.includes('sso-access-token'), false);
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

function assertNoCoolToneFragments(text) {
  for (const fragment of coolToneFragments) {
    assert.equal(text.includes(fragment), false, `unexpected cool tone fragment: ${fragment}`);
  }
}

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
  assert.deepEqual((await response.json()).error, {
    code: 'SSO_PROVIDER_UNCONFIGURED',
    message: 'SSO provider is not configured.',
    reason: 'sso_token_unavailable',
    step: 'sso.provider',
  });
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
