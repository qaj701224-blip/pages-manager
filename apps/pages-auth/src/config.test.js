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
});
