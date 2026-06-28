import assert from 'node:assert/strict';
import test from 'node:test';

import { FIXED_ENVIRONMENTS, readCliConfig, resolveEnvironment, validateTrustedOrigin } from './config.js';

test('reads fixed production and staging endpoints', () => {
  assert.deepEqual(readCliConfig({ PAGES_CLI_ENV: 'production' }), {
    environment: 'production',
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    siteDomainSuffix: 'workers.xd.team',
  });

  assert.deepEqual(readCliConfig({ PAGES_CLI_ENV: 'staging' }), {
    environment: 'staging',
    apiBaseUrl: 'https://api-staging.pages.xd.team',
    authBaseUrl: 'https://auth-staging.pages.xd.team',
    siteDomainSuffix: 'workers.xd.team',
  });
});

test('user-facing fixed environments are production and staging only', () => {
  assert.deepEqual(Object.keys(FIXED_ENVIRONMENTS), ['production', 'staging']);
  assert.equal(resolveEnvironment('production'), 'production');
  assert.equal(resolveEnvironment('staging'), 'staging');
  assert.equal(resolveEnvironment('custom'), 'custom');
  assert.throws(() => resolveEnvironment('local'), /XD Cell CLI environment is invalid/);
});

test('rejects overriding fixed production and staging endpoints', () => {
  assert.throws(
    () => readCliConfig({ PAGES_CLI_ENV: 'production', PAGES_API_BASE: 'https://api.evil.example' }),
    /cannot override fixed Pages environment/
  );
  assert.throws(
    () => readCliConfig({ PAGES_CLI_ENV: 'staging', PAGES_AUTH_BASE: 'https://auth.evil.example' }),
    /cannot override fixed Pages environment/
  );
});

test('rejects v1 api.workers.xd.team and arbitrary custom endpoints', () => {
  assert.throws(
    () =>
      readCliConfig({
        PAGES_CLI_ENV: 'custom',
        PAGES_API_BASE: 'https://api.workers.xd.team',
        PAGES_AUTH_BASE: 'https://auth.pages.xd.team',
      }),
    /workers\.xd\.team/
  );

  assert.throws(
    () =>
      readCliConfig({
        PAGES_CLI_ENV: 'custom',
        PAGES_API_BASE: 'https://api.example.com',
        PAGES_AUTH_BASE: 'https://auth.example.com',
      }),
    /custom endpoints must be loopback/
  );
});

test('uses workers.xd.team as the fixed v2 site suffix while keeping custom endpoints loopback-only', () => {
  assert.equal(readCliConfig({ PAGES_CLI_ENV: 'production' }).siteDomainSuffix, 'workers.xd.team');
});

test('allows loopback custom endpoints for local development', () => {
  assert.deepEqual(
    readCliConfig({
      PAGES_CLI_ENV: 'custom',
      PAGES_API_BASE: 'http://127.0.0.1:8787',
      PAGES_AUTH_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
      PAGES_SITE_DOMAIN_SUFFIX: '127.0.0.1.nip.io',
    }),
    {
      environment: 'custom',
      apiBaseUrl: 'http://127.0.0.1:8787',
      authBaseUrl: 'http://xd-pages.127.0.0.1.nip.io:8787',
      siteDomainSuffix: '127.0.0.1.nip.io',
    }
  );
});

test('rejects custom site domain suffix outside loopback allowlist', () => {
  assert.throws(
    () =>
      readCliConfig({
        PAGES_CLI_ENV: 'custom',
        PAGES_API_BASE: 'http://127.0.0.1:8787',
        PAGES_AUTH_BASE: 'http://127.0.0.1:8787',
        PAGES_SITE_DOMAIN_SUFFIX: 'pages.example.com',
      }),
    /custom site suffix must be loopback/
  );
});

test('normalizes safe origins and rejects paths, credentials, and unsupported protocols', () => {
  assert.equal(
    validateTrustedOrigin('https://api.pages.xd.team/', { environment: 'production', fixed: true }),
    'https://api.pages.xd.team'
  );
  assert.throws(() => validateTrustedOrigin('https://user:pass@api.pages.xd.team', { environment: 'production' }), /Invalid URL/);
  assert.throws(() => validateTrustedOrigin('https://api.pages.xd.team/path', { environment: 'production' }), /Invalid URL/);
  assert.throws(() => validateTrustedOrigin('ftp://127.0.0.1:8787', { environment: 'custom' }), /Invalid URL/);
});
