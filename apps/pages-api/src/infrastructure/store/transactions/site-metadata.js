import {
  createHostnameClaim,
  hostnameClaimOwnerMatches,
  isSqliteConstraintError,
  normalizeSitePolicyLease,
  randomStoreId,
} from '../store-support.js';
import {
  SITE_MUTATION_AUTHORIZATION_FAILED,
  siteMutationAuthorizationStatements,
} from '../support/site-mutation-authorization.js';

const SLUG_RENAME_PENDING_RELEASE = 'site_slug_renamed_pending_cleanup';
const SLUG_RENAME_RELEASED = 'site_slug_renamed';

export const siteMetadataMethods = {
  async commitSiteMetadata(input) {
    const readNow = this.now();
    const updatedAt = input.updatedAt || readNow;
    const site = await this.getSite(input.siteId);
    const route = await this.getRouteBySiteId(input.siteId, input.environment);
    if (!site || site.deletedAt || !route || site.environment !== input.environment) {
      throw siteMetadataError('SITE_METADATA_NOT_FOUND');
    }

    const expected = normalizeSiteMetadataExpected(input.expected);
    assertSiteMetadataExpected(site, route, expected);
    const lease = normalizeSitePolicyLease(input.lease);
    await assertMetadataLease(this, input.environment, input.siteId, lease, readNow);

    const hasTitle = Object.hasOwn(input, 'title');
    const hasSlug = Object.hasOwn(input, 'slug');
    const titleChanged = hasTitle && input.title !== site.title;
    const slugChanged = hasSlug && input.slug !== site.slug;
    if (!titleChanged && !slugChanged) {
      return {
        changed: false,
        titleChanged: false,
        slugChanged: false,
        site,
        route,
        retiringClaims: await this.listSiteRetiringHostnameClaims(site.id, { environment: site.environment }),
      };
    }

    let targetClaim = null;
    if (slugChanged) {
      if (!input.slug || !input.hostname) throw siteMetadataError('SITE_METADATA_INVALID');
      const conflictingSite = await this.findSiteBySlug(input.environment, input.slug);
      if (conflictingSite && conflictingSite.id !== site.id) throw siteMetadataError('SITE_SLUG_CONFLICT');

      targetClaim = await this.getHostnameClaim(input.hostname);
      if (targetClaim) {
        const reusable =
          targetClaim.status === 'released' ||
          (targetClaim.status === 'held' && Boolean(targetClaim.reuseHoldUntil) && targetClaim.reuseHoldUntil <= readNow);
        const owned = hostnameClaimOwnerMatches(targetClaim, { ownerSystem: 'v2', ownerId: site.id });
        if (!owned && !reusable) throw siteMetadataError('SITE_SLUG_CONFLICT');
        if (owned && !['active', 'pending', 'held'].includes(targetClaim.status) && !reusable) {
          throw siteMetadataError('SITE_SLUG_CONFLICT');
        }
      }
      const conflictingClaim = await this.findConflictingHostnameClaim({
        environment: input.environment,
        normalizedSlug: input.slug,
        excludeHostname: input.hostname,
        now: readNow,
      });
      if (conflictingClaim) throw siteMetadataError('SITE_SLUG_CONFLICT');
    }

    const commitNow = this.now();
    const statements = siteMutationAuthorizationStatements(this, {
      siteId: site.id,
      environment: input.environment,
      authorization: input.authorization,
      now: commitNow,
    });
    if (slugChanged) {
      statements.push(...metadataHostnameClaimStatements(this, { input, site, route, targetClaim, commitNow }));
      statements.push(
        this.db
          .prepare(
            `UPDATE hostname_claims
              SET status = 'held', released_at = ?, reuse_hold_until = NULL,
                release_reason = ?, updated_at = ?
              WHERE hostname = ? AND environment = ?
                AND owner_system = 'v2' AND owner_id = ? AND owner_ref = ?
                AND status IN ('pending', 'active')`
          )
          .bind(updatedAt, SLUG_RENAME_PENDING_RELEASE, updatedAt, route.hostname, input.environment, site.id, route.id),
        metadataGuardStatement(this, 'SITE_METADATA_CONFLICT')
      );
    }

    const siteAssignments = [];
    const siteValues = [];
    if (titleChanged) {
      siteAssignments.push('title = ?');
      siteValues.push(input.title);
    }
    if (slugChanged) {
      siteAssignments.push(
        'data_namespace = COALESCE(data_namespace, slug)',
        'slug = ?',
        'slug_revision = slug_revision + 1',
        'slug_routing_reconcile_attempted_at = NULL'
      );
      siteValues.push(input.slug);
    }
    siteAssignments.push('updated_at = ?');
    siteValues.push(updatedAt);
    statements.push(
      this.db
        .prepare(
          `UPDATE sites
            SET ${siteAssignments.join(', ')}
            WHERE id = ? AND environment = ? AND deleted_at IS NULL
              AND slug_revision = ?
              AND EXISTS (
                SELECT 1 FROM site_policy_locks
                WHERE environment = ? AND site_id = ? AND lock_id = ?
                  AND fencing_token
                    = ? AND expires_at > ?
              )
              AND EXISTS (
                SELECT 1 FROM site_routes
                WHERE environment = ? AND site_id = ?
                  AND route_generation = ? AND policy_version = ?
                  AND active_version_id IS ? AND runtime_config_generation = ?
              )`
        )
        .bind(
          ...siteValues,
          site.id,
          input.environment,
          expected.slugRevision,
          input.environment,
          site.id,
          lease.lockId,
          lease.fencingToken,
          commitNow,
          input.environment,
          site.id,
          expected.routeGeneration,
          expected.policyVersion,
          expected.activeVersionId,
          expected.runtimeConfigGeneration
        ),
      metadataGuardStatement(this, 'SITE_METADATA_CONFLICT')
    );

    if (slugChanged) {
      statements.push(
        this.db
          .prepare(
            `UPDATE site_routes
              SET hostname = ?, route_generation = route_generation + 1, updated_at = ?
              WHERE environment = ? AND site_id = ?
                AND route_generation = ? AND policy_version = ?
                AND active_version_id IS ? AND runtime_config_generation = ?
                AND EXISTS (
                  SELECT 1 FROM site_policy_locks
                  WHERE environment = ? AND site_id = ? AND lock_id = ?
                    AND fencing_token
                      = ? AND expires_at > ?
                )`
          )
          .bind(
            input.hostname,
            updatedAt,
            input.environment,
            site.id,
            expected.routeGeneration,
            expected.policyVersion,
            expected.activeVersionId,
            expected.runtimeConfigGeneration,
            input.environment,
            site.id,
            lease.lockId,
            lease.fencingToken,
            commitNow
          ),
        metadataGuardStatement(this, 'SITE_METADATA_CONFLICT')
      );
    }
    if (input.auditEvent) statements.push(this.auditEventStatement(input.auditEvent));

    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes(SITE_MUTATION_AUTHORIZATION_FAILED)) {
        throw siteMetadataError('SITE_METADATA_NOT_FOUND');
      }
      if (message.includes('SITE_METADATA_CONFLICT')) throw siteMetadataError('SITE_METADATA_CONFLICT');
      if (message.includes('SITE_SLUG_CONFLICT') || (slugChanged && isSqliteConstraintError(error))) {
        throw siteMetadataError('SITE_SLUG_CONFLICT');
      }
      throw error;
    }

    return {
      changed: true,
      titleChanged,
      slugChanged,
      site: await this.getSite(site.id),
      route: await this.getRouteBySiteId(site.id, input.environment),
      retiringClaims: await this.listSiteRetiringHostnameClaims(site.id, { environment: input.environment }),
    };
  },

  async completeSiteSlugRelease({
    environment,
    siteId,
    routeId,
    hostname,
    slugRevision,
    cleanupToken,
    reuseHoldUntil,
    lease,
    completedAt,
  }) {
    const now = completedAt || this.now();
    const currentLease = normalizeSitePolicyLease(lease);
    await assertMetadataLease(this, environment, siteId, currentLease, now);
    const result = await this.db
      .prepare(
        `UPDATE hostname_claims
          SET status = 'held', reuse_hold_until = ?, release_reason = ?, updated_at = ?
          WHERE hostname = ? AND environment = ?
            AND owner_system = 'v2' AND owner_id = ? AND owner_ref = ?
            AND status = 'held' AND release_reason = ? AND released_at = ?
            AND EXISTS (
              SELECT 1 FROM sites
              WHERE sites.id = ? AND sites.environment = ? AND sites.deleted_at IS NULL
                AND sites.slug_revision = ?
            )
            AND EXISTS (
              SELECT 1 FROM site_routes
              WHERE site_routes.site_id = ? AND site_routes.environment = ?
                AND site_routes.id = ? AND site_routes.hostname != ?
            )
            AND EXISTS (
              SELECT 1 FROM site_policy_locks
              WHERE environment = ? AND site_id = ? AND lock_id = ?
                AND fencing_token
                  = ? AND expires_at > ?
            )`
      )
      .bind(
        reuseHoldUntil,
        SLUG_RENAME_RELEASED,
        now,
        hostname,
        environment,
        siteId,
        routeId,
        SLUG_RENAME_PENDING_RELEASE,
        cleanupToken,
        siteId,
        environment,
        slugRevision,
        siteId,
        environment,
        routeId,
        hostname,
        environment,
        siteId,
        currentLease.lockId,
        currentLease.fencingToken,
        now
      )
      .run();
    if (result?.meta?.changes !== 1) return null;
    return this.getHostnameClaim(hostname);
  },

  async markSiteSlugRoutingReconcileAttempted({ environment, siteId, slugRevision, expectedAttemptedAt = null, attemptedAt }) {
    const result = await this.db
      .prepare(
        `UPDATE sites
          SET slug_routing_reconcile_attempted_at = ?
          WHERE id = ? AND environment = ? AND deleted_at IS NULL
            AND slug_revision = ?
            AND slug_routing_synced_revision != slug_revision
            AND slug_routing_reconcile_attempted_at IS ?`
      )
      .bind(attemptedAt || this.now(), siteId, environment, slugRevision, expectedAttemptedAt)
      .run();
    return result?.meta?.changes === 1;
  },

  async markSiteSlugRoutingSynced({ environment, siteId, slugRevision, lease, syncedAt }) {
    const now = syncedAt || this.now();
    const currentLease = normalizeSitePolicyLease(lease);
    await assertMetadataLease(this, environment, siteId, currentLease, now);
    const result = await this.db
      .prepare(
        `UPDATE sites
          SET slug_routing_synced_revision = ?
          WHERE id = ? AND environment = ? AND deleted_at IS NULL
            AND slug_revision = ?
            AND NOT EXISTS (
              SELECT 1 FROM hostname_claims
              WHERE hostname_claims.owner_system = 'v2'
                AND hostname_claims.owner_id = sites.id
                AND hostname_claims.environment = sites.environment
                AND hostname_claims.status = 'held'
                AND hostname_claims.release_reason = ?
                AND hostname_claims.reuse_hold_until IS NULL
            )
            AND EXISTS (
              SELECT 1 FROM site_policy_locks
              WHERE environment = ? AND site_id = ? AND lock_id = ?
                AND fencing_token
                  = ? AND expires_at > ?
            )`
      )
      .bind(
        slugRevision,
        siteId,
        environment,
        slugRevision,
        SLUG_RENAME_PENDING_RELEASE,
        environment,
        siteId,
        currentLease.lockId,
        currentLease.fencingToken,
        now
      )
      .run();
    return result?.meta?.changes === 1 ? this.getSite(siteId) : null;
  },
};

