import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import * as accessKeys from './access-keys.js';
import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import { createTestPagesStore } from './test-store.js';

test('creates reusable access key material with source and session metadata', async () => {
  assert.equal(typeof accessKeys.createAccessKeyMaterial, 'function');

  const { plaintext, record } = await accessKeys.createAccessKeyMaterial(testEnv(null), { environment: 'production' }, {
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    name: 'XDMaker key',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    expiresAt: '2026-07-15T00:00:00.000Z',
    issuedSource: 'xdmaker',
    issuedSessionVersion: 3,
  });

  assert.match(plaintext, /^xdp_prod_ak_1_[a-f0-9]{48}$/);
  assert.deepEqual(record, {
    id: 'ak_1',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: 'XDMaker key',
    scopes: ['deploy:site'],
    siteId: 'site_1',
    expiresAt: '2026-07-15T00:00:00.000Z',
    issuedSource: 'xdmaker',
    issuedSessionVersion: 3,
  });
});

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
  assert.equal(body.accessKey.issuedSource, 'cli');
  assert.equal(body.accessKey.issuedSessionVersion, undefined);
  assert.equal(body.accessKey.keyHash, undefined);

  const stored = await store.getAccessKeyById('ak_1');
  assert.equal(stored.keyHash.length, 64);
  assert.equal(stored.issuedSource, 'cli');
  assert.equal(stored.issuedSessionVersion, null);
  assert.equal('plaintext' in stored, false);

  const list = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/access-keys'), testEnv(store));
  const listed = (await list.json()).accessKeys[0];
  assert.equal(listed.id, 'ak_1');
  assert.equal(listed.issuedSource, 'cli');
  assert.equal(listed.issuedSessionVersion, undefined);
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
      headers: { Authorization: 'Bearer cli-token', 'CF-Connecting-IP': '10.1.2.3' },
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

test('rejects access key actors from listing or revoking access keys', async () => {
  const store = await createSeededStore();
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId: 'ak_1',
    bytes: new Uint8Array(24).fill(8),
  });
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

  const list = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/access-keys', {
      headers: { Authorization: `Bearer ${plaintext}`, 'CF-Connecting-IP': '10.1.2.3' },
    }),
    testEnv(store)
  );
  const revoke = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/access-keys/ak_1', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${plaintext}`, 'CF-Connecting-IP': '10.1.2.3' },
    }),
    testEnv(store)
  );

  assert.equal(list.status, 403);
  assert.equal((await list.json()).error.code, 'ACCESS_KEY_MANAGEMENT_FORBIDDEN');
  assert.equal(revoke.status, 403);
  assert.equal((await revoke.json()).error.code, 'ACCESS_KEY_MANAGEMENT_FORBIDDEN');
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

test('rejects deploy-capable access key creation for non-owner site members', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_viewer',
    email: 'viewer@example.com',
    employeeStatus: 'active',
  });
  await store.addSiteMember({
    siteId: 'site_1',
    userId: 'usr_viewer',
    role: 'viewer',
    createdBy: 'usr_1',
  });

  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/access-keys', {
      name: 'viewer-ci',
      siteId: 'site_1',
      scopes: ['deploy:site'],
      expiresAt: '2026-07-15T00:00:00.000Z',
    }),
    testEnv(store, {
      verifyCliToken: async () => ({
        sub: 'usr_viewer',
        purpose: 'cli_token',
        aud: 'pages-cli',
        env: 'production',
        jti: 'cli_viewer',
      }),
    })
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ACCESS_KEY_SITE_FORBIDDEN');
  assert.equal(await store.getAccessKeyById('ak_1'), null);
});

test('console creates user-owned access keys with default and maximum expiry', async () => {
  const store = await createSeededStore();

  const response = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
      body: {
        name: 'workspace key',
        scopes: ['read:site'],
      },
    }),
    testEnv(store)
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.accessKey.ownerType, 'user');
  assert.equal(body.accessKey.ownerId, 'usr_1');
  assert.equal(body.accessKey.createdByUserId, 'usr_1');
  assert.equal(body.accessKey.expiresAt, '2026-09-15T00:00:00.000Z');
  assert.match(body.accessKey.plaintext, /^xdp_prod_ak_1_[a-f0-9]{48}$/);
  assert.equal(body.accessKey.issuedSource, 'console');
  assert.equal(body.accessKey.issuedSessionVersion, undefined);

  const stored = await store.getAccessKeyById('ak_1');
  assert.equal(stored.issuedSource, 'console');
  assert.equal(stored.issuedSessionVersion, null);

  const list = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
    }),
    testEnv(store)
  );
  assert.equal(list.status, 200, await list.clone().text());
  const listed = (await list.json()).accessKeys[0];
  assert.equal(listed.issuedSource, 'console');
  assert.equal(listed.issuedSessionVersion, undefined);
  assert.equal(listed.plaintext, undefined);
  assert.equal(listed.keyHash, undefined);

  const tooLong = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
      body: {
        name: 'too long',
        scopes: ['read:site'],
        expiresAt: '2027-06-16T00:00:00.000Z',
      },
    }),
    testEnv(store)
  );
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error.code, 'ACCESS_KEY_EXPIRY_TOO_LONG');
});

