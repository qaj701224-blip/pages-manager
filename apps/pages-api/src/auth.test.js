import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticateApiRequest } from './auth.js';
import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import { createTestPagesStore } from '../test-support/pages-store-fixture.js';

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

for (const [ownerType, keyId, byte] of [
  ['service', 'ak_unknown_owner', 12],
  ['', 'ak_empty_owner', 13],
]) {
  test(`rejects access keys with explicit ${ownerType || 'empty'} owner type without recording usage`, async () => {
    const plaintext = createAccessKeyPlaintext({
      environment: 'production',
      keyId,
      bytes: new Uint8Array(24).fill(byte),
    });
    const store = await createSeededStore();
    await store.createAccessKey({
      id: keyId,
      environment: 'production',
      ownerType,
      ownerId: 'usr_1',
      ownerUserId: 'usr_1',
      createdByUserId: 'usr_1',
      keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
      pepperId: 'pepper_1',
      name: 'invalid owner key',
      scopes: ['read:site'],
      siteId: null,
      issuedSource: 'legacy',
      issuedSessionVersion: null,
    });
    let userReads = 0;
    const originalGetUser = store.getUser.bind(store);
    store.getUser = async (...args) => {
      userReads += 1;
      return originalGetUser(...args);
    };

    const result = await authenticateApiRequest(
      bearerRequest(plaintext),
      accessKeyEnv(),
      store,
      config,
      '2026-06-15T00:00:00.000Z'
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ACCESS_KEY_INVALID');
    assert.equal(result.error.status, 401);
    assert.equal(userReads, 0);
    assert.equal((await store.getAccessKeyById(keyId)).lastUsedAt, null);
  });
}

for (const input of [
  { name: 'mismatched owner ids', keyId: 'ak_personal_owner_mismatch', ownerId: 'usr_other', byte: 18 },
  { name: 'empty owner id', keyId: 'ak_personal_owner_empty', ownerId: '', byte: 19 },
]) {
  test(`rejects non-legacy personal access keys with ${input.name} before reading users`, async () => {
    const store = await createSeededStore();
    const plaintext = await seedAuthAccessKey(store, {
      keyId: input.keyId,
      byte: input.byte,
      issuedSource: 'cli',
    });
    await updateStoredAccessKey(store, input.keyId, { ownerId: input.ownerId });
    let userReads = 0;
    const originalGetUser = store.getUser.bind(store);
    store.getUser = async (...args) => {
      userReads += 1;
      return originalGetUser(...args);
    };

    const result = await authenticateApiRequest(
      bearerRequest(plaintext),
      accessKeyEnv(),
      store,
      config,
      '2026-06-15T00:00:00.000Z'
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ACCESS_KEY_INVALID');
    assert.equal(result.error.status, 401);
    assert.equal(userReads, 0);
    assert.equal((await store.getAccessKeyById(input.keyId)).lastUsedAt, null);
  });
}

test('rejects team access keys with an empty stored owner id before reading teams', async () => {
  const store = await createSeededStore();
  await store.createTeam({
    id: 'team_auth',
    environment: 'production',
    name: 'Auth Team',
    createdByUserId: 'usr_1',
  });
  const plaintext = await seedAuthAccessKey(store, {
    keyId: 'ak_team_owner_empty',
    byte: 20,
    ownerType: 'team',
    ownerId: 'team_auth',
    issuedSource: 'console',
  });
  await updateStoredAccessKey(store, 'ak_team_owner_empty', { ownerId: '' });
  let teamReads = 0;
  const originalGetTeam = store.getTeam.bind(store);
  store.getTeam = async (...args) => {
    teamReads += 1;
    return originalGetTeam(...args);
  };

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACCESS_KEY_INVALID');
  assert.equal(result.error.status, 401);
  assert.equal(teamReads, 0);
  assert.equal((await store.getAccessKeyById('ak_team_owner_empty')).lastUsedAt, null);
});

for (const input of [
  { name: 'string', keyId: 'ak_scopes_string', scopesJson: '"*"', byte: 21 },
  { name: 'object', keyId: 'ak_scopes_object', scopesJson: '{}', byte: 22 },
  { name: 'invalid JSON', keyId: 'ak_scopes_invalid_json', scopesJson: '{', byte: 23 },
  { name: 'empty array', keyId: 'ak_scopes_empty', scopesJson: '[]', byte: 24 },
  { name: 'unknown scope', keyId: 'ak_scopes_unknown', scopesJson: '["admin:site"]', byte: 25 },
  { name: 'mixed wildcard', keyId: 'ak_scopes_mixed_wildcard', scopesJson: '["*","read:site"]', byte: 26 },
]) {
  test(`rejects access keys with ${input.name} scopes before reading users`, async () => {
    const store = await createSeededStore();
    const plaintext = await seedAuthAccessKey(store, {
      keyId: input.keyId,
      byte: input.byte,
      issuedSource: 'cli',
    });
    await updateStoredAccessKey(store, input.keyId, { scopesJson: input.scopesJson });
    let userReads = 0;
    const originalGetUser = store.getUser.bind(store);
    store.getUser = async (...args) => {
      userReads += 1;
      return originalGetUser(...args);
    };

    const result = await authenticateApiRequest(
      bearerRequest(plaintext),
      accessKeyEnv(),
      store,
      config,
      '2026-06-15T00:00:00.000Z'
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ACCESS_KEY_INVALID');
    assert.equal(result.error.status, 401);
    assert.equal(userReads, 0);
    assert.equal((await store.getAccessKeyById(input.keyId)).lastUsedAt, null);
  });
}

test('accepts duplicate supported scopes for compatibility with previously issued access keys', async () => {
  const store = await createSeededStore();
  const plaintext = await seedAuthAccessKey(store, {
    keyId: 'ak_duplicate_scopes',
    byte: 27,
    scopes: ['read:site', 'read:site'],
    issuedSource: 'cli',
  });

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.actor.scopes, ['read:site', 'read:site']);
});

test('accepts an exact wildcard array for an unscoped personal access key', async () => {
  const store = await createSeededStore();
  const plaintext = await seedAuthAccessKey(store, {
    keyId: 'ak_personal_wildcard',
    byte: 30,
    scopes: ['*'],
    issuedSource: 'legacy',
  });

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.actor.scopes, ['*']);
});

test('rejects a site-scoped personal wildcard key before reading users', async () => {
  const store = await createSeededStore();
  const plaintext = await seedAuthAccessKey(store, {
    keyId: 'ak_personal_site_wildcard',
    byte: 31,
    scopes: ['*'],
    siteId: 'site_1',
    issuedSource: 'cli',
  });
  let userReads = 0;
  const originalGetUser = store.getUser.bind(store);
  store.getUser = async (...args) => {
    userReads += 1;
    return originalGetUser(...args);
  };

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACCESS_KEY_INVALID');
  assert.equal(result.error.status, 401);
  assert.equal(userReads, 0);
  assert.equal((await store.getAccessKeyById('ak_personal_site_wildcard')).lastUsedAt, null);
});

test('rejects a team wildcard key before reading teams', async () => {
  const store = await createSeededStore();
  await store.createTeam({
    id: 'team_wildcard',
    environment: 'production',
    name: 'Wildcard Team',
    createdByUserId: 'usr_1',
  });
  const plaintext = await seedAuthAccessKey(store, {
    keyId: 'ak_team_wildcard',
    byte: 32,
    ownerType: 'team',
    ownerId: 'team_wildcard',
    scopes: ['*'],
    issuedSource: 'console',
  });
  let teamReads = 0;
  const originalGetTeam = store.getTeam.bind(store);
  store.getTeam = async (...args) => {
    teamReads += 1;
    return originalGetTeam(...args);
  };

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACCESS_KEY_INVALID');
  assert.equal(result.error.status, 401);
  assert.equal(teamReads, 0);
  assert.equal((await store.getAccessKeyById('ak_team_wildcard')).lastUsedAt, null);
});

for (const input of [
  {
    name: 'site-scoped deploy-only shape',
    keyId: 'ak_cli_site_deploy',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    issuedSessionVersion: 1,
    byte: 14,
  },
  {
    name: 'null session version',
    keyId: 'ak_cli_null_session',
    scopes: ['*'],
    siteId: null,
    issuedSessionVersion: null,
    byte: 15,
  },
  {
    name: 'non-positive session version',
    keyId: 'ak_cli_invalid_session',
    scopes: ['*'],
    siteId: null,
    issuedSessionVersion: 0,
    byte: 16,
  },
  {
    name: 'inconsistent owner ids',
    keyId: 'ak_cli_owner_mismatch',
    ownerId: 'usr_other',
    scopes: ['*'],
    siteId: null,
    issuedSessionVersion: 1,
    byte: 17,
  },
  {
    name: 'null stored owner id',
    keyId: 'ak_cli_owner_null',
    scopes: ['*'],
    siteId: null,
    issuedSessionVersion: 1,
    storedPatch: { ownerId: null },
    byte: 28,
  },
]) {
  test(`rejects cli_login access keys with ${input.name} without recording usage`, async () => {
    const plaintext = createAccessKeyPlaintext({
      environment: 'production',
      keyId: input.keyId,
      bytes: new Uint8Array(24).fill(input.byte),
    });
    const store = await createSeededStore();
    await store.createAccessKey({
      id: input.keyId,
      environment: 'production',
      ownerType: 'user',
      ownerId: input.ownerId || 'usr_1',
      ownerUserId: 'usr_1',
      createdByUserId: 'usr_1',
      keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
      pepperId: 'pepper_1',
      name: 'malformed cli login key',
      scopes: input.scopes,
      siteId: input.siteId,
      issuedSource: 'cli_login',
      issuedSessionVersion: input.issuedSessionVersion,
    });
    if (input.storedPatch) await updateStoredAccessKey(store, input.keyId, input.storedPatch);
    let userReads = 0;
    const originalGetUser = store.getUser.bind(store);
    store.getUser = async (...args) => {
      userReads += 1;
      return originalGetUser(...args);
    };

    const result = await authenticateApiRequest(
      bearerRequest(plaintext),
      accessKeyEnv(),
      store,
      config,
      '2026-06-15T00:00:00.000Z'
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ACCESS_KEY_INVALID');
    assert.equal(result.error.status, 401);
    assert.equal(userReads, 0);
    assert.equal((await store.getAccessKeyById(input.keyId)).lastUsedAt, null);
  });
}

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

test('accepts the exact legacy null-owner shape using owner_user_id', async () => {
  const store = await createSeededStore();
  const plaintext = await seedAuthAccessKey(store, {
    keyId: 'ak_legacy_null_owner',
    byte: 29,
    issuedSource: 'legacy',
  });
  const stored = await store.getAccessKeyById('ak_legacy_null_owner');
  store.getAccessKeyById = async () => ({
    ...stored,
    storedOwnerType: null,
    storedOwnerId: null,
    storedOwnerUserId: 'usr_1',
  });

  const result = await authenticateApiRequest(
    bearerRequest(plaintext),
    accessKeyEnv(),
    store,
    config,
    '2026-06-15T00:00:00.000Z'
  );

  assert.equal(result.ok, true);
  assert.equal(result.actor.ownerType, 'user');
  assert.equal(result.actor.ownerId, 'usr_1');
});

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

async function seedAuthAccessKey(
  store,
  {
    keyId,
    byte,
    ownerType = 'user',
    ownerId = ownerType === 'user' ? 'usr_1' : undefined,
    scopes = ['read:site'],
    siteId = null,
    issuedSource = 'legacy',
  }
) {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId,
    bytes: new Uint8Array(24).fill(byte),
  });
  await store.createAccessKey({
    id: keyId,
    environment: 'production',
    ownerType,
    ownerId,
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes,
    siteId,
    issuedSource,
    issuedSessionVersion: null,
  });
  return plaintext;
}

async function updateStoredAccessKey(store, keyId, patch) {
  const columns = {
    ownerId: 'owner_id',
    scopesJson: 'scopes_json',
  };
  const entries = Object.entries(patch);
  await store.db
    .prepare(`UPDATE access_keys SET ${entries.map(([field]) => `${columns[field]} = ?`).join(', ')} WHERE id = ?`)
    .bind(...entries.map(([, value]) => value), keyId)
    .run();
}
