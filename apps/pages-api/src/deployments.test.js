import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('creates deployment, immutable version, active route, and route snapshot', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        artifactKind: 'worker',
        contentHash: 'sha256:abc',
        source: 'cli',
      },
      { 'Idempotency-Key': 'idem_1' }
    ),
    testEnv(store, snapshots)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.deployment.id, 'dep_1');
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.versionId, 'ver_1');
  assert.equal(body.version.workerName, 'pages-v2-docs-ver-1');
  assert.equal(body.route.routeGeneration, 1);
  assert.equal((await store.getSiteVersion('ver_1')).contentHash, 'sha256:abc');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal(snapshots.read('route_pointer:docs.pages.xd.team').routeGeneration, 1);
});

test('deployment idempotency replays same request and rejects changed request', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  const first = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { siteId: 'site_1', artifactKind: 'worker', contentHash: 'sha256:abc' },
      { 'Idempotency-Key': 'idem_1' }
    ),
    env
  );
  const replay = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { contentHash: 'sha256:abc', artifactKind: 'worker', siteId: 'site_1' },
      { 'Idempotency-Key': 'idem_1' }
    ),
    env
  );
  const conflict = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { siteId: 'site_1', artifactKind: 'worker', contentHash: 'sha256:def' },
      { 'Idempotency-Key': 'idem_1' }
    ),
    env
  );

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).deployment.id, 'dep_1');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await store.getSiteVersion('ver_2'), null);
});

test('gets deployment by id for authorized site actors', async () => {
  const store = await createSeededStore();
  await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_1',
    visibility: 'org',
    status: 'succeeded',
  });

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).deployment.id, 'dep_1');
});

test('rolls back to an existing immutable version and writes a new route snapshot', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { siteId: 'site_1', artifactKind: 'worker', contentHash: 'sha256:abc' },
      { 'Idempotency-Key': 'deploy_1' }
    ),
    env
  );
  await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { siteId: 'site_1', artifactKind: 'worker', contentHash: 'sha256:def' },
      { 'Idempotency-Key': 'deploy_2' }
    ),
    env
  );

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_1' }),
    env
  );

  assert.equal(rollback.status, 201);
  const body = await rollback.json();
  assert.equal(body.deployment.operation, 'rollback');
  assert.equal(body.deployment.previousVersionId, 'ver_2');
  assert.equal(body.route.activeVersionId, 'ver_1');
  assert.equal(body.route.routeGeneration, 3);
  assert.equal((await store.getSiteVersion('ver_1')).contentHash, 'sha256:abc');
  assert.equal((await store.getSiteVersion('ver_2')).contentHash, 'sha256:def');
  assert.equal(snapshots.read('route_pointer:docs.pages.xd.team').routeGeneration, 3);
});

test('requires idempotency key for deploy and rollback', async () => {
  const store = await createSeededStore();
  const deploy = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/deployments', {
      siteId: 'site_1',
      artifactKind: 'worker',
      contentHash: 'sha256:abc',
    }),
    testEnv(store, createSnapshotStore())
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(deploy.status, 400);
  assert.equal((await deploy.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(rollback.status, 400);
  assert.equal((await rollback.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
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

function testEnv(store, snapshots) {
  let counters = { dep: 0, ver: 0 };
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    ROUTE_SNAPSHOTS: snapshots,
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: (prefix) => {
      if (prefix === 'dep') return `dep_${(counters.dep += 1)}`;
      if (prefix === 'ver') return `ver_${(counters.ver += 1)}`;
      return `${prefix}_1`;
    },
    verifyCliToken: async () => ({
      sub: 'usr_1',
      purpose: 'cli_token',
      aud: 'pages-cli',
      env: 'production',
      jti: 'cli_1',
    }),
  };
}

function createSnapshotStore() {
  const values = new Map();
  return {
    put: async (key, value) => values.set(key, JSON.parse(value)),
    read: (key) => values.get(key),
  };
}

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer cli-token',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function authRequest(url) {
  return new Request(url, {
    headers: { Authorization: 'Bearer cli-token' },
  });
}
