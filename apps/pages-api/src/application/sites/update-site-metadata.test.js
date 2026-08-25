import assert from 'node:assert/strict';
import test from 'node:test';

import { createReconcileSiteMetadataRouting, createUpdateSiteMetadata } from './update-site-metadata.js';

test('title-only metadata update commits normalized title without touching route snapshots', async () => {
  const calls = [];
  const currentSite = site();
  const currentRoute = route();
  const update = createUpdateSiteMetadata({
    siteMetadata: metadataPort({
      getSiteForUser: async () => currentSite,
      getRouteBySiteId: async () => currentRoute,
      commitSiteMetadata: async (input) => {
        calls.push(['commit', input]);
        return {
          changed: true,
          titleChanged: true,
          slugChanged: false,
          site: { ...currentSite, title: 'Café docs' },
          route: currentRoute,
          retiringClaims: [],
        };
      },
    }),
    routeSnapshots: snapshotPort({
      repairCurrent: async () => assert.fail('title-only update must not repair routing'),
    }),
    hostnameForSlug: (slug) => `${slug}.pages.xd.team`,
    ids: { next: () => 'audit_1' },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  const result = await update({
    environment: 'production',
    siteId: 'site_1',
    actor: { type: 'user', userId: 'usr_1' },
    source: 'api',
    patch: { title: '  Cafe\u0301 docs  ' },
  });

  assert.equal(result.routingStatus, 'ready');
  assert.equal(result.site.title, 'Café docs');
  assert.equal(calls[0][1].title, 'Café docs');
  assert.equal(Object.hasOwn(calls[0][1], 'slug'), false);
  assert.deepEqual(calls[0][1].expected, expected(currentSite, currentRoute));
  assert.deepEqual(calls[0][1].auditEvent.metadata, {
    changedFields: ['title'],
    oldSlug: 'docs',
    newSlug: 'docs',
    titleCleared: false,
    source: 'api',
    slugRevision: 1,
  });
});

test('metadata update rejects a team deactivated after the site read before committing', async () => {
  const calls = [];
  const currentSite = site({
    ownerType: 'team',
    ownerId: 'team_1',
    ownerUserId: 'usr_owner',
    managementRole: 'publisher',
  });
  const update = createUpdateSiteMetadata({
    siteMetadata: metadataPort({
      async withSiteCommitLock(_environment, _siteId, callback) {
        calls.push('lock');
        return callback(siteCommitLease('lock_1', 2));
      },
      async getSiteForUser() {
        calls.push('site');
        return currentSite;
      },
      async getTeam() {
        calls.push('team');
        return null;
      },
      async getRouteBySiteId() {
        assert.fail('route must not be read after the team becomes inactive');
      },
      async commitSiteMetadata() {
        assert.fail('metadata must not commit after the team becomes inactive');
      },
    }),
    routeSnapshots: snapshotPort({
      repairCurrent: async () => assert.fail('route snapshots must not change after the team becomes inactive'),
    }),
    hostnameForSlug: (slug) => `${slug}.pages.xd.team`,
    ids: { next: () => 'audit_1' },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    update({
      environment: 'production',
      siteId: currentSite.id,
      actor: { type: 'user', userId: 'usr_owner' },
      patch: { title: 'Must not commit' },
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.deepEqual(calls, ['lock', 'site', 'team']);
});

test('slug rename confirms canonical, clears the old pointer, and starts the reuse hold before marking ready', async () => {
  const calls = [];
  const currentSite = site();
  const currentRoute = route();
  const renamedSite = site({ slug: 'guides', slugRevision: 2, slugRoutingSyncedRevision: 1 });
  const renamedRoute = route({ hostname: 'guides.pages.xd.team', routeGeneration: 3 });
  const claim = {
    id: 'claim_1',
    ownerSystem: 'v2',
    ownerId: 'site_1',
    ownerRef: 'route_1',
    environment: 'production',
    hostname: 'docs.pages.xd.team',
    status: 'held',
    releaseReason: 'site_slug_renamed_pending_cleanup',
    releasedAt: '2027-01-15T08:00:00.000Z',
    reuseHoldUntil: null,
  };
  const update = createUpdateSiteMetadata({
    siteMetadata: metadataPort({
      getSiteForUser: async () => currentSite,
      getRouteBySiteId: async () => currentRoute,
      commitSiteMetadata: async (input) => {
        calls.push(['commit', input]);
        return {
          changed: true,
          titleChanged: false,
          slugChanged: true,
          site: renamedSite,
          route: renamedRoute,
          retiringClaims: [claim],
        };
      },
      completeSiteSlugRelease: async (input) => {
        calls.push(['release', input]);
        return { ...claim, releaseReason: 'site_slug_renamed', reuseHoldUntil: input.reuseHoldUntil };
      },
      markSiteSlugRoutingSynced: async (input) => {
        calls.push(['markSite', input]);
        return { ...renamedSite, slugRoutingSyncedRevision: 2 };
      },
    }),
    routeSnapshots: snapshotPort({
      repairCurrent: async (input) => calls.push(['canonical', input]),
      clearRetired: async (input) => {
        calls.push(['clear', input]);
        return true;
      },
    }),
    hostnameForSlug: (slug) => `${slug}.pages.xd.team`,
    ids: { next: () => 'audit_1' },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  const result = await update({
    environment: 'production',
    siteId: 'site_1',
    actor: { type: 'access_key', userId: 'usr_1', scopes: ['deploy:site'] },
    source: 'api',
    patch: { slug: ' Guides ' },
  });

  assert.equal(result.routingStatus, 'ready');
  assert.equal(result.site.slugRoutingSyncedRevision, 2);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['commit', 'canonical', 'clear', 'release', 'markSite']
  );
  assert.equal(calls[0][1].hostname, 'guides.pages.xd.team');
  assert.equal(calls[2][1].claim, claim);
  assert.equal(calls[3][1].slugRevision, 2);
  assert.equal(calls[3][1].cleanupToken, claim.releasedAt);
  assert.equal(calls[3][1].reuseHoldUntil, '2027-01-15T08:05:00.000Z');
  assert.deepEqual(calls[3][1].lease, siteCommitLease('lock_1', 2));
});

test('partial route repair returns pending and a same-slug retry can finish it', async () => {
  const pendingSite = site({ slug: 'guides', slugRevision: 2, slugRoutingSyncedRevision: 1 });
  const currentRoute = route({ hostname: 'guides.pages.xd.team', routeGeneration: 3 });
  const claim = {
    id: 'claim_1',
    ownerSystem: 'v2',
    ownerId: 'site_1',
    ownerRef: 'route_1',
    environment: 'production',
    hostname: 'docs.pages.xd.team',
    status: 'held',
    releaseReason: 'site_slug_renamed_pending_cleanup',
    releasedAt: '2027-01-15T08:00:00.000Z',
    reuseHoldUntil: null,
  };
  let failClear = true;
  const port = metadataPort({
    getSiteForUser: async () => pendingSite,
    getRouteBySiteId: async () => currentRoute,
    commitSiteMetadata: async () => ({
      changed: false,
      titleChanged: false,
      slugChanged: false,
      site: pendingSite,
      route: currentRoute,
      retiringClaims: [claim],
    }),
    completeSiteSlugRelease: async () => ({ ...claim, releaseReason: 'site_slug_renamed' }),
    markSiteSlugRoutingSynced: async () => ({ ...pendingSite, slugRoutingSyncedRevision: 2 }),
  });
  const update = createUpdateSiteMetadata({
    siteMetadata: port,
    routeSnapshots: snapshotPort({
      clearRetired: async () => {
        if (failClear) throw new Error('route KV unavailable');
        return true;
      },
    }),
    hostnameForSlug: (slug) => `${slug}.pages.xd.team`,
    ids: { next: () => 'audit_1' },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  const pending = await update({
    environment: 'production',
    siteId: 'site_1',
    actor: { type: 'user', userId: 'usr_1' },
    patch: { slug: 'guides' },
  });
  assert.equal(pending.routingStatus, 'pending');

  failClear = false;
  const ready = await update({
    environment: 'production',
    siteId: 'site_1',
    actor: { type: 'user', userId: 'usr_1' },
    patch: { slug: 'guides' },
  });
  assert.equal(ready.routingStatus, 'ready');
});

test('site commit lease conflicts are exposed as metadata conflicts', async () => {
  const update = createUpdateSiteMetadata({
    siteMetadata: metadataPort({
      async withSiteCommitLock() {
        throw Object.assign(new Error('SITE_POLICY_CONFLICT'), { code: 'SITE_POLICY_CONFLICT' });
      },
    }),
    routeSnapshots: snapshotPort(),
    hostnameForSlug: (slug) => `${slug}.pages.xd.team`,
    ids: { next: () => 'audit_1' },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  await assert.rejects(
    update({
      environment: 'production',
      siteId: 'site_1',
      actor: { type: 'user', userId: 'usr_1' },
      patch: { title: 'Documentation' },
    }),
    (error) => error.code === 'SITE_METADATA_CONFLICT'
  );
});

test('a stale hostname cleanup token cannot mark a newer rename ready', async () => {
  const pendingSite = site({ slug: 'guides', slugRevision: 2, slugRoutingSyncedRevision: 1 });
  let siteMarked = false;
  const reconcile = createReconcileSiteMetadataRouting({
    siteMetadata: metadataPort({
      listSitesPendingSlugRouting: async () => [{ id: 'site_1' }],
      getSite: async () => pendingSite,
      getRouteBySiteId: async () => route({ hostname: 'guides.pages.xd.team', routeGeneration: 3 }),
      listSiteRetiringHostnameClaims: async () => [
        {
          id: 'claim_1',
          ownerSystem: 'v2',
          ownerId: 'site_1',
          ownerRef: 'route_1',
          environment: 'production',
          hostname: 'docs.pages.xd.team',
          releasedAt: '2027-01-15T08:00:00.000Z',
        },
      ],
      completeSiteSlugRelease: async () => null,
      markSiteSlugRoutingSynced: async () => {
        siteMarked = true;
      },
    }),
    routeSnapshots: snapshotPort(),
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  const result = await reconcile({ environment: 'production', limit: 5 });

  assert.deepEqual(result, { processed: 1, ready: 0, pending: 1, failed: 0 });
  assert.equal(siteMarked, false);
});

test('routing reconciliation records bounded per-site outcomes', async () => {
  const events = [];
  const pendingSite = site({ slug: 'guides', slugRevision: 2, slugRoutingSyncedRevision: 1 });
  const reconcile = createReconcileSiteMetadataRouting({
    siteMetadata: metadataPort({
      listSitesPendingSlugRouting: async () => [pendingSite],
      getSite: async () => pendingSite,
      getRouteBySiteId: async () => route({ hostname: 'guides.pages.xd.team', routeGeneration: 3 }),
      markSiteSlugRoutingSynced: async () => ({ ...pendingSite, slugRoutingSyncedRevision: 2 }),
    }),
    routeSnapshots: snapshotPort(),
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
    telemetry: { record: (event) => events.push(event) },
  });

  assert.deepEqual(await reconcile({ environment: 'production', limit: 5, traceId: 'smr_1' }), {
    processed: 1,
    ready: 1,
    pending: 0,
    failed: 0,
  });
  assert.deepEqual(events, [
    {
      operation: 'reconcile_candidate',
      outcome: 'ready',
      environment: 'production',
      traceId: 'smr_1',
      siteId: 'site_1',
      slugRevision: 2,
    },
  ]);
});

test('routing reconciliation rotates persistent failures so candidates beyond the batch limit are attempted', async () => {
  const candidates = ['site_1', 'site_2', 'site_3'].map((id) =>
    site({ id, slugRevision: 2, slugRoutingSyncedRevision: 1, slugRoutingReconcileAttemptedAt: null })
  );
  const attemptedBatches = [];
  let currentBatch = [];
  const reconcile = createReconcileSiteMetadataRouting({
    siteMetadata: metadataPort({
      async listSitesPendingSlugRouting(_environment, { limit }) {
        currentBatch = [];
        attemptedBatches.push(currentBatch);
        return [...candidates]
          .sort((left, right) => {
            const leftAttempt = left.slugRoutingReconcileAttemptedAt || '';
            const rightAttempt = right.slugRoutingReconcileAttemptedAt || '';
            return leftAttempt.localeCompare(rightAttempt) || left.id.localeCompare(right.id);
          })
          .slice(0, limit);
      },
      async markSiteSlugRoutingReconcileAttempted({ siteId, slugRevision, expectedAttemptedAt, attemptedAt }) {
        const candidate = candidates.find((item) => item.id === siteId && item.slugRevision === slugRevision);
        if (!candidate || candidate.slugRoutingReconcileAttemptedAt !== (expectedAttemptedAt || null)) return false;
        candidate.slugRoutingReconcileAttemptedAt = attemptedAt;
        return true;
      },
      async withSiteCommitLock(_environment, siteId) {
        currentBatch.push(siteId);
        throw new Error('persistent route repair failure');
      },
    }),
    routeSnapshots: snapshotPort(),
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    reuseHoldSeconds: 300,
  });

  assert.deepEqual(await reconcile({ environment: 'production', limit: 2 }), {
    processed: 2,
    ready: 0,
    pending: 0,
    failed: 2,
  });
  assert.deepEqual(await reconcile({ environment: 'production', limit: 2 }), {
    processed: 2,
    ready: 0,
    pending: 0,
    failed: 2,
  });
  assert.deepEqual(await reconcile({ environment: 'production', limit: 2 }), {
    processed: 2,
    ready: 0,
    pending: 0,
    failed: 2,
  });
  assert.deepEqual(attemptedBatches, [
    ['site_1', 'site_2'],
    ['site_3', 'site_1'],
    ['site_2', 'site_3'],
  ]);
});

function metadataPort(overrides = {}) {
  return {
    async withSiteCommitLock(environment, siteId, callback) {
      return callback(siteCommitLease('lock_1', 2));
    },
    async getSite() {
      return site();
    },
    async getSiteForUser() {
      return site({ ownerType: 'user', ownerId: 'usr_1', ownerUserId: 'usr_1' });
    },
    async getAccessKeyById() {
      return null;
    },
    async getUser(userId) {
      return { id: userId, employeeStatus: 'active' };
    },
    async getTeam(teamId) {
      return { id: teamId, environment: 'production', status: 'active', deletedAt: null };
    },
    async isPlatformAdmin() {
      return false;
    },
    async getRouteBySiteId() {
      return route();
    },
    async listSiteRetiringHostnameClaims() {
      return [];
    },
    async listSitesPendingSlugRouting() {
      return [];
    },
    async markSiteSlugRoutingReconcileAttempted() {
      return true;
    },
    async commitSiteMetadata() {
      throw new Error('commitSiteMetadata not implemented');
    },
    async completeSiteSlugRelease() {
      throw new Error('completeSiteSlugRelease not implemented');
    },
    async markSiteSlugRoutingSynced() {
      throw new Error('markSiteSlugRoutingSynced not implemented');
    },
    ...overrides,
  };
}

function snapshotPort(overrides = {}) {
  return {
    async repairCurrent() {},
    async clearRetired() {
      return true;
    },
    ...overrides,
  };
}

function site(overrides = {}) {
  return {
    id: 'site_1',
    slug: 'docs',
    title: null,
    siteUuid: 'uuid_1',
    dataNamespace: 'docs',
    environment: 'production',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    slugRevision: 1,
    slugRoutingSyncedRevision: 1,
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    id: 'route_1',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    routeGeneration: 2,
    policyVersion: 1,
    activeVersionId: 'ver_1',
    runtimeConfigGeneration: 0,
    routeStatus: 'active',
    ...overrides,
  };
}

function expected(currentSite, currentRoute) {
  return {
    slugRevision: currentSite.slugRevision,
    routeGeneration: currentRoute.routeGeneration,
    policyVersion: currentRoute.policyVersion,
    activeVersionId: currentRoute.activeVersionId,
    runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
  };
}

function siteCommitLease(lockId, fencingToken) {
  return { lockId, fencingToken };
}
