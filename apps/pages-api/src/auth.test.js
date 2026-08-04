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

const BEARER_USR_1 = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_1',
  bytes: new Uint8Array(24).fill(11),
});

test('rejects legacy X-Pages-Token before bearer auth', async () => {
  const result = await authenticateApiRequest(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: {
        'X-Pages-Token': 'legacy',
        Authorization: `Bearer ${BEARER_USR_1}`,
      },
    }),
    {},
    await createSeededStore(),
    config
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LEGACY_TOKEN_UNSUPPORTED');
  assert.equal(result.error.message, 'Legacy Pages token headers are not supported by XD Cell.');
  assert.equal(result.error.action, 'Run `xd-cell login` or use an XD Cell access key.');
  assert.equal(result.error.status, 400);
});

test('requires bearer auth', async () => {
  const result = await authenticateApiRequest(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites'),
    {},
    await createSeededStore(),
    config
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PAGES_AUTH_REQUIRED');
  assert.equal(result.error.status, 401);
});

test('rejects non-access-key bearer tokens after legacy CLI JWT verification is removed', async () => {
  const result = await authenticateApiRequest(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: { Authorization: 'Bearer legacy.jwt.token' },
    }),
    {},
    await createSeededStore(),
    config
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CLI_TOKEN_INVALID');
  assert.match(result.error.action, /xd-cell login/);
});

test('accepts access keys by HMAC hash and rejects revoked or expired keys', async () => {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId: 'ak_1',
    bytes: new Uint8Array(24).fill(9),
  });
  const store = await createSeededStore();
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
  const stored = await store.getAccessKeyById('ak_1');
  assert.equal(stored.issuedSource, 'legacy');
  assert.equal(stored.issuedSessionVersion, null);

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
    email: 'user@example.com',
    name: 'User One',
    tokenId: 'ak_1',
    ownerType: 'user',
    ownerId: 'usr_1',
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

  const expiredStore = await createSeededStore();
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

test('maps cli_login access keys to the legacy user CLI actor shape', async () => {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId: 'ak_cli_login',
    bytes: new Uint8Array(24).fill(5),
  });
  const store = await createSeededStore();
  await store.createAccessKey({
    id: 'ak_cli_login',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: 'cli login cli_1',
    scopes: ['*'],
    siteId: null,
    issuedSource: 'cli_login',
    issuedSessionVersion: 1,
  });

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.deepEqual(result.actor, {
    type: 'user',
    actorId: 'usr_1',
    userId: 'usr_1',
    email: 'user@example.com',
    name: 'User One',
    tokenId: 'ak_cli_login',
    scopes: ['*'],
    source: 'cli',
  });
});

test('rejects cli_login access keys after the user session version changes', async () => {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId: 'ak_cli_stale',
    bytes: new Uint8Array(24).fill(6),
  });
  const store = await createSeededStore();
  await store.createAccessKey({
    id: 'ak_cli_stale',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: 'cli login cli_stale',
    scopes: ['*'],
    siteId: null,
    issuedSource: 'cli_login',
    issuedSessionVersion: 1,
  });
  await bumpUserSessionVersion(store);

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACCESS_KEY_SESSION_STALE');
});

for (const issuedSource of ['legacy', 'cli', 'console']) {
  test(`accepts ${issuedSource} access keys across user session changes`, async () => {
    const keyId = `ak_${issuedSource}`;
    const plaintext = createAccessKeyPlaintext({
      environment: 'production',
      keyId,
      bytes: new Uint8Array(24).fill(6),
    });
    const store = await createSeededStore();
    await store.createAccessKey({
      id: keyId,
      environment: 'production',
      ownerType: 'user',
      ownerId: 'usr_1',
      ownerUserId: 'usr_1',
      createdByUserId: 'usr_1',
      keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
      pepperId: 'pepper_1',
      name: `${issuedSource} key`,
      scopes: ['deploy:site'],
      siteId: 'site_1',
      expiresAt: '2026-07-15T00:00:00.000Z',
      issuedSource,
      issuedSessionVersion: null,
    });
    await bumpUserSessionVersion(store);
    assert.equal((await store.getUser('usr_1')).sessionVersion, 2);

    const result = await authenticateApiRequest(
      bearerRequest(plaintext),
      accessKeyEnv(),
      store,
      config,
      '2026-06-15T00:00:00.000Z'
    );

    assert.equal(result.ok, true);
    assert.equal(result.actor.tokenId, keyId);
  });
}

test('rejects session-bound access keys after the user session version changes', async () => {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId: 'ak_session',
    bytes: new Uint8Array(24).fill(7),
  });
  const store = await createSeededStore();
  await store.createAccessKey({
    id: 'ak_session',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: 'Session-bound key',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    expiresAt: '2026-07-15T00:00:00.000Z',
    issuedSource: 'cli',
    issuedSessionVersion: 1,
  });
  const stored = await store.getAccessKeyById('ak_session');
  assert.equal(stored.issuedSessionVersion, 1);
  await bumpUserSessionVersion(store);

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'ACCESS_KEY_SESSION_STALE',
      message: 'Access key session is stale.',
      status: 401,
      action: 'Create a new access key.',
    },
  });
  assert.equal((await store.getAccessKeyById('ak_session')).lastUsedAt, null);
});

async function bumpUserSessionVersion(store) {
  await store.upsertUserFromSso({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
    sessionVersion: 2,
  });
}

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

async function createSeededStore() {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  await seedCliLoginKey(store, {
    userId: 'usr_1',
    keyId: 'ak_cli_usr_1',
    plaintext: BEARER_USR_1,
  });
  await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
  return store;
}

async function seedCliLoginKey(store, { userId, keyId, plaintext, environment = 'production', sessionVersion = 1 }) {
  await store.createAccessKey({
    id: keyId,
    environment,
    ownerType: 'user',
    ownerId: userId,
    ownerUserId: userId,
    createdByUserId: userId,
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: `cli login ${userId}`,
    scopes: ['*'],
    siteId: null,
    expiresAt: null,
    issuedSource: 'cli_login',
    issuedSessionVersion: sessionVersion,
  });
}