test('console owner-scoped access keys are isolated by environment', async () => {
  const store = await createSeededStore();
  const created = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
      body: {
        name: 'staging workspace key',
        scopes: ['read:site'],
      },
    }),
    testEnv(store, { PAGES_ENV: 'staging' })
  );
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = await created.json();
  assert.match(createdBody.accessKey.plaintext, /^xdp_stg_ak_1_[a-f0-9]{48}$/);

  const productionList = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
    }),
    testEnv(store)
  );
  assert.equal(productionList.status, 200, await productionList.clone().text());
  assert.deepEqual((await productionList.json()).accessKeys, []);

  const productionRevoke = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/access-keys/ak_1', {
      userId: 'usr_1',
      method: 'DELETE',
    }),
    testEnv(store)
  );
  assert.equal(productionRevoke.status, 404);

  const stagingList = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
    }),
    testEnv(store, { PAGES_ENV: 'staging' })
  );
  assert.equal(stagingList.status, 200, await stagingList.clone().text());
  assert.equal((await stagingList.json()).accessKeys.length, 1);
});

test('console access key lists hide revoked keys', async () => {
  const store = await createSeededStore();
  await store.createAccessKey({
    id: 'ak_active',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    keyHash: 'hash_active',
    pepperId: 'pepper_1',
    name: 'active',
    scopes: ['read:site'],
    siteId: null,
    expiresAt: '2026-07-15T00:00:00.000Z',
    environment: 'production',
  });
  await store.createAccessKey({
    id: 'ak_revoked',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
    keyHash: 'hash_revoked',
    pepperId: 'pepper_1',
    name: 'revoked',
    scopes: ['read:site'],
    siteId: null,
    expiresAt: '2026-07-15T00:00:00.000Z',
    environment: 'production',
  });
  await store.revokeAccessKey('ak_revoked', '2026-06-15T00:30:00.000Z');

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(
    body.accessKeys.map((accessKey) => accessKey.id),
    ['ak_active']
  );
});

test('team-owned access keys require team admin and survive creator leaving the team', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_viewer',
    email: 'viewer@example.com',
    employeeStatus: 'active',
  });
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_viewer',
    role: 'viewer',
    membershipSource: 'manual',
    actorUserId: 'usr_1',
  });

  const forbidden = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/access-keys`, {
      userId: 'usr_viewer',
      email: 'viewer@example.com',
      body: {
        name: 'viewer key',
        scopes: ['read:site'],
      },
    }),
    testEnv(store)
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'TEAM_ADMIN_REQUIRED');

  const created = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/access-keys`, {
      userId: 'usr_1',
      body: {
        name: 'team key',
        scopes: ['read:site'],
      },
    }),
    testEnv(store)
  );
  assert.equal(created.status, 201, await created.clone().text());
  const body = await created.json();
  assert.equal(body.accessKey.ownerType, 'team');
  assert.equal(body.accessKey.ownerId, team.id);
  assert.equal(body.accessKey.createdByUserId, 'usr_1');
  assert.equal(body.accessKey.ownerUserId, 'usr_1');
  assert.match(body.accessKey.plaintext, /^xdp_prod_ak_1_[a-f0-9]{48}$/);
  assert.equal(body.accessKey.issuedSource, 'console');
  assert.equal(body.accessKey.issuedSessionVersion, undefined);

  const stored = await store.getAccessKeyById('ak_1');
  assert.equal(stored.issuedSource, 'console');
  assert.equal(stored.issuedSessionVersion, null);

  await store.removeTeamMember({ teamId: team.id, userId: 'usr_1', actorUserId: 'usr_1' });
  const site = await seedTeamSite(store, { id: 'site_team', slug: 'team-docs', teamId: team.id });

  const personalList = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/access-keys'), testEnv(store));
  assert.equal(personalList.status, 200, await personalList.clone().text());
  assert.deepEqual((await personalList.json()).accessKeys, []);

  const personalRevoke = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/access-keys/ak_1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer cli-token', 'CF-Connecting-IP': '10.1.2.3' },
    }),
    testEnv(store)
  );
  assert.equal(personalRevoke.status, 404);

  const read = await worker.fetch(
    new Request(`https://api.pages.xd.team/.xd-pages/api/sites/${site.id}`, {
      headers: {
        Authorization: `Bearer ${body.accessKey.plaintext}`,
        'CF-Connecting-IP': '10.1.2.3',
      },
    }),
    testEnv(store)
  );
  assert.equal(read.status, 200, await read.clone().text());
});

