import assert from 'node:assert/strict';
import test from 'node:test';

import { readAuthConfig } from './config.js';

test('reads production auth config from placeholders-safe env', () => {
  const config = readAuthConfig({
    PAGES_ENV: 'production',
    PUBLIC_AUTH_BASE: 'https://auth.pages.xd.team',
    PUBLIC_API_BASE: 'https://api.pages.xd.team',
    SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
    OAUTH_STATE_TTL_SECONDS: '300',
    CLI_LOGIN_TTL_SECONDS: '600',
    AUTH_SESSION_IDLE_TTL_SECONDS: '1209600',
    AUTH_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
    SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
    SSO_TOKEN_URL: 'https://sso.example.test/oauth/accessToken',
    SSO_PROFILE_URL: 'https://sso.example.test/oauth/profile',
    SSO_CLIENT_ID: 'xd_pages_test',
    SSO_CLIENT_SECRET: 'test-client-secret',
    SSO_ALLOWED_USER_SCOPE: 'xd',
  });

  assert.equal(config.environment, 'production');
  assert.equal(config.authBase, 'https://auth.pages.xd.team');
  assert.equal(config.authHost, 'auth.pages.xd.team');
  assert.equal(config.apiBase, 'https://api.pages.xd.team');
  assert.equal(config.ssoRedirectUri, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
  assert.equal(config.oauthStateTtlSeconds, 300);
  assert.equal(config.cliLoginTtlSeconds, 600);
  assert.equal(config.authSessionIdleTtlSeconds, 1_209_600);
  assert.equal(config.authSessionAbsoluteTtlSeconds, 2_592_000);
  assert.equal(config.ssoAuthorizationUrl, 'https://sso.example.test/oauth/authorize');
  assert.equal(config.ssoTokenUrl, 'https://sso.example.test/oauth/accessToken');
  assert.equal(config.ssoProfileUrl, 'https://sso.example.test/oauth/profile');
  assert.equal(config.ssoClientId, 'xd_pages_test');
  assert.equal(config.ssoClientSecret, 'test-client-secret');
  assert.equal(config.ssoAllowedUserScope, 'xd');
});

test('reads local auth config for SSO development', () => {
  const config = readAuthConfig({
    PAGES_ENV: 'local',
    PUBLIC_AUTH_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
    PUBLIC_API_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
    SSO_REDIRECT_URI: 'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback',
  });

  assert.equal(config.environment, 'local');
  assert.equal(config.authHost, 'xd-pages.127.0.0.1.nip.io');
  assert.equal(config.authBase, 'http://xd-pages.127.0.0.1.nip.io:8787');
  assert.equal(config.ssoRedirectUri, 'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback');
});

test('uses safe defaults for omitted optional auth config', () => {
  const config = readAuthConfig({
    PAGES_ENV: 'staging',
  });

  assert.equal(config.authBase, 'https://auth-staging.pages.xd.team');
  assert.equal(config.apiBase, 'https://api-staging.pages.xd.team');
  assert.equal(config.ssoRedirectUri, 'https://auth-staging.pages.xd.team/.xd-pages/auth/callback');
  assert.equal(config.oauthStateTtlSeconds, 300);
  assert.equal(config.cliLoginTtlSeconds, 600);
});

test('rejects cross-environment auth base and callback', () => {
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        PUBLIC_AUTH_BASE: 'https://auth-staging.pages.xd.team',
        SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
      }),
    /auth base/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'staging',
        PUBLIC_AUTH_BASE: 'https://auth-staging.pages.xd.team',
        SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
      }),
    /redirect/i
  );
});

test('rejects unsafe origins, callback URLs, and TTLs', () => {
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        PUBLIC_AUTH_BASE: 'https://user:pass@auth.pages.xd.team',
      }),
    /auth base/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback#token',
      }),
    /redirect/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        OAUTH_STATE_TTL_SECONDS: '0',
      }),
    /OAUTH_STATE_TTL_SECONDS/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        SSO_AUTHORIZATION_URL: 'https://user:pass@sso.example.test/oauth/authorize',
      }),
    /SSO authorization URL/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        SSO_TOKEN_URL: 'https://user:pass@sso.example.test/oauth/accessToken',
      }),
    /SSO token URL/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        SSO_AUTHORIZATION_URL: 'http://sso.example.test/oauth/authorize',
      }),
    /https/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'staging',
        SSO_PROFILE_URL: 'http://sso.example.test/oauth/profile',
      }),
    /https/i
  );
});

test('allows http SSO endpoints only for local development', () => {
  const config = readAuthConfig({
    PAGES_ENV: 'local',
    PUBLIC_AUTH_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
    PUBLIC_API_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
    SSO_REDIRECT_URI: 'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback',
    SSO_AUTHORIZATION_URL: 'http://sso.127.0.0.1.nip.io/oauth/authorize',
    SSO_TOKEN_URL: 'http://sso.127.0.0.1.nip.io/oauth/token',
    SSO_PROFILE_URL: 'http://sso.127.0.0.1.nip.io/oauth/profile',
  });

  assert.equal(config.ssoAuthorizationUrl, 'http://sso.127.0.0.1.nip.io/oauth/authorize');
  assert.equal(config.ssoTokenUrl, 'http://sso.127.0.0.1.nip.io/oauth/token');
  assert.equal(config.ssoProfileUrl, 'http://sso.127.0.0.1.nip.io/oauth/profile');
});