function metadataHostnameClaimStatements(store, { input, site, route, targetClaim, commitNow }) {
  const claim = createHostnameClaim(
    {
      id: targetClaim?.id || randomStoreId('claim'),
      environment: input.environment,
      hostname: input.hostname,
      normalizedSlug: input.slug,
      ownerSystem: 'v2',
      ownerId: site.id,
      ownerRef: route.id,
      source: 'site_slug_rename',
    },
    commitNow
  );
  if (!targetClaim) {
    return [
      store.db
        .prepare(
          `INSERT INTO hostname_claims (
              id, environment, hostname, normalized_slug, hostname_family, owner_system, owner_id,
              owner_ref, status, source, acquired_at, lease_expires_at, released_at,
              reuse_hold_until, release_reason, created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM hostname_claims
              WHERE environment = ? AND normalized_slug = ?
                AND (
                  status IN ('pending', 'active', 'conflicted')
                  OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                )
            )`
        )
        .bind(
          claim.id,
          claim.environment,
          claim.hostname,
          claim.normalizedSlug,
          claim.hostnameFamily,
          claim.ownerSystem,
          claim.ownerId,
          claim.ownerRef,
          claim.status,
          claim.source,
          claim.acquiredAt,
          claim.leaseExpiresAt,
          claim.releasedAt,
          claim.reuseHoldUntil,
          claim.releaseReason,
          claim.createdAt,
          claim.updatedAt,
          claim.environment,
          claim.normalizedSlug,
          commitNow
        ),
      metadataGuardStatement(store, 'SITE_SLUG_CONFLICT'),
    ];
  }

  if (
    hostnameClaimOwnerMatches(targetClaim, { ownerSystem: 'v2', ownerId: site.id }) &&
    ['active', 'pending', 'held'].includes(targetClaim.status)
  ) {
    return [
      store.db
        .prepare(
          `UPDATE hostname_claims
            SET owner_ref = ?, status = 'active', lease_expires_at = NULL,
              released_at = NULL, reuse_hold_until = NULL, release_reason = NULL, updated_at = ?
            WHERE hostname = ? AND environment = ? AND normalized_slug = ?
              AND owner_system = 'v2' AND owner_id = ? AND status IN ('active', 'pending', 'held')
              AND NOT EXISTS (
                SELECT 1 FROM hostname_claims
                WHERE environment = ? AND normalized_slug = ?
                  AND (
                    status IN ('pending', 'active', 'conflicted')
                    OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                  )
                  AND hostname != ?
              )`
        )
        .bind(
          route.id,
          commitNow,
          claim.hostname,
          claim.environment,
          claim.normalizedSlug,
          claim.ownerId,
          claim.environment,
          claim.normalizedSlug,
          commitNow,
          claim.hostname
        ),
      metadataGuardStatement(store, 'SITE_SLUG_CONFLICT'),
    ];
  }

  return [
    store.db
      .prepare(
        `UPDATE hostname_claims
          SET environment = ?, normalized_slug = ?, hostname_family = ?, owner_system = 'v2',
            owner_id = ?, owner_ref = ?, status = 'active', source = ?, acquired_at = ?,
            lease_expires_at = NULL, released_at = NULL, reuse_hold_until = NULL,
            release_reason = NULL, updated_at = ?
          WHERE hostname = ? AND status IN ('released', 'held')
            AND (
              status = 'released'
              OR (status = 'held' AND reuse_hold_until IS NOT NULL AND reuse_hold_until <= ?)
            )
            AND NOT EXISTS (
              SELECT 1 FROM hostname_claims
              WHERE environment = ? AND normalized_slug = ?
                AND (
                  status IN ('pending', 'active', 'conflicted')
                  OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                )
                AND hostname != ?
            )`
      )
      .bind(
        claim.environment,
        claim.normalizedSlug,
        claim.hostnameFamily,
        claim.ownerId,
        claim.ownerRef,
        claim.source,
        commitNow,
        commitNow,
        claim.hostname,
        commitNow,
        claim.environment,
        claim.normalizedSlug,
        commitNow,
        claim.hostname
      ),
    metadataGuardStatement(store, 'SITE_SLUG_CONFLICT'),
  ];
}

