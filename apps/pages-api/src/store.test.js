import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestPagesStore } from './test-store.js';

test('test store enforces unique site slug per environment', async () => {
  const store = createSeededStore();

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

  await assert.rejects(
    () =>
      store.createSite({
        id: 'site_2',
        slug: 'docs',
        ownerUserId: 'usr_1',
        siteUuid: 'uuid_2',
        defaultVisibility: 'org',
        environment: 'production',
        routeId: 'route_2',
        hostname: 'docs-2.pages.xd.team',
      }),
    /SITE_SLUG_CONFLICT/
  );

  const stagingSite = await store.createSite({
    id: 'site_3',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_3',
    defaultVisibility: 'org',
    environment: 'staging',
    routeId: 'route_3',
    hostname: 'docs-staging.pages.xd.team',
  });

  assert.equal(stagingSite.id, 'site_3');
});

test('createSite creates owner membership and inactive route authority record', async () => {
  const store = createSeededStore();

  await store.createSite({
    id: 'site_1',
    slug: 'portal',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'acl',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'portal.pages.xd.team',
  });

  assert.deepEqual(await store.listSiteMembers('site_1'), [
    {
      siteId: 'site_1',
      userId: 'usr_1',
      role: 'owner',
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(await store.getRouteBySiteId('site_1'), {
    id: 'route_1',
    hostname: 'portal.pages.xd.team',
    siteId: 'site_1',
    environment: 'production',
    runtime: 'disabled',
    workerName: null,
    activeVersionId: null,
    visibility: 'acl',
    policyVersion: 1,
    routeGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: 'sensitive',
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
});

test('site versions are immutable records', async () => {
  const store = createSeededStore();
  await createSite(store);

  const version = await store.createSiteVersion({
    id: 'ver_1',
    siteId: 'site_1',
    deploymentId: 'dep_1',
    workerName: 'pages-v2-site-1',
    runtime: 'wfp',
    artifactKind: 'worker',
    artifactRef: 'dispatch/pages-v2-site-1',
    contentHash: 'sha256:abc',
    createdBy: 'usr_1',
  });
  version.workerName = 'mutated';

  assert.equal((await store.getSiteVersion('ver_1')).workerName, 'pages-v2-site-1');
  await assert.rejects(
    () =>
      store.createSiteVersion({
        id: 'ver_1',
        siteId: 'site_1',
        deploymentId: 'dep_2',
        workerName: 'pages-v2-site-2',
        runtime: 'wfp',
        artifactKind: 'worker',
        artifactRef: 'dispatch/pages-v2-site-2',
        contentHash: 'sha256:def',
        createdBy: 'usr_1',
      }),
    /VERSION_EXISTS/
  );
});

test('access keys persist hash metadata without plaintext', async () => {
  const store = createSeededStore();

  await assert.rejects(
    () =>
      store.createAccessKey({
        id: 'ak_bad',
        ownerUserId: 'usr_1',
        plaintext: 'xdp_prod_secret',
        keyHash: 'hash_1',
        pepperId: 'pepper_1',
        name: 'bad',
        scopes: ['deploy:site'],
        siteId: null,
        expiresAt: null,
      }),
    /ACCESS_KEY_PLAINTEXT_FORBIDDEN/
  );

  const key = await store.createAccessKey({
    id: 'ak_1',
    ownerUserId: 'usr_1',
    keyHash: 'hash_1',
    pepperId: 'pepper_1',
    name: 'ci',
    scopes: ['deploy:site'],
    siteId: null,
    expiresAt: null,
  });

  assert.equal(key.keyHash, 'hash_1');
  assert.equal(key.pepperId, 'pepper_1');
  assert.equal('plaintext' in key, false);
});

test('deployment idempotency returns existing records and rejects hash conflicts', async () => {
  const store = createSeededStore();
  await createSite(store);

  const first = await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_a',
    visibility: 'org',
    status: 'pending',
  });
  assert.equal(first.kind, 'created');

  const replay = await store.createDeploymentForIdempotency({
    id: 'dep_2',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_a',
    visibility: 'org',
    status: 'pending',
  });
  assert.equal(replay.kind, 'existing');
  assert.equal(replay.deployment.id, 'dep_1');

  const conflict = await store.createDeploymentForIdempotency({
    id: 'dep_3',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_b',
    visibility: 'org',
    status: 'pending',
  });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(await store.getDeployment('dep_3'), null);
});

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

async function createSite(store) {
  return store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
}
