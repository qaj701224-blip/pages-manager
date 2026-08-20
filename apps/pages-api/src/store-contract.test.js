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
      let currentNow = NOW;
      const store = createTestPagesStore({ now: () => currentNow });
      return {
        store,
        setNow(value) {
          currentNow = value;
        },
        async setRawSitePolicy(siteId, { defaultExposure, defaultAccessMode } = {}) {
          const site = store.sites.get(siteId);
          if (defaultExposure !== undefined) site.defaultExposure = defaultExposure;
          if (defaultAccessMode !== undefined) site.defaultAccessMode = defaultAccessMode;
        },
        async getRawSitePolicy(siteId) {
          const site = store.sites.get(siteId);
          return {
            defaultVisibility: site.defaultVisibility,
            defaultExposure: site.defaultExposure,
            defaultAccessMode: site.defaultAccessMode,
          };
        },
        async setRawRoutePolicy(siteId, { exposure, accessMode, visibility } = {}) {
          const route = store.routes.get(store.routeBySiteId.get(siteId));
          if (exposure !== undefined) route.exposure = exposure;
          if (accessMode !== undefined) route.accessMode = accessMode;
          if (visibility !== undefined) route.visibility = visibility;
        },
        async getRawRoutePolicy(siteId) {
          const route = store.routes.get(store.routeBySiteId.get(siteId));
          return {
            visibility: route.visibility,
            exposure: route.exposure,
            accessMode: route.accessMode,
          };
        },
        dispose() {},
      };
    },
  },
  {
    name: 'D1PagesStore',
    async create() {
      let currentNow = NOW;
      const db = createD1TestDatabase();
      await db.exec(createSchemaSql().join(';\n'));
      return {
        store: new D1PagesStore(db, {
          now: () => currentNow,
          secretEncryptionKey: 'store-contract-test-encryption-key',
        }),
        setNow(value) {
          currentNow = value;
        },
        async setRawSitePolicy(siteId, { defaultExposure, defaultAccessMode } = {}) {
          const updates = [];
          const values = [];
          if (defaultExposure !== undefined) {
            updates.push('default_exposure = ?');
            values.push(defaultExposure);
          }
          if (defaultAccessMode !== undefined) {
            updates.push('default_access_mode = ?');
            values.push(defaultAccessMode);
          }
          if (updates.length > 0) {
            await db.prepare(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`).bind(...values, siteId).run();
          }
        },
        async getRawSitePolicy(siteId) {
          const row = await db
            .prepare('SELECT default_visibility, default_exposure, default_access_mode FROM sites WHERE id = ?')
            .bind(siteId)
            .first();
          return {
            defaultVisibility: row.default_visibility,
            defaultExposure: row.default_exposure,
            defaultAccessMode: row.default_access_mode,
          };
        },
        async setRawRoutePolicy(siteId, { exposure, accessMode, visibility } = {}) {
          const updates = [];
          const values = [];
          if (exposure !== undefined) {
            updates.push('exposure = ?');
            values.push(exposure);
          }
          if (accessMode !== undefined) {
            updates.push('access_mode = ?');
            values.push(accessMode);
          }
          if (visibility !== undefined) {
            updates.push('visibility = ?');
            values.push(visibility);
          }
          if (updates.length > 0) {
            await db.prepare(`UPDATE site_routes SET ${updates.join(', ')} WHERE site_id = ?`).bind(...values, siteId).run();
          }
        },
        async getRawRoutePolicy(siteId) {
          const row = await db
            .prepare('SELECT visibility, exposure, access_mode FROM site_routes WHERE site_id = ?')
            .bind(siteId)
            .first();
          return {
            visibility: row.visibility,
            exposure: row.exposure,
            accessMode: row.access_mode,
          };
        },
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

test('site stores atomically convert an active v1 claim into a v2 site', async () => {
  for (const backend of storeBackends) {
    const { store, dispose } = await backend.create();
    try {
      await store.acquireHostnameClaim({
        environment: 'production',
        hostname: 'guide.workers.xd.team',
        normalizedSlug: 'guide',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:guide',
        ownerRef: 'pages-guide',
        source: 'backfill_v1_sites',
      });
      const expectedClaim = await store.getHostnameClaim('guide.workers.xd.team');

      const site = await store.createSiteByTakingOverV1Claim(
        {
          id: 'site_1',
          slug: 'guide',
          ownerType: 'user',
          ownerId: 'usr_1',
          ownerUserId: 'usr_1',
          siteUuid: 'uuid_1',
          defaultVisibility: 'org',
          environment: 'production',
          routeId: 'route_1',
          hostname: 'guide.workers.xd.team',
          auditEvent: {
            id: 'audit_1',
            environment: 'production',
            eventType: 'site.v1_takeover',
            actorUserId: 'usr_1',
            actorType: 'user',
            siteId: 'site_1',
            routeId: 'route_1',
            versionId: null,
            decision: 'allow',
            statusCode: 201,
            traceId: null,
            ipHash: null,
            userAgentHash: null,
            metadata: { source: 'v1_email_takeover', previousOwnerSystem: 'v1' },
            createdAt: NOW,
          },
        },
        expectedClaim,
        'production'
      );

      assert.equal(site.id, 'site_1');
      const claim = await store.getHostnameClaim('guide.workers.xd.team');
      assert.equal(claim.ownerSystem, 'v2');
      assert.equal(claim.ownerId, 'site_1');
      assert.equal(claim.source, 'v1_email_takeover');
      assert.equal((await store.getRouteBySiteId('site_1')).hostname, 'guide.workers.xd.team');
      assert.equal((await store.listSiteMembers('site_1'))[0].role, 'owner');
      assert.equal((await store.listAuditEvents({ environment: 'production' })).some((event) => event.id === 'audit_1'), true);
    } finally {
      dispose();
    }
  }
});

test('site stores reject stale v1 claim snapshots without partial takeover state', async () => {
  for (const backend of storeBackends) {
    const { store, dispose } = await backend.create();
    try {
      await store.acquireHostnameClaim({
        environment: 'production',
        hostname: 'guide.workers.xd.team',
        normalizedSlug: 'guide',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:guide',
        ownerRef: 'pages-guide',
        source: 'backfill_v1_sites',
      });
      const expectedClaim = await store.getHostnameClaim('guide.workers.xd.team');
      await store.releaseHostnameClaim({
        ...expectedClaim,
        reuseHoldUntil: NOW,
        releaseReason: 'test_state_change',
      });

      await assert.rejects(
        () =>
          store.createSiteByTakingOverV1Claim(
            {
              id: 'site_1',
              slug: 'guide',
              ownerType: 'user',
              ownerId: 'usr_1',
              ownerUserId: 'usr_1',
              siteUuid: 'uuid_1',
              defaultVisibility: 'org',
              environment: 'production',
              routeId: 'route_1',
              hostname: 'guide.workers.xd.team',
            },
            expectedClaim,
            'production'
          ),
        { code: 'V1_TAKEOVER_STATE_CHANGED' }
      );
      assert.equal(await store.getSite('site_1'), null);
      assert.equal(await store.getRouteBySiteId('site_1'), null);
    } finally {
      dispose();
    }
  }
});

for (const backend of storeBackends) {
  test(`${backend.name} contract: resolves the current public exposure reason from successful operations`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      await fixture.store.recordAuditEvent(
        exposureReasonAudit(
          'op_fallback:policy_committed',
          'policy_committed',
          'fallback 理由',
          '2026-08-10T02:00:00.000Z'
        )
      );
      assert.equal(
        await fixture.store.getLatestAdminSitePublicExposureReason({
          environment: 'production',
          siteId: 'site_1',
          currentExposure: 'public',
        }),
        null
      );
      await fixture.store.recordAuditEvent(
        exposureReasonAudit(
          'op_old:effective_success',
          'effective_success',
          '旧理由',
          '2026-08-10T01:00:00.000Z',
          { effectiveExposure: 'public' }
        )
      );
      await fixture.store.recordAuditEvent(
        exposureReasonAudit('op_failed:attempted', 'attempted', '失败尝试', '2026-08-10T03:00:00.000Z')
      );
      await fixture.store.recordAuditEvent(
        exposureReasonAudit('op_failed:failed', 'failed', '失败尝试', '2026-08-10T03:00:01.000Z', {
          decision: 'deny',
          statusCode: 503,
        })
      );
      await fixture.store.recordAuditEvent(
        exposureReasonAudit(
          'op_compensated:policy_committed',
          'policy_committed',
          '补偿尝试',
          '2026-08-10T04:00:00.000Z'
        )
      );
      await fixture.store.recordAuditEvent(
        exposureReasonAudit(
          'op_compensated:compensated_failure',
          'compensated_failure',
          '补偿尝试',
          '2026-08-10T04:00:01.000Z',
          {
            decision: 'deny',
            statusCode: 503,
          }
        )
      );

      assert.deepEqual(
        await fixture.store.getLatestAdminSitePublicExposureReason({
          environment: 'production',
          siteId: 'site_1',
          currentExposure: 'public',
        }),
        { text: '旧理由', changedAt: '2026-08-10T01:00:00.000Z' }
      );

      await fixture.store.recordAuditEvent(
        exposureReasonAudit('op_tie_a:effective_success', 'effective_success', '并列 A', '2026-08-10T05:00:00.000Z', {
          effectiveExposure: 'public',
        })
      );
      await fixture.store.recordAuditEvent(
        exposureReasonAudit('op_tie_z:effective_success', 'effective_success', '并列 Z', '2026-08-10T05:00:00.000Z', {
          effectiveExposure: 'public',
        })
      );
      assert.deepEqual(
        await fixture.store.getLatestAdminSitePublicExposureReason({
          environment: 'production',
          siteId: 'site_1',
          currentExposure: 'public',
        }),
        { text: '并列 Z', changedAt: '2026-08-10T05:00:00.000Z' }
      );

      assert.equal(
        await fixture.store.getLatestAdminSitePublicExposureReason({
          environment: 'production',
          siteId: 'site_1',
          currentExposure: 'internal',
        }),
        null
      );
    } finally {
      fixture.dispose();
    }
  });

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
          defaultExposure: site.defaultExposure,
          defaultAccessMode: site.defaultAccessMode,
        },
        {
          id: 'site_1',
          ownerType: 'user',
          ownerId: 'usr_owner',
          ownerUserId: 'usr_owner',
          environment: 'production',
          defaultExposure: 'internal',
          defaultAccessMode: 'org',
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
          exposure: 'internal',
          accessMode: 'org',
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

  test(`${backend.name} contract: legacy visibility writes preserve exposure and dual-write canonical access mode`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      await fixture.setRawSitePolicy('site_1', { defaultExposure: 'public' });
      await fixture.setRawRoutePolicy('site_1', { exposure: 'public' });

      const visibilityRoute = await fixture.store.updateSiteVisibility(
        'site_1',
        { visibility: 'internal', updatedAt: '2026-07-28T00:01:00.000Z' },
        'production',
      );
      assert.deepEqual(
        {
          visibility: visibilityRoute.visibility,
          exposure: visibilityRoute.exposure,
          accessMode: visibilityRoute.accessMode,
        },
        { visibility: 'internal', exposure: 'public', accessMode: 'anonymous' },
      );
      assert.deepEqual(await fixture.getRawRoutePolicy('site_1'), {
        visibility: 'internal',
        exposure: 'public',
        accessMode: 'anonymous',
      });
      assert.deepEqual(
        {
          defaultVisibility: (await fixture.store.getSite('site_1')).defaultVisibility,
          defaultExposure: (await fixture.store.getSite('site_1')).defaultExposure,
          defaultAccessMode: (await fixture.store.getSite('site_1')).defaultAccessMode,
        },
        { defaultVisibility: 'internal', defaultExposure: 'public', defaultAccessMode: 'anonymous' },
      );
      assert.deepEqual(await fixture.getRawSitePolicy('site_1'), {
        defaultVisibility: 'internal',
        defaultExposure: 'public',
        defaultAccessMode: 'anonymous',
      });

      await fixture.store.transferSiteOwner(
        'site_1',
        {
          ownerType: 'user',
          ownerId: 'usr_next',
          ownerUserId: 'usr_next',
          defaultVisibility: 'owner',
          updatedAt: '2026-07-28T00:02:00.000Z',
        },
        'production',
      );
      assert.deepEqual(
        {
          defaultVisibility: (await fixture.store.getSite('site_1')).defaultVisibility,
          defaultExposure: (await fixture.store.getSite('site_1')).defaultExposure,
          defaultAccessMode: (await fixture.store.getSite('site_1')).defaultAccessMode,
        },
        { defaultVisibility: 'owner', defaultExposure: 'public', defaultAccessMode: 'owner' },
      );
      assert.deepEqual(await fixture.getRawSitePolicy('site_1'), {
        defaultVisibility: 'owner',
        defaultExposure: 'public',
        defaultAccessMode: 'owner',
      });

      const activated = await fixture.store.activateSiteVersion(
        'site_1',
        {
          activeVersionId: 'ver_1',
          workerName: 'pages-v2-docs-ver-1',
          visibility: 'acl',
          updatedAt: '2026-07-28T00:03:00.000Z',
        },
        'production',
      );
      assert.deepEqual(
        {
          visibility: activated.visibility,
          exposure: activated.exposure,
          accessMode: activated.accessMode,
          cacheTier: activated.cacheTier,
        },
        { visibility: 'acl', exposure: 'public', accessMode: 'acl', cacheTier: 'sensitive' },
      );
      assert.deepEqual(await fixture.getRawRoutePolicy('site_1'), {
        visibility: 'acl',
        exposure: 'public',
        accessMode: 'acl',
      });
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: unknown legacy visibility remains fail closed during compatibility reads`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      await fixture.setRawRoutePolicy('site_1', {
        exposure: 'public',
        accessMode: 'org',
        visibility: 'public',
      });

      const route = await fixture.store.getRouteBySiteId('site_1', 'production');
      assert.deepEqual(
        { visibility: route.visibility, exposure: route.exposure, accessMode: route.accessMode },
        { visibility: 'public', exposure: 'public', accessMode: null },
      );
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: activation fences exposure drift and expired policy leases`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      const lease = await fixture.store.acquireSiteCommitLock('production', 'site_1', {
        lockId: 'policy_activation_lock',
      });
      const initialRoute = await fixture.store.getRouteBySiteId('site_1', 'production');
      const expected = {
        activeVersionId: initialRoute.activeVersionId,
        policyVersion: initialRoute.policyVersion,
        routeGeneration: initialRoute.routeGeneration,
        runtimeConfigGeneration: initialRoute.runtimeConfigGeneration,
        exposure: initialRoute.exposure,
      };

      assert.equal(
        await fixture.store.activateSiteVersion(
          'site_1',
          { activeVersionId: 'ver_1', workerName: 'worker_1', visibility: 'org', updatedAt: NOW, lease },
          'production',
          { ...expected, exposure: 'public' },
        ),
        null,
      );

      const activated = await fixture.store.activateSiteVersion(
        'site_1',
        { activeVersionId: 'ver_1', workerName: 'worker_1', visibility: 'org', updatedAt: NOW, lease },
        'production',
        expected,
      );
      assert.equal(activated.activeVersionId, 'ver_1');

      await fixture.store.releaseSiteCommitLock('production', 'site_1', lease.lockId);
      await assert.rejects(
        () =>
          fixture.store.activateSiteVersion(
            'site_1',
            { activeVersionId: 'ver_2', workerName: 'worker_2', visibility: 'org', updatedAt: NOW, lease },
            'production',
            { ...expected, activeVersionId: 'ver_1', routeGeneration: activated.routeGeneration },
          ),
        /SITE_POLICY_CONFLICT/,
      );
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: site commit leases fence stale holders without resetting tokens`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);

      const first = await fixture.store.acquireSiteCommitLock('production', 'site_1', {
        lockId: 'policy_lock_1',
      });
      assert.deepEqual(
        { lockId: first.lockId, fencingToken: first.fencingToken },
        { lockId: 'policy_lock_1', fencingToken: 1 },
      );

      fixture.setNow('2026-07-28T00:00:30.000Z');
      assert.equal(
        await fixture.store.acquireSiteCommitLock('production', 'site_1', { lockId: 'policy_lock_blocked' }),
        null,
      );
      const renewed = await fixture.store.renewSiteCommitLock('production', 'site_1', first.lockId, {
        fencingToken: first.fencingToken,
      });
      assert.equal(renewed.fencingToken, first.fencingToken);

      fixture.setNow('2026-07-28T00:01:31.000Z');
      const second = await fixture.store.acquireSiteCommitLock('production', 'site_1', {
        lockId: 'policy_lock_2',
      });
      assert.deepEqual(
        { lockId: second.lockId, fencingToken: second.fencingToken },
        { lockId: 'policy_lock_2', fencingToken: 2 },
      );
      assert.equal(
        await fixture.store.renewSiteCommitLock('production', 'site_1', first.lockId, {
          fencingToken: first.fencingToken,
        }),
        null,
      );
      assert.equal(await fixture.store.releaseSiteCommitLock('production', 'site_1', first.lockId), false);

      fixture.setNow('2026-07-28T00:01:32.000Z');
      const secondRenewal = await fixture.store.renewSiteCommitLock('production', 'site_1', second.lockId, {
        fencingToken: second.fencingToken,
      });
      assert.equal(secondRenewal.fencingToken, 2);
      assert.equal(await fixture.store.releaseSiteCommitLock('production', 'site_1', second.lockId), true);
      assert.equal((await fixture.store.getSiteCommitLock('production', 'site_1')).fencingToken, 2);

      const third = await fixture.store.acquireSiteCommitLock('production', 'site_1', {
        lockId: 'policy_lock_3',
      });
      assert.equal(third.fencingToken, 3);
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: site commit lock can preserve callback results when release fails`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      const originalRelease = fixture.store.releaseSiteCommitLock.bind(fixture.store);
      fixture.store.releaseSiteCommitLock = async () => {
        throw new Error('release failed');
      };

      const result = await fixture.store.withSiteCommitLock(
        'production',
        'site_1',
        async () => 'committed',
        { lockId: 'policy_lock_best_effort_release', bestEffortRelease: true }
      );

      assert.equal(result, 'committed');
      fixture.store.releaseSiteCommitLock = originalRelease;
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: unified policy mutation preserves independent fields and rejects stale writers`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      const lease = await fixture.store.acquireSiteCommitLock('production', 'site_1', {
        lockId: 'policy_lock_1',
      });
      const initialRoute = await fixture.store.getRouteBySiteId('site_1', 'production');

      const exposed = await fixture.store.updateSiteAccessPolicy({
        environment: 'production',
        siteId: 'site_1',
        actorUserId: 'usr_admin',
        exposure: 'public',
        expected: policyExpected(initialRoute),
        lease,
        auditEvent: policyAudit('audit_policy_1', 'usr_admin', 'public'),
        updatedAt: '2026-07-28T00:00:10.000Z',
      });
      assert.equal(exposed.changed, true);
      assert.deepEqual(
        {
          exposure: exposed.route.exposure,
          accessMode: exposed.route.accessMode,
          visibility: exposed.route.visibility,
          policyVersion: exposed.route.policyVersion,
        },
        { exposure: 'public', accessMode: 'org', visibility: 'org', policyVersion: 2 },
      );

      const aclEntries = [
        {
          id: 'acl_1',
          subjectType: 'email',
          subjectValue: 'reader@example.com',
          accessRole: 'viewer',
          effect: 'allow',
        },
      ];
      const anonymous = await fixture.store.updateSiteAccessPolicy({
        environment: 'production',
        siteId: 'site_1',
        actorUserId: 'usr_owner',
        accessMode: 'anonymous',
        aclEntries,
        expected: policyExpected(exposed.route),
        lease,
        auditEvent: policyAudit('audit_policy_2', 'usr_owner', 'public'),
        updatedAt: '2026-07-28T00:00:20.000Z',
      });
      assert.deepEqual(
        {
          exposure: anonymous.route.exposure,
          accessMode: anonymous.route.accessMode,
          visibility: anonymous.route.visibility,
          policyVersion: anonymous.route.policyVersion,
          acl: anonymous.aclEntries.map(({ subjectType, subjectValue }) => ({ subjectType, subjectValue })),
        },
        {
          exposure: 'public',
          accessMode: 'anonymous',
          visibility: 'internal',
          policyVersion: 3,
          acl: [{ subjectType: 'email', subjectValue: 'reader@example.com' }],
        },
      );
      assert.deepEqual(await fixture.getRawSitePolicy('site_1'), {
        defaultVisibility: 'internal',
        defaultExposure: 'public',
        defaultAccessMode: 'anonymous',
      });
      assert.deepEqual(await fixture.getRawRoutePolicy('site_1'), {
        visibility: 'internal',
        exposure: 'public',
        accessMode: 'anonymous',
      });

      await assert.rejects(
        fixture.store.updateSiteAccessPolicy({
          environment: 'production',
          siteId: 'site_1',
          actorUserId: 'usr_owner',
          accessMode: 'owner',
          expected: policyExpected(initialRoute),
          lease,
          updatedAt: '2026-07-28T00:00:30.000Z',
        }),
        /SITE_POLICY_CONFLICT/,
      );

      assert.equal(await fixture.store.releaseSiteCommitLock('production', 'site_1', lease.lockId), true);
      fixture.setNow('2026-07-28T00:00:31.000Z');
      const nextLease = await fixture.store.acquireSiteCommitLock('production', 'site_1', {
        lockId: 'policy_lock_2',
      });
      await assert.rejects(
        fixture.store.updateSiteAccessPolicy({
          environment: 'production',
          siteId: 'site_1',
          actorUserId: 'usr_owner',
          accessMode: 'owner',
          expected: policyExpected(anonymous.route),
          lease,
          updatedAt: '2026-07-28T00:00:31.000Z',
        }),
        /SITE_POLICY_CONFLICT/,
      );

      const sameValue = await fixture.store.updateSiteAccessPolicy({
        environment: 'production',
        siteId: 'site_1',
        actorUserId: 'usr_owner',
        exposure: 'public',
        accessMode: 'anonymous',
        aclEntries,
        expected: policyExpected(anonymous.route),
        lease: nextLease,
        updatedAt: '2026-07-28T00:00:31.000Z',
      });
      assert.equal(sameValue.changed, false);
      assert.equal(sameValue.route.policyVersion, 3);
      assert.equal((await fixture.store.listAuditEvents({ environment: 'production' })).length, 2);
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
      assert.equal(created.deployment.traceId, 'dtr_1');
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

      await fixture.store.createDeploymentEvent({
        id: 'dpe_later',
        environment: 'production',
        traceId: 'dtr_1',
        inboundRayId: 'ray-1-SIN',
        deploymentId: 'dep_1',
        siteId: 'site_1',
        attempt: 1,
        stage: 'provider_upload',
        operation: 'worker_put',
        status: 'succeeded',
        startedAt: '2026-07-28T00:00:02.000Z',
        completedAt: '2026-07-28T00:00:02.025Z',
        durationMs: 25,
        diagnostics: { providerRequestId: 'provider-ray-1' },
        createdAt: '2026-07-28T00:00:02.025Z',
      });
      for (const [id, createdAt] of [
        ['dpe_same_time_b', '2026-07-28T00:00:02.030Z'],
        ['dpe_same_time_a', '2026-07-28T00:00:02.030Z'],
        ['dpe_created_later', '2026-07-28T00:00:02.040Z'],
      ]) {
        await fixture.store.createDeploymentEvent({
          id,
          environment: 'production',
          traceId: 'dtr_1',
          deploymentId: 'dep_1',
          siteId: 'site_1',
          attempt: 1,
          stage: 'provider_verify',
          operation: 'worker_get',
          status: 'succeeded',
          startedAt: '2026-07-28T00:00:02.000Z',
          completedAt: createdAt,
          durationMs: 30,
          createdAt,
        });
      }
      await fixture.store.createDeploymentEvent({
        id: 'dpe_intake',
        environment: 'production',
        traceId: 'dtr_1',
        inboundRayId: 'ray-1-SIN',
        deploymentId: null,
        siteId: null,
        attempt: 1,
        stage: 'intake',
        operation: 'parse_multipart',
        status: 'failed',
        startedAt: '2026-07-28T00:00:01.000Z',
        completedAt: '2026-07-28T00:00:01.010Z',
        durationMs: 10,
        errorCode: 'INVALID_MULTIPART',
        errorMessage: 'Invalid multipart body.',
        diagnostics: { causeClass: 'payload_validation_error' },
        createdAt: '2026-07-28T00:00:01.010Z',
      });

      const byTrace = await fixture.store.listDeploymentEvents({
        environment: 'production',
        traceId: 'dtr_1',
      });
      const byDeployment = await fixture.store.listDeploymentEvents({
        environment: 'production',
        deploymentId: 'dep_1',
      });
      assert.deepEqual(
        byTrace.map((event) => event.id),
        ['dpe_intake', 'dpe_later', 'dpe_same_time_a', 'dpe_same_time_b', 'dpe_created_later'],
      );
      assert.deepEqual(
        byDeployment.map((event) => event.id),
        ['dpe_later', 'dpe_same_time_a', 'dpe_same_time_b', 'dpe_created_later'],
      );
      assert.deepEqual(byTrace[0], {
        id: 'dpe_intake',
        environment: 'production',
        traceId: 'dtr_1',
        inboundRayId: 'ray-1-SIN',
        deploymentId: null,
        siteId: null,
        attempt: 1,
        stage: 'intake',
        operation: 'parse_multipart',
        status: 'failed',
        startedAt: '2026-07-28T00:00:01.000Z',
        completedAt: '2026-07-28T00:00:01.010Z',
        durationMs: 10,
        errorCode: 'INVALID_MULTIPART',
        errorMessage: 'Invalid multipart body.',
        diagnostics: { causeClass: 'payload_validation_error' },
        createdAt: '2026-07-28T00:00:01.010Z',
      });
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

  test(`${backend.name} contract: overlapping runtime config locks fail fast and allow retry after release`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      const order = [];
      let releaseFirst;
      let markFirstStarted;
      const firstStarted = new Promise((resolve) => {
        markFirstStarted = resolve;
      });
      const firstCanFinish = new Promise((resolve) => {
        releaseFirst = resolve;
      });

      const first = fixture.store.withRuntimeConfigLock('production', 'site_1', async () => {
        order.push('first:start');
        markFirstStarted();
        await firstCanFinish;
        order.push('first:end');
      });
      await firstStarted;

      let overlappingCallbackRan = false;
      await assert.rejects(
        fixture.store.withRuntimeConfigLock('production', 'site_1', async () => {
          overlappingCallbackRan = true;
        }),
        /RUNTIME_CONFIG_LOCKED/,
      );
      assert.equal(overlappingCallbackRan, false);
      assert.deepEqual(order, ['first:start']);

      releaseFirst();
      await first;
      await fixture.store.withRuntimeConfigLock('production', 'site_1', async () => {
        order.push('retry');
      });
      assert.deepEqual(order, ['first:start', 'first:end', 'retry']);
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: runtime config lock releases after callback failure`, async () => {
    const fixture = await backend.create();
    try {
      await createSite(fixture.store);
      await assert.rejects(
        fixture.store.withRuntimeConfigLock('production', 'site_1', async () => {
          throw new Error('provider failed');
        }),
        /provider failed/,
      );

      let acquiredAfterFailure = false;
      await fixture.store.withRuntimeConfigLock('production', 'site_1', async () => {
        acquiredAfterFailure = true;
      });
      assert.equal(acquiredAfterFailure, true);
    } finally {
      fixture.dispose();
    }
  });

  test(`${backend.name} contract: cindy membership id lookup, bind, and uniqueness`, async () => {
    const fixture = await backend.create();
    try {
      const { store } = fixture;
      await store.createUser({
        userId: 'usr_bound',
        email: 'bound@example.com',
        employeeStatus: 'active',
        cindyMembershipId: 'mem_bound',
      });
      await store.createUser({ userId: 'usr_plain', email: 'plain@example.com', employeeStatus: 'active' });

      assert.equal((await store.getUserByCindyMembershipId('mem_bound'))?.id, 'usr_bound');
      assert.equal(await store.getUserByCindyMembershipId('mem_missing'), null);
      assert.equal(await store.getUserByCindyMembershipId(''), null);

      assert.equal(await store.bindUserCindyMembershipId('usr_plain', 'mem_bound'), false);
      assert.equal(await store.bindUserCindyMembershipId('usr_plain', 'mem_plain'), true);
      assert.equal(await store.bindUserCindyMembershipId('usr_plain', 'mem_plain'), true);
      assert.equal(await store.bindUserCindyMembershipId('usr_plain', 'mem_other'), false);
      assert.equal((await store.getUserByCindyMembershipId('mem_plain'))?.id, 'usr_plain');

      await assert.rejects(
        () =>
          store.createUser({
            userId: 'usr_dup',
            email: 'dup@example.com',
            employeeStatus: 'active',
            cindyMembershipId: 'mem_bound',
          }),
        (error) => /USER_CINDY_MEMBERSHIP_CONFLICT|UNIQUE constraint failed/.test(String(error?.message || '')),
      );

      const upserted = await store.upsertUserFromSso({
        userId: 'usr_plain',
        email: 'plain@example.com',
        employeeStatus: 'active',
        sessionVersion: 1,
      });
      assert.equal(upserted.cindyMembershipId, 'mem_plain');
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

function exposureReasonAudit(id, stage, reason, createdAt, overrides = {}) {
  return {
    id,
    environment: 'production',
    eventType: 'admin.site.exposure',
    siteId: 'site_1',
    actorType: 'platform_admin',
    decision: overrides.decision || 'allow',
    statusCode: overrides.statusCode || (stage === 'attempted' ? 202 : 200),
    metadata: {
      operationId: id.split(':')[0],
      requestedExposure: 'public',
      authorityExposure: stage === 'policy_committed' ? 'public' : null,
      effectiveExposure: overrides.effectiveExposure || null,
      stage,
      reason,
    },
    createdAt,
  };
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
    traceId: 'dtr_1',
    visibility: 'org',
    status: 'pending',
  };
}

function policyExpected(route) {
  return {
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    activeVersionId: route.activeVersionId,
    runtimeConfigGeneration: route.runtimeConfigGeneration,
  };
}

function policyAudit(id, actorUserId, requestedExposure) {
  return {
    id,
    environment: 'production',
    eventType: 'site.policy_committed',
    actorUserId,
    actorType: 'user',
    siteId: 'site_1',
    routeId: 'route_1',
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    traceId: null,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      stage: 'policy_committed',
      activationState: 'pending_activation',
      requestedExposure,
    },
    createdAt: NOW,
  };
}

function pickRoute(route) {
  return {
    id: route.id,
    hostname: route.hostname,
    runtime: route.runtime,
    visibility: route.visibility,
    exposure: route.exposure,
    accessMode: route.accessMode,
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
