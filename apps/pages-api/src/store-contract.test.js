import assert from 'node:assert/strict';
import test from 'node:test';

import { createD1TestDatabase } from './d1-test-db.js';
import { createSchemaSql } from './schema.js';
import { D1PagesStore } from './store.js';
import { createTestPagesStore } from './test-store.js';

// Intentional implementation differences outside this shared contract:
// - `failAuditWrites` is a TestPagesStore-only fault-injection option.
// - D1PagesStore encrypts secret values at rest; the public snapshot returned by
//   both stores contains the same decrypted value.
// - D1PagesStore exposes its active runtime lock ID to the lock callback, while
//   TestPagesStore serializes callbacks in memory and reports a null lock ID.

const NOW = '2026-07-28T00:00:00.000Z';

const storeBackends = [
  {
    name: 'TestPagesStore',
    async create() {
      return {
        store: createTestPagesStore({ now: () => NOW }),
        dispose() {},
      };
    },
  },
  {
    name: 'D1PagesStore',
    async create() {
      const db = createD1TestDatabase();
      await db.exec(createSchemaSql().join(';\n'));
      return {
        store: new D1PagesStore(db, {
          now: () => NOW,
          secretEncryptionKey: 'store-contract-test-encryption-key',
        }),
        dispose() {
          db.close();
        },
      };
    },
  },
];

test('D1 test adapter exposes D1 result shapes and wraps SQLite errors', async () => {
  const db = createD1TestDatabase();
  test.after(() => db.close());

  await db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');

  const insert = await db.prepare('INSERT INTO records (name) VALUES (?)').bind('alpha').run();
  assert.deepEqual(insert, {
    success: true,
    meta: {
      changes: 1,
      last_row_id: 1,
    },
  });
  assert.deepEqual(await db.prepare('SELECT id, name FROM records').all(), {
    results: [{ id: 1, name: 'alpha' }],
    success: true,
    meta: {},
  });
  assert.deepEqual(await db.prepare('SELECT id, name FROM records').first(), { id: 1, name: 'alpha' });
  assert.equal(await db.prepare('SELECT name FROM records').first('name'), 'alpha');
  assert.equal(await db.prepare('SELECT id FROM records WHERE id = 2').first(), null);

  await assert.rejects(
    () => db.prepare('INSERT INTO records (name) VALUES (?)').bind(null).run(),
    /D1_ERROR: NOT NULL constraint failed: records\.name/,
  );
});

test('D1 test adapter rolls back an entire batch when one statement fails', async () => {
  const db = createD1TestDatabase();
  test.after(() => db.close());

  await db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');

  assert.deepEqual(
    await db.batch([
      db.prepare('INSERT INTO records (name) VALUES (?)').bind('alpha'),
      db.prepare('SELECT id, name FROM records ORDER BY id'),
    ]),
    [
      {
        success: true,
        meta: {
          changes: 1,
          last_row_id: 1,
        },
      },
      {
        results: [{ id: 1, name: 'alpha' }],
        success: true,
        meta: {},
      },
    ],
  );

  await assert.rejects(
    () =>
      db.batch([
        db.prepare('INSERT INTO records (name) VALUES (?)').bind('kept-only-on-success'),
        db.prepare('INSERT INTO records (name) VALUES (?)').bind(null),
      ]),
    /D1_ERROR: NOT NULL constraint failed: records\.name/,
  );
  assert.deepEqual(await db.prepare('SELECT id FROM records').all(), {
    results: [{ id: 1 }],
    success: true,
    meta: {},
  });
});