function normalizeSiteMetadataExpected(expected) {
  if (
    !expected ||
    !Number.isInteger(expected.slugRevision) ||
    !Number.isInteger(expected.routeGeneration) ||
    !Number.isInteger(expected.policyVersion)
  ) {
    throw siteMetadataError('SITE_METADATA_CONFLICT');
  }
  return {
    slugRevision: expected.slugRevision,
    routeGeneration: expected.routeGeneration,
    policyVersion: expected.policyVersion,
    activeVersionId: expected.activeVersionId || null,
    runtimeConfigGeneration: Number(expected.runtimeConfigGeneration || 0),
  };
}

function assertSiteMetadataExpected(site, route, expected) {
  if (
    site.slugRevision !== expected.slugRevision ||
    route.routeGeneration !== expected.routeGeneration ||
    route.policyVersion !== expected.policyVersion ||
    (route.activeVersionId || null) !== expected.activeVersionId ||
    Number(route.runtimeConfigGeneration || 0) !== expected.runtimeConfigGeneration
  ) {
    throw siteMetadataError('SITE_METADATA_CONFLICT');
  }
}

async function assertMetadataLease(store, environment, siteId, lease, now) {
  const current = await store.getSiteCommitLock(environment, siteId);
  if (!current || current.lockId !== lease.lockId || current.fencingToken !== lease.fencingToken || current.expiresAt <= now) {
    throw siteMetadataError('SITE_METADATA_CONFLICT');
  }
}

function metadataGuardStatement(store, code) {
  return store.db.prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`).bind(code);
}

function siteMetadataError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
