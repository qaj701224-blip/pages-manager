import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticateApiRequest } from './auth.js';
import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import { createTestPagesStore } from './test-store.js';

const config = {
  environment: 'production',
  apiBaseUrl: 'https://api.pages.xd.team',
  authBaseUrl: 'https://auth.pages.xd.team',
  siteDomainSuffix: 'pages.xd.team',
};

test('rejects legacy X-Pages-Token before bearer auth', async () => {
  const result = await authenticateApiRequest(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: {
        'X-Pages-Token': 'legacy',
        Authorization: 'Bearer cli-token',
      },
    }),
    {
      verifyCliToken: async () => ({ sub: 'usr_1', purpose: 'cli_token', aud: 'pages-cli', env: 'production' }),
    },
    createSeededStore(),
    config
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LEGACY_TOKEN_UNSUPPORTED');
  assert.equal(result.error.status, 400);
});

test('requires bearer auth', async () => {
  const result = await authenticateApiRequest(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites'),
    {},
    createSeededStore(),
    config
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PAGES_AUTH_REQUIRED');
  assert.equal(result.error.status, 401);
});

test('accepts verified CLI tokens with cli purpose and environment binding', async () => {
  const result = await authenticateApiRequest(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: { Authorization: 'Bearer cli-token' },
    }),
    {
      verifyCliToken: async (token) => ({
        token,
        sub: 'usr_1',
        purpose: 'cli_token',
        aud: 'pages-cli',
        env: 'production',
        jti: 'cli_1',
      }),
    },
    createSeededStore(),
    config
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.actor, {
    type: 'user',
    actorId: 'usr_1',
    userId: 'usr_1',
    tokenId: 'cli_1',
    scopes: ['*'],
    source: 'cli',
  });
});

test('rejects CLI tokens with wrong purpose or environment', async () => {
  const wrongPurpose = await authenticateApiRequest(
    bearerRequest('cli-token'),
    {
      verifyCliToken: async () => ({ sub: 'usr_1', purpose: 'site_session', aud: 'pages-cli', env: 'production' }),
    },
    createSeededStore(),
    config
  );
  const wrongEnv = await authenticateApiRequest(
    bearerRequest('cli-token'),
    {
      verifyCliToken: async () => ({ sub: 'usr_1', purpose: 'cli_token', aud: 'pages-cli', env: 'staging' }),
    },
    createSeededStore(),
    config
  );

  assert.equal(wrongPurpose.ok, false);
  assert.equal(wrongPurpose.error.code, 'CLI_TOKEN_INVALID');
  assert.equal(wrongEnv.ok, false);
  assert.equal(wrongEnv.error.code, 'CLI_TOKEN_INVALID');
});

test('accepts access keys by HMAC hash and rejects revoked or expired keys', async () => {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId: 'ak_1',
    bytes: new Uint8Array(24).fill(9),
  });
  const store = createSeededStore();
  await store.createAccessKey({
    id: 'ak_1',
    ownerUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: 'ci',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    expiresAt: '2026-07-15T00:00:00.000Z',
  });

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.actor, {
    type: 'access_key',
    actorId: 'ak_1',
    userId: 'usr_1',
    tokenId: 'ak_1',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    source: 'access_key',
  });

  await store.revokeAccessKey('ak_1', '2026-06-16T00:00:00.000Z');
  const revoked = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-16T00:00:01.000Z'
  );
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error.code, 'ACCESS_KEY_REVOKED');

  const expiredStore = createSeededStore();
  await expiredStore.createAccessKey({
    id: 'ak_1',
    ownerUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: 'ci',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    expiresAt: '2026-06-14T00:00:00.000Z',
  });
  const expired = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    expiredStore,
    config,
    '2026-06-15T00:00:00.000Z'
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'ACCESS_KEY_EXPIRED');
});

function bearerRequest(token) {
  return new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function accessKeyEnv() {
  return {
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
  };
}

function createSeededStore() {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  store.createUser({
    id: 'usr_1',
    ssoSubject: 'sso_1',
    email: 'user@example.com',
    name: 'User One',
    employeeStatus: 'active',
  });
  return store;
}