test('team-owned access key creation rejects deleted teams even when membership still exists', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    createdByUserId: 'usr_1',
  });
  const originalGetTeam = store.getTeam.bind(store);
  store.getTeam = async (teamId) => {
    const record = await originalGetTeam(teamId);
    return record ? { ...record, deletedAt: '2026-06-15T00:00:00.000Z' } : null;
  };

  const response = await worker.fetch(
    internalConsoleJsonRequest(`/.xd-pages/api/console/teams/${team.id}/access-keys`, {
      userId: 'usr_1',
      body: {
        name: 'team key',
        scopes: ['read:site'],
      },
    }),
    testEnv(store)
  );

  assert.equal(response.status, 404, await response.clone().text());
  assert.equal((await response.json()).error.code, 'TEAM_NOT_FOUND');
});

test('user-owned owner-scoped access keys recalculate current team permissions on use', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    environment: 'production',
    teamType: 'custom',
    name: 'Console Team',
    createdByUserId: 'usr_1',
  });
  const site = await seedTeamSite(store, { id: 'site_team', slug: 'team-docs', teamId: team.id });

  const created = await worker.fetch(
    internalConsoleJsonRequest('/.xd-pages/api/console/access-keys', {
      userId: 'usr_1',
      body: {
        name: 'workspace read',
        scopes: ['read:site'],
      },
    }),
    testEnv(store)
  );
  assert.equal(created.status, 201, await created.clone().text());
  const plaintext = (await created.json()).accessKey.plaintext;

  const beforeRemoval = await worker.fetch(
    new Request(`https://api.pages.xd.team/.xd-pages/api/sites/${site.id}`, {
      headers: {
        Authorization: `Bearer ${plaintext}`,
        'CF-Connecting-IP': '10.1.2.3',
      },
    }),
    testEnv(store)
  );
  assert.equal(beforeRemoval.status, 200, await beforeRemoval.clone().text());

  await store.removeTeamMember({ teamId: team.id, userId: 'usr_1', actorUserId: 'usr_1' });

  const afterRemoval = await worker.fetch(
    new Request(`https://api.pages.xd.team/.xd-pages/api/sites/${site.id}`, {
      headers: {
        Authorization: `Bearer ${plaintext}`,
        'CF-Connecting-IP': '10.1.2.3',
      },
    }),
    testEnv(store)
  );
  assert.equal(afterRemoval.status, 404);
});

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

async function seedTeamSite(store, { id, slug, teamId, visibility = 'internal' }) {
  await store.createSite({
    id,
    slug,
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: teamId,
    siteUuid: `uuid_${id}`,
    defaultVisibility: visibility,
    environment: 'production',
    routeId: `route_${id}`,
    hostname: `${slug}.workers.xd.team`,
  });
  return store.getSite(id);
}

function testEnv(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
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
    ...overrides,
  };
}

function jsonRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer cli-token',
      'CF-Connecting-IP': '10.1.2.3',
    },
    body: JSON.stringify(body),
  });
}

function authRequest(url) {
  return new Request(url, {
    headers: { Authorization: 'Bearer cli-token', 'CF-Connecting-IP': '10.1.2.3' },
  });
}

function internalConsoleRequest(path, { userId, email = 'user@example.com', method = 'GET' } = {}) {
  const headers = {
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
  };
  if (userId) {
    headers['X-Console-User-Id'] = userId;
    headers['X-Console-Email'] = email;
  }
  return new Request(`https://pages-api.internal${path}`, { method, headers });
}

function internalConsoleJsonRequest(path, { userId, email = 'user@example.com', body } = {}) {
  const request = internalConsoleRequest(path, { userId, email, method: 'POST' });
  return new Request(request.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(request.headers.entries()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
