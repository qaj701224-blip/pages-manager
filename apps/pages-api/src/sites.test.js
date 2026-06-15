import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('creates a production site with owner membership and inactive route', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'docs',
      visibility: 'org',
    }),
    testEnv(store)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.site.id, 'site_1');
  assert.equal(body.site.slug, 'docs');
  assert.equal(body.site.url, 'https://docs.pages.xd.team');
  assert.equal(body.site.defaultVisibility, 'org');
  assert.equal('token' in body.site, false);

  assert.equal((await store.getRouteBySiteId('site_1')).hostname, 'docs.pages.xd.team');
  assert.equal((await store.getRouteBySiteId('site_1')).routeStatus, 'disabled');
  assert.equal((await store.listSiteMembers('site_1'))[0].role, 'owner');
});

test('lists only sites visible to the authenticated actor', async () => {
  const store = await createSeededStore();
  await store.createUser({
    id: 'usr_2',
    ssoSubject: 'sso_2',
    email: 'other@example.com',
    name: 'Other User',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_1',
    slug: 'mine',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'mine.pages.xd.team',
  });
  await store.createSite({
    id: 'site_2',
    slug: 'other',
    ownerUserId: 'usr_2',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other.pages.xd.team',
  });

  const response = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites'), testEnv(store));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.sites.map((site) => site.slug),
    ['mine']
  );
  assert.equal('token' in body.sites[0], false);
});

test('filters sites by the active API environment', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_prod',
    slug: 'prod',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_prod',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_prod',
    hostname: 'prod.pages.xd.team',
  });
  await store.createSite({
    id: 'site_staging',
    slug: 'staging',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_staging',
    defaultVisibility: 'org',
    environment: 'staging',
    routeId: 'route_staging',
    hostname: 'staging-staging.pages.xd.team',
  });

  const list = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites'), testEnv(store));
  const getStagingFromProduction = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_staging'),
    testEnv(store)
  );

  assert.deepEqual(
    (await list.json()).sites.map((site) => site.id),
    ['site_prod']
  );
  assert.equal(getStagingFromProduction.status, 404);
});

test('gets a site by id for members and hides unknown sites', async () => {
  const store = await createSeededStore();
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

  const found = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1'), testEnv(store));
  const missing = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_missing'), testEnv(store));

  assert.equal(found.status, 200);
  assert.equal((await found.json()).site.slug, 'docs');
  assert.equal(missing.status, 404);
});

test('requires read:site scope for access key site reads', async () => {
  const store = await createSeededStore();
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
  const deployOnlyKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const readKey = await seedAccessKey(store, 'ak_read', ['read:site']);

  const deniedList = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      Authorization: `Bearer ${deployOnlyKey}`,
    }),
    testEnv(store)
  );
  const deniedGet = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {
      Authorization: `Bearer ${deployOnlyKey}`,
    }),
    testEnv(store)
  );
  const allowedGet = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', {
      Authorization: `Bearer ${readKey}`,
    }),
    testEnv(store)
  );

  assert.equal(deniedList.status, 403);
  assert.equal((await deniedList.json()).error.code, 'SITE_READ_FORBIDDEN');
  assert.equal(deniedGet.status, 403);
  assert.equal((await deniedGet.json()).error.code, 'SITE_READ_FORBIDDEN');
  assert.equal(allowedGet.status, 200);
  assert.equal((await allowedGet.json()).site.id, 'site_1');
});

test('updates site visibility and bumps policy version for active routes', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
  await activateSite(store, site.id);
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'disabled' }),
    testEnv(store, { ROUTE_SNAPSHOTS: snapshots })
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.site.defaultVisibility, 'disabled');
  assert.equal(body.site.route.policyVersion, 2);
  assert.equal(body.site.route.visibility, 'disabled');
  assert.equal((await store.getRouteBySiteId('site_1')).cacheTier, 'strict');
  assert.equal(snapshots.read('production:route_pointer:docs.pages.xd.team').policyVersion, 2);
  assert.equal(snapshots.read('production:route_pointer:docs.pages.xd.team').routeGeneration, 1);
});

test('rolls back visibility changes when active route snapshot write fails', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
  await activateSite(store, site.id);

  const response = await worker.fetch(
    patchJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1', { visibility: 'disabled' }),
    testEnv(store, { ROUTE_SNAPSHOTS: failingSnapshotStore() })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal((await store.getSite('site_1')).defaultVisibility, 'org');
  assert.equal((await store.getRouteBySiteId('site_1')).visibility, 'org');
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 1);
});