for (const backend of storeBackends) {
  test(`${backend.name} contract: sites enforce environment-scoped slugs and create owner authority`, async () => {
    const fixture = await backend.create();
    try {
      const site = await createSite(fixture.store);

      assert.deepEqual(
        {
          id: site.id,
          ownerType: site.ownerType,
          ownerId: site.ownerId,
          ownerUserId: site.ownerUserId,
          environment: site.environment,
        },
        {
          id: 'site_1',
          ownerType: 'user',
          ownerId: 'usr_owner',
          ownerUserId: 'usr_owner',
          environment: 'production',
        },
      );
      assert.deepEqual(
        (await fixture.store.listSiteMembers('site_1')).map(({ userId, role }) => ({ userId, role })),
        [{ userId: 'usr_owner', role: 'owner' }],
      );
      assert.deepEqual(
        pickRoute(await fixture.store.getRouteBySiteId('site_1', 'production')),
        {
          id: 'route_1',
          hostname: 'docs.pages.xd.team',
          runtime: 'disabled',
          visibility: 'org',
          routeStatus: 'disabled',
          runtimeConfigGeneration: 0,
        },
      );
      assert.deepEqual(
        pickClaim(await fixture.store.getHostnameClaim('docs.pages.xd.team')),
        {
          hostname: 'docs.pages.xd.team',
          normalizedSlug: 'docs',
          hostnameFamily: 'pages',
          ownerSystem: 'v2',
          ownerId: 'site_1',
          ownerRef: 'route_1',
          status: 'active',
        },
      );

      await assert.rejects(
        () =>
          fixture.store.createSite({
            id: 'site_conflict',
            slug: 'docs',
            ownerUserId: 'usr_owner',
            siteUuid: 'uuid_conflict',
            defaultVisibility: 'org',
            environment: 'production',
            routeId: 'route_conflict',
            hostname: 'docs-2.pages.xd.team',
          }),
        /SITE_SLUG_CONFLICT/,
      );

      const stagingSite = await fixture.store.createSite({
        id: 'site_staging',
        slug: 'docs',
        ownerUserId: 'usr_owner',
        siteUuid: 'uuid_staging',
        defaultVisibility: 'org',
        environment: 'staging',
        routeId: 'route_staging',
        hostname: 'docs-staging.pages.xd.team',
      });
      assert.equal(stagingSite.environment, 'staging');
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: hostname claims conflict across hostname families within an environment`, async () => {
    const fixture = await backend.create();
    try {
      const first = await fixture.store.acquireHostnameClaim({
        environment: 'production',
        hostname: 'portal.workers.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:portal',
        ownerRef: 'pages-portal',
        source: 'v1_deploy',
      });
      const conflict = await fixture.store.acquireHostnameClaim({
        environment: 'production',
        hostname: 'portal.pages.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'pages',
        ownerSystem: 'v2',
        ownerId: 'site_portal',
        ownerRef: 'route_portal',
        source: 'v2_create',
      });
      const staging = await fixture.store.acquireHostnameClaim({
        environment: 'staging',
        hostname: 'portal-staging.pages.xd.team',
        normalizedSlug: 'portal',
        hostnameFamily: 'pages',
        ownerSystem: 'v2',
        ownerId: 'site_portal_staging',
        ownerRef: 'route_portal_staging',
        source: 'v2_create',
      });

      assert.equal(first.ok, true);
      assert.deepEqual(
        { ok: conflict.ok, code: conflict.code, hostnameFamily: conflict.claim.hostnameFamily },
        { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', hostnameFamily: 'workers' },
      );
      assert.equal(staging.ok, true);
      assert.equal(staging.claim.hostnameFamily, 'pages');
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: deployments preserve idempotency, status, and cleanup lifecycle`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      const input = deploymentInput();
      const created = await fixture.store.createDeploymentForIdempotency(input);
      const replay = await fixture.store.createDeploymentForIdempotency({ ...input, id: 'dep_replay' });
      const conflict = await fixture.store.createDeploymentForIdempotency({
        ...input,
        id: 'dep_conflict',
        requestHash: 'sha256:different',
      });

      assert.equal(created.kind, 'created');
      assert.equal(created.deployment.idempotencyScope, 'production:usr_owner:site_1:deploy');
      assert.equal(replay.kind, 'existing');
      assert.equal(replay.deployment.id, 'dep_1');
      assert.equal(conflict.kind, 'conflict');

      const failed = await fixture.store.updateDeployment('dep_1', {
        status: 'failed',
        errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
        completedAt: '2026-07-28T00:01:00.000Z',
      });
      assert.deepEqual(
        { status: failed.status, errorCode: failed.errorCode, completedAt: failed.completedAt },
        {
          status: 'failed',
          errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
          completedAt: '2026-07-28T00:01:00.000Z',
        },
      );

      await fixture.store.createDeploymentResourceCleanupTask({
        id: 'cleanup_1',
        environment: 'production',
        resourceType: 'wfp_user_worker',
        resourceRef: 'pages-v2-docs-old',
        siteId: 'site_1',
        deploymentId: 'dep_1',
        cleanupReason: 'failed_deployment',
        cleanupAfter: '2026-07-28T00:05:00.000Z',
      });
      const running = await fixture.store.markDeploymentResourceCleanupRunning({
        id: 'cleanup_1',
        environment: 'production',
        lockedUntil: '2026-07-28T00:02:00.000Z',
        updatedAt: '2026-07-28T00:01:00.000Z',
      });
      const succeeded = await fixture.store.finishDeploymentResourceCleanupTask({
        id: 'cleanup_1',
        environment: 'production',
        status: 'succeeded',
        updatedAt: '2026-07-28T00:01:30.000Z',
      });

      assert.deepEqual(
        { status: running.status, attemptCount: running.attemptCount, lockedUntil: running.lockedUntil },
        { status: 'running', attemptCount: 1, lockedUntil: '2026-07-28T00:02:00.000Z' },
      );
      assert.deepEqual(
        { status: succeeded.status, attemptCount: succeeded.attemptCount, lockedUntil: succeeded.lockedUntil },
        { status: 'succeeded', attemptCount: 1, lockedUntil: null },
      );
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: owner members and ACL entries support replace, add, remove, and list`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      await fixture.store.transferSiteOwner(
        'site_1',
        {
          ownerType: 'user',
          ownerId: 'usr_next',
          ownerUserId: 'usr_next',
          updatedAt: '2026-07-28T00:01:00.000Z',
        },
        'production',
      );
      assert.deepEqual(
        (await fixture.store.listSiteMembers('site_1')).map(({ userId, role }) => ({ userId, role })),
        [{ userId: 'usr_next', role: 'owner' }],
      );

      await fixture.store.replaceSiteAclEntries(
        'site_1',
        [{ id: 'acl_1', subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' }],
        { createdBy: 'usr_next', updatedAt: '2026-07-28T00:02:00.000Z' },
        'production',
      );
      await fixture.store.addSiteAclEntries(
        'site_1',
        [
          {
            id: 'acl_duplicate',
            subjectType: 'email',
            subjectValue: 'user@example.com',
            accessRole: 'viewer',
            effect: 'allow',
          },
          {
            id: 'acl_2',
            subjectType: 'department',
            subjectValue: '心动/技术平台部',
            accessRole: 'viewer',
            effect: 'allow',
          },
        ],
        { createdBy: 'usr_next', updatedAt: '2026-07-28T00:03:00.000Z' },
        'production',
      );
      await fixture.store.removeSiteAclEntries(
        'site_1',
        [{ subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer', effect: 'allow' }],
        { updatedAt: '2026-07-28T00:04:00.000Z' },
        'production',
      );

      assert.deepEqual(
        (await fixture.store.listSiteAclEntries('site_1')).map(({ id, subjectType, subjectValue }) => ({
          id,
          subjectType,
          subjectValue,
        })),
        [{ id: 'acl_2', subjectType: 'department', subjectValue: '心动/技术平台部' }],
      );
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: vars and secrets snapshot values, bump generation, and serialize provider locks`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      await fixture.store.putSiteSecret({
        id: 'secret_1',
        environment: 'production',
        siteId: 'site_1',
        name: 'API_TOKEN',
        value: 'secret-value',
        actorId: 'usr_owner',
      });
      const mutation = await fixture.store.mutateSiteVar({
        environment: 'production',
        siteId: 'site_1',
        operation: 'put',
        name: 'API_BASE',
        value: 'https://api.example.com',
        actorId: 'usr_owner',
        createId: () => 'var_1',
      });

      assert.equal(mutation.changed, true);
      assert.equal(mutation.generation, 2);
      assert.deepEqual(
        (await fixture.store.listEnabledSiteVars('production', 'site_1')).map(({ name, value, revision }) => ({
          name,
          value,
          revision,
        })),
        [{ name: 'API_BASE', value: 'https://api.example.com', revision: 1 }],
      );
      assert.deepEqual(
        (await fixture.store.listEnabledSiteSecrets('production', 'site_1')).map(({ name, value, revision }) => ({
          name,
          value,
          revision,
        })),
        [{ name: 'API_TOKEN', value: 'secret-value', revision: 1 }],
      );

      const lockedGeneration = await fixture.store.withRuntimeConfigLock('production', 'site_1', async (routeState) => {
        assert.equal(routeState.signal.aborted, false);
        return routeState.runtimeConfigGeneration;
      });
      assert.equal(lockedGeneration, 2);
      assert.equal(
        (await fixture.store.getRouteBySiteId('site_1', 'production')).runtimeConfigGeneration,
        2,
      );
    } finally {
      fixture.dispose();
    }
  });
}

async function createSite(store) {
  return store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_owner',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
}

function deploymentInput() {
  return {
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_owner',
    actorUserId: 'usr_owner',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'sha256:request',
    visibility: 'org',
    status: 'pending',
  };
}

function pickRoute(route) {
  return {
    id: route.id,
    hostname: route.hostname,
    runtime: route.runtime,
    visibility: route.visibility,
    routeStatus: route.routeStatus,
    runtimeConfigGeneration: route.runtimeConfigGeneration,
  };
}

function pickClaim(claim) {
  return {
    hostname: claim.hostname,
    normalizedSlug: claim.normalizedSlug,
    hostnameFamily: claim.hostnameFamily,
    ownerSystem: claim.ownerSystem,
    ownerId: claim.ownerId,
    ownerRef: claim.ownerRef,
    status: claim.status,
  };
}
