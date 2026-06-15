import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('creates a site-scoped access key and returns plaintext only once', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/access-keys', {
      name: 'ci',
      siteId: 'site_1',
      scopes: ['deploy:site'],
      expiresAt: '2026-07-15T00:00:00.000Z',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.accessKey.id, 'ak_1');
  assert.match(body.accessKey.plaintext, /^xdp_prod_ak_1_[a-f0-9]{48}$/);
  assert.equal(body.accessKey.keyHash, undefined);

  const stored = await store.getAccessKeyById('ak_1');
  assert.equal(stored.keyHash.length, 64);
  assert.equal('plaintext' in stored, false);

  const list = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/access-keys'), testEnv(store));
  const listed = (await list.json()).accessKeys[0];
  assert.equal(listed.id, 'ak_1');
  assert.equal(listed.plaintext, undefined);
  assert.equal(listed.keyHash, undefined);
});

test('revokes access keys without returning plaintext or hash', async () => {
  const store = await createSeededStore();
  await store.createAccessKey({
    id: 'ak_1',
    ownerUserId: 'usr_1',
    keyHash: 'hash_1',
    pepperId: 'pepper_1',
    name: 'ci',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    expiresAt: '2026-07-15T00:00:00.000Z',
  });

  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/access-keys/ak_1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer cli-token' },
    }),
    testEnv(store)
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accessKey.id, 'ak_1');
  assert.equal(body.accessKey.revokedAt, '2026-06-15T00:00:00.000Z');
  assert.equal(body.accessKey.plaintext, undefined);
  assert.equal(body.accessKey.keyHash, undefined);
});

test('rejects access key creation for inaccessible sites and invalid scopes', async () => {
  const store = await createSeededStore();
  const invalidScope = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/access-keys', {
      name: 'ci',
      siteId: 'site_1',
      scopes: ['admin:*'],
      expiresAt: '2026-07-15T00:00:00.000Z',
    }),
    testEnv(store)
  );
  const missingSite = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/access-keys', {
      name: 'ci',
      siteId: 'site_missing',
      scopes: ['deploy:site'],
      expiresAt: '2026-07-15T00:00:00.000Z',
    }),
    testEnv(store)
  );

  assert.equal(invalidScope.status, 400);
  assert.equal((await invalidScope.json()).error.code, 'ACCESS_KEY_SCOPE_INVALID');
  assert.equal(missingSite.status, 404);
  assert.equal((await missingSite.json()).error.code, 'SITE_NOT_FOUND');
});

async function createSeededStore() {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.createUser({
    id: 'usr_1',
    ssoSubject: 'sso_1',
    email: 'user@example.com',
    name: 'User One',
    employeeStatus: 'active',
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

function testEnv(store) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_1',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: (prefix) => (prefix === 'ak' ? 'ak_1' : `${prefix}_1`),
    randomBytes: (length) => new Uint8Array(length).fill(5),
    verifyCliToken: async () => ({
      sub: 'usr_1',
      purpose: 'cli_token',
      aud: 'pages-cli',
      env: 'production',
      jti: 'cli_1',
    }),
  };
}

function jsonRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer cli-token',
    },
    body: JSON.stringify(body),
  });
}

function authRequest(url) {
  return new Request(url, {
    headers: { Authorization: 'Bearer cli-token' },
  });
}