test('replaces site ACL with allow-only OR entries and rejects unsupported policy features', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });

  const put = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [
        { subjectType: 'user', subjectValue: 'usr_2' },
        { subjectType: 'email', subjectValue: 'Alice@Example.COM' },
        { subjectType: 'department', subjectValue: 'dept_design' },
      ],
    }),
    testEnv(store)
  );
  const get = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl'), testEnv(store));
  const deny = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'user', subjectValue: 'usr_2', effect: 'deny' }],
    }),
    testEnv(store)
  );
  const group = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'group', subjectValue: 'grp_1' }],
    }),
    testEnv(store)
  );

  assert.equal(put.status, 200);
  assert.deepEqual(
    (await put.json()).aclEntries.map(({ subjectType, subjectValue, effect }) => ({ subjectType, subjectValue, effect })),
    [
      { subjectType: 'user', subjectValue: 'usr_2', effect: 'allow' },
      { subjectType: 'email', subjectValue: 'alice@example.com', effect: 'allow' },
      { subjectType: 'department', subjectValue: 'dept_design', effect: 'allow' },
    ]
  );
  assert.deepEqual(
    (await get.json()).aclEntries.map(({ subjectType, subjectValue }) => ({ subjectType, subjectValue })),
    [
      { subjectType: 'user', subjectValue: 'usr_2' },
      { subjectType: 'email', subjectValue: 'alice@example.com' },
      { subjectType: 'department', subjectValue: 'dept_design' },
    ]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 2);
  assert.equal(deny.status, 400);
  assert.equal((await deny.json()).error.code, 'ACL_EFFECT_UNSUPPORTED');
  assert.equal(group.status, 400);
  assert.equal((await group.json()).error.code, 'ACL_SUBJECT_TYPE_UNSUPPORTED');
});

test('rejects deploy-only access keys from reading site ACL entries', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_1', subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  const accessKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      Authorization: `Bearer ${accessKey}`,
    }),
    testEnv(store)
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'SITE_POLICY_FORBIDDEN');
});

test('rolls back ACL changes when active route snapshot write fails', async () => {
  const store = await createSeededStore();
  const site = await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_existing', subjectType: 'user', subjectValue: 'usr_existing', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  await activateSite(store, site.id, { visibility: 'acl' });

  const response = await worker.fetch(
    putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl', {
      entries: [{ subjectType: 'user', subjectValue: 'usr_new' }],
    }),
    testEnv(store, { ROUTE_SNAPSHOTS: failingSnapshotStore() })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.deepEqual(
    (await store.listSiteAclEntries('site_1')).map(({ id, subjectValue }) => ({ id, subjectValue })),
    [{ id: 'acl_existing', subjectValue: 'usr_existing' }]
  );
  assert.equal((await store.getRouteBySiteId('site_1')).policyVersion, 2);
});

test('rejects invalid visibility, duplicate slugs, and production -staging slugs', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_existing',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_existing',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_existing',
    hostname: 'docs.pages.xd.team',
  });

  const invalidVisibility = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'new-site',
      visibility: 'private',
    }),
    testEnv(store)
  );
  const duplicate = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'docs',
      visibility: 'org',
    }),
    testEnv(store)
  );
  const stagingSuffix = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', {
      slug: 'docs-staging',
      visibility: 'org',
    }),
    testEnv(store)
  );

  assert.equal(invalidVisibility.status, 400);
  assert.equal((await invalidVisibility.json()).error.code, 'SITE_VISIBILITY_INVALID');
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'SITE_SLUG_CONFLICT');
  assert.equal(stagingSuffix.status, 400);
  assert.equal((await stagingSuffix.json()).error.code, 'SITE_SLUG_RESERVED');
});

test('sites API rejects legacy X-Pages-Token', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: {
        Authorization: 'Bearer cli-token',
        'X-Pages-Token': 'legacy',
      },
    }),
    testEnv(store)
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'LEGACY_TOKEN_UNSUPPORTED');
});

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

function patchJsonRequest(url, body) {
  return jsonMethodRequest('PATCH', url, body);
}

function putJsonRequest(url, body) {
  return jsonMethodRequest('PUT', url, body);
}

function jsonMethodRequest(method, url, body) {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer cli-token',
    },
    body: JSON.stringify(body),
  });
}

function authRequest(url, headers = {}) {
  return new Request(url, {
    headers: { Authorization: 'Bearer cli-token', ...headers },
  });
}

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
  return store;
}

async function activateSite(store, siteId, overrides = {}) {
  await store.createSiteVersion({
    id: 'ver_1',
    siteId,
    deploymentId: 'dep_1',
    workerName: 'pages-v2-docs-ver-1',
    runtime: 'wfp',
    artifactKind: 'worker',
    artifactRef: 'wfp://test/pages-v2-docs-ver-1',
    contentHash: 'sha256:abc',
    createdBy: 'usr_1',
  });
  return store.activateSiteVersion(
    siteId,
    {
      activeVersionId: 'ver_1',
      workerName: 'pages-v2-docs-ver-1',
      visibility: overrides.visibility || 'org',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
    'production'
  );
}

function failingSnapshotStore() {
  return {
    put: async () => {
      throw new Error('snapshot write failed');
    },
  };
}

function createSnapshotStore() {
  const values = new Map();
  return {
    put: async (key, value) => values.set(key, JSON.parse(value)),
    read: (key) => values.get(key),
  };
}

async function seedAccessKey(store, keyId, scopes) {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId,
    bytes: new Uint8Array(24).fill(3),
  });
  await store.createAccessKey({
    id: keyId,
    ownerUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes,
    siteId: 'site_1',
    expiresAt: '2026-07-15T00:00:00.000Z',
  });
  return plaintext;
}

function testEnv(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: (prefix) =>
      ({
        site: 'site_1',
        route: 'route_1',
        uuid: 'uuid_1',
      })[prefix],
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
