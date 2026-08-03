import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

const BEARER_USR_1 = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_1',
  bytes: new Uint8Array(24).fill(12),
});

test('whoami returns the active CLI user without token material', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/auth/whoami'), testEnv(store));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    environment: 'production',
    actor: {
      type: 'user',
      credentialType: 'access_key',
      userId: 'usr_1',
      email: 'user@example.com',
      name: 'User One',
      scopes: ['*'],
    },
  });
  assert.doesNotMatch(JSON.stringify(body), /cli_1|cli-token|pepper|keyHash|secret/i);
});

test('whoami accepts deploy-only access keys without read:site scope', async () => {
  const store = await createSeededStore();
  const accessKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/auth/whoami', {
      Authorization: `Bearer ${accessKey}`,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    environment: 'production',
    actor: {
      type: 'access_key',
      credentialType: 'access_key',
      accessKeyId: 'ak_deploy',
      userId: 'usr_1',
      email: 'user@example.com',
      name: 'User One',
      ownerType: 'user',
      ownerId: 'usr_1',
      siteId: 'site_1',
      scopes: ['deploy:site'],
    },
  });
  assert.doesNotMatch(JSON.stringify(body), new RegExp(accessKey));
  assert.doesNotMatch(JSON.stringify(body), /pepper|keyHash|ACCESS_KEY_PEPPER_TEST|secret/i);
});

test('whoami exposes team access key ownership without requiring an email', async () => {
  const store = await createSeededStore();
  await store.createTeam({
    id: 'team_docs',
    environment: 'production',
    teamType: 'custom',
    name: 'Docs Team',
    description: null,
    createdByUserId: 'usr_1',
  });
  const accessKey = await seedAccessKey(store, 'ak_team', ['deploy:site'], {
    ownerType: 'team',
    ownerId: 'team_docs',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    siteId: null,
  });
  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/auth/whoami', {
      Authorization: `Bearer ${accessKey}`,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body, {
    environment: 'production',
    actor: {
      type: 'access_key',
      credentialType: 'access_key',
      accessKeyId: 'ak_team',
      userId: 'usr_1',
      email: null,
      name: 'Docs Team',
      ownerType: 'team',
      ownerId: 'team_docs',
      siteId: null,
      scopes: ['deploy:site'],
    },
  });
  assert.doesNotMatch(JSON.stringify(body), new RegExp(accessKey));
  assert.doesNotMatch(JSON.stringify(body), /pepper|keyHash|ACCESS_KEY_PEPPER_TEST|secret/i);
});

test('whoami returns existing auth errors for invalid tokens', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/auth/whoami', {
      Authorization: 'Bearer invalid-token',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'CLI_TOKEN_INVALID');
});

test('whoami rejects unsupported methods', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/auth/whoami', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEARER_USR_1}`,
        'CF-Connecting-IP': '10.1.2.3',
      },
    }),
    testEnv(store)
  );

  assert.equal(response.status, 405);
  assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
});

function authRequest(url, headers = {}) {
  return new Request(url, {
    headers: { Authorization: `Bearer ${BEARER_USR_1}`, 'CF-Connecting-IP': '10.1.2.3', ...headers },
  });
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

async function seedAccessKey(store, keyId, scopes, overrides = {}) {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId,
    bytes: new Uint8Array(24).fill(5),
  });
  await store.createAccessKey({
    id: keyId,
    environment: 'production',
    ownerType: overrides.ownerType || 'user',
    ownerId: overrides.ownerId || 'usr_1',
    ownerUserId: overrides.ownerUserId || 'usr_1',
    createdByUserId: overrides.createdByUserId || 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes,
    siteId: overrides.siteId === undefined ? 'site_1' : overrides.siteId,
    expiresAt: '2026-07-15T00:00:00.000Z',
  });
  return plaintext;
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

function testEnv(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}
