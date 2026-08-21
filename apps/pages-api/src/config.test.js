import assert from 'node:assert/strict';
import test from 'node:test';

import { readApiConfig } from './infrastructure/config/api-config.js';

test('reads production pages API config', () => {
  assert.deepEqual(readApiConfig({ PAGES_ENV: 'production' }), {
    environment: 'production',
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    siteDomainSuffix: 'workers.xd.team',
  });
});

test('reads staging pages API config', () => {
  assert.deepEqual(readApiConfig({ PAGES_ENV: 'staging' }), {
    environment: 'staging',
    apiBaseUrl: 'https://api-staging.pages.xd.team',
    authBaseUrl: 'https://auth-staging.pages.xd.team',
    siteDomainSuffix: 'workers.xd.team',
  });
});

test('reads local pages API config', () => {
  assert.deepEqual(readApiConfig({ PAGES_ENV: 'local' }), {
    environment: 'local',
    apiBaseUrl: 'http://xd-pages.127.0.0.1.nip.io:8787',
    authBaseUrl: 'http://xd-pages.127.0.0.1.nip.io:8787',
    siteDomainSuffix: '127.0.0.1.nip.io',
  });
});

test('rejects invalid environment', () => {
  assert.throws(() => readApiConfig({ PAGES_ENV: 'preview' }), /PAGES_ENV/);
});

test('rejects public base overrides that do not match the environment', () => {
  assert.throws(
    () =>
      readApiConfig({
        PAGES_ENV: 'production',
        PUBLIC_API_BASE: 'https://api-staging.pages.xd.team',
      }),
    /API base/
  );
});
