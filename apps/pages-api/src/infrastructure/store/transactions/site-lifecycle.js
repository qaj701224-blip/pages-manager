import {
  accessModeFromVisibility,
  cloneRecord,
  createHostnameClaim,
  createInitialRoute,
  createOwnerMember,
  hostnameClaimOwnerMatches,
  hostnameFamilyForHostname,
  isSqliteConstraintError,
  mapHostnameClaim,
} from '../store-support.js';

export const siteLifecycleMethods = {
  async createSite(input) {
    const now = this.now();
    if (await this.findSiteBySlug(input.environment, input.slug)) throw new Error('SITE_SLUG_CONFLICT');

    const site = {
      id: input.id,
      slug: input.slug,
      environment: input.environment,
      ownerType: input.ownerType || 'user',
      ownerId: input.ownerId || input.ownerUserId,
      ownerUserId: input.ownerUserId,
      defaultVisibility: input.defaultVisibility,
      defaultExposure: 'internal',
      defaultAccessMode: accessModeFromVisibility(input.defaultVisibility),
      executionModeOverride: input.executionModeOverride || null,
      siteUuid: input.siteUuid,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const route = createInitialRoute(input, now);
    const member = createOwnerMember(input.id, input.ownerUserId, now);
    const hostnameClaim = createHostnameClaim(
      {
        environment: input.environment,
        hostname: input.hostname,
        normalizedSlug: input.slug,
        hostnameFamily: hostnameFamilyForHostname(input.hostname),
        ownerSystem: 'v2',
        ownerId: input.id,
        ownerRef: input.routeId,
        source: 'v2_create',
      },
      now
    );
    const existingHostnameClaim = await this.getHostnameClaim(hostnameClaim.hostname);
    let hostnameClaimStatement;
    const hostnameClaimGuardStatement = this.createHostnameClaimGuardStatement(hostnameClaim);
    if (existingHostnameClaim) {
      if (!['released', 'held'].includes(existingHostnameClaim.status)) throw new Error('HOSTNAME_CLAIM_CONFLICT');
      if (existingHostnameClaim.reuseHoldUntil && existingHostnameClaim.reuseHoldUntil > now) {
        throw new Error('HOSTNAME_CLAIM_CONFLICT');
      }
      if (await this.findConflictingHostnameClaim({ ...hostnameClaim, excludeHostname: hostnameClaim.hostname })) {
        throw new Error('HOSTNAME_CLAIM_CONFLICT');
      }
      hostnameClaimStatement = this.db
        .prepare(
          `UPDATE hostname_claims
            SET environment = ?, normalized_slug = ?, hostname_family = ?, owner_system = ?, owner_id = ?,
              owner_ref = ?, status = ?, source = ?, acquired_at = ?, lease_expires_at = ?,
              released_at = NULL, reuse_hold_until = ?, release_reason = NULL, updated_at = ?
            WHERE hostname = ?
              AND status IN ('released', 'held')
              AND (reuse_hold_until IS NULL OR reuse_hold_until <= ?)
              AND NOT EXISTS (
                SELECT 1 FROM hostname_claims
                WHERE environment = ?
                  AND normalized_slug = ?
                  AND (
                    status IN ('pending', 'active', 'conflicted')
                    OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                  )
                  AND hostname != ?
              )`
        )
        .bind(
          hostnameClaim.environment,
          hostnameClaim.normalizedSlug,
          hostnameClaim.hostnameFamily,
          hostnameClaim.ownerSystem,
          hostnameClaim.ownerId,
          hostnameClaim.ownerRef,
          hostnameClaim.status,
          hostnameClaim.source,
          hostnameClaim.acquiredAt,
          hostnameClaim.leaseExpiresAt,
          hostnameClaim.reuseHoldUntil,
          hostnameClaim.updatedAt,
          hostnameClaim.hostname,
          now,
          hostnameClaim.environment,
          hostnameClaim.normalizedSlug,
          now,
          hostnameClaim.hostname
        );
    } else {
      if (await this.findConflictingHostnameClaim(hostnameClaim)) throw new Error('HOSTNAME_CLAIM_CONFLICT');
      hostnameClaimStatement = this.db
        .prepare(
          `INSERT INTO hostname_claims (
                id, environment, hostname, normalized_slug, hostname_family, owner_system, owner_id,
                owner_ref, status, source, acquired_at, lease_expires_at, released_at, reuse_hold_until,
                release_reason, created_at, updated_at
              )
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE NOT EXISTS (
                SELECT 1 FROM hostname_claims
                WHERE environment = ?
                  AND normalized_slug = ?
                  AND (
                    status IN ('pending', 'active', 'conflicted')
                    OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                  )
                  AND hostname != ?
              )`
        )
        .bind(
          hostnameClaim.id,
          hostnameClaim.environment,
          hostnameClaim.hostname,
          hostnameClaim.normalizedSlug,
          hostnameClaim.hostnameFamily,
          hostnameClaim.ownerSystem,
          hostnameClaim.ownerId,
          hostnameClaim.ownerRef,
          hostnameClaim.status,
          hostnameClaim.source,
          hostnameClaim.acquiredAt,
          hostnameClaim.leaseExpiresAt,
          hostnameClaim.releasedAt,
          hostnameClaim.reuseHoldUntil,
          hostnameClaim.releaseReason,
          hostnameClaim.createdAt,
          hostnameClaim.updatedAt,
          hostnameClaim.environment,
          hostnameClaim.normalizedSlug,
          now,
          hostnameClaim.hostname
        );
    }

    try {
      await this.db.batch([
        hostnameClaimStatement,
        hostnameClaimGuardStatement,
        this.db
          .prepare(
            `INSERT INTO sites (
                id, slug, environment, owner_type, owner_id, owner_user_id,
                default_visibility, default_exposure, default_access_mode,
                execution_mode_override, site_uuid, created_at, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            site.id,
            site.slug,
            site.environment,
            site.ownerType,
            site.ownerId,
            site.ownerUserId,
            site.defaultVisibility,
            site.defaultExposure,
            site.defaultAccessMode,
            site.executionModeOverride,
            site.siteUuid,
            site.createdAt,
            site.updatedAt,
            site.deletedAt
          ),
        this.db
          .prepare(
            `INSERT INTO site_routes (
                id, hostname, site_id, environment, runtime, execution_provider, worker_name,
                dispatch_type, dispatch_binding_name, slot_id,
                active_version_id, visibility, exposure, access_mode, policy_version, route_generation,
                runtime_config_generation, runtime_config_lock_id, runtime_config_lock_expires_at,
                route_status, cache_tier, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            route.id,
            route.hostname,
            route.siteId,
            route.environment,
            route.runtime,
            route.executionProvider,
            route.workerName,
            route.dispatchType,
            route.dispatchBindingName,
            route.slotId,
            route.activeVersionId,
            route.visibility,
            route.exposure,
            route.accessMode,
            route.policyVersion,
            route.routeGeneration,
            route.runtimeConfigGeneration,
            null,
            null,
            route.routeStatus,
            route.cacheTier,
            route.createdAt,
            route.updatedAt
          ),
        this.db
          .prepare(
            `INSERT INTO site_members (
                site_id, user_id, role, created_by, created_at
              ) VALUES (?, ?, ?, ?, ?)`
          )
          .bind(member.siteId, member.userId, member.role, member.createdBy, member.createdAt),
      ]);
    } catch (error) {
      if (!isSqliteConstraintError(error)) throw error;
      if (await this.findSiteBySlug(input.environment, input.slug)) throw new Error('SITE_SLUG_CONFLICT');
      throw new Error('HOSTNAME_CLAIM_CONFLICT');
    }

    return cloneRecord(site);
  },

  async createSiteByTakingOverV1Claim(input, expectedClaim, environment) {
    const now = this.now();
    const targetEnvironment = environment || input.environment;
    const normalizedHostname = String(input.hostname || '').toLowerCase();
    const takeoverError = (code) => {
      const error = new Error(code);
      error.code = code;
      return error;
    };

    if (
      !expectedClaim ||
      expectedClaim.environment !== targetEnvironment ||
      expectedClaim.hostname !== normalizedHostname ||
      expectedClaim.normalizedSlug !== input.slug ||
      expectedClaim.ownerSystem !== 'v1' ||
      expectedClaim.status !== 'active'
    ) {
      throw takeoverError('V1_TAKEOVER_STATE_CHANGED');
    }
    if (await this.findSiteBySlug(targetEnvironment, input.slug)) throw takeoverError('SITE_SLUG_CONFLICT');

    const site = {
      id: input.id,
      slug: input.slug,
      environment: targetEnvironment,
      ownerType: input.ownerType || 'user',
      ownerId: input.ownerId || input.ownerUserId,
      ownerUserId: input.ownerUserId,
      defaultVisibility: input.defaultVisibility,
      defaultExposure: 'internal',
      defaultAccessMode: accessModeFromVisibility(input.defaultVisibility),
      executionModeOverride: input.executionModeOverride || null,
      siteUuid: input.siteUuid,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const route = createInitialRoute({ ...input, environment: targetEnvironment, hostname: normalizedHostname }, now);
    const member = createOwnerMember(site.id, site.ownerUserId, now);
    const hostnameClaim = createHostnameClaim(
      {
        id: expectedClaim.id,
        environment: targetEnvironment,
        hostname: normalizedHostname,
        normalizedSlug: input.slug,
        hostnameFamily: input.hostnameFamily || expectedClaim.hostnameFamily,
        ownerSystem: 'v2',
        ownerId: site.id,
        ownerRef: route.id,
        status: 'active',
        source: 'v1_email_takeover',
        acquiredAt: now,
        createdAt: expectedClaim.createdAt,
      },
      now
    );
    const conflictingClaim = await this.findConflictingHostnameClaim({
      ...hostnameClaim,
      excludeHostname: hostnameClaim.hostname,
    });
    if (conflictingClaim) throw takeoverError('HOSTNAME_CLAIM_CONFLICT');

    const claimUpdate = this.db
      .prepare(
        `UPDATE hostname_claims
          SET owner_system = 'v2', owner_id = ?, owner_ref = ?, status = 'active', source = ?,
            acquired_at = ?, lease_expires_at = NULL, released_at = NULL, reuse_hold_until = NULL,
            release_reason = NULL, updated_at = ?
          WHERE hostname = ? AND environment = ? AND normalized_slug = ?
            AND id = ? AND hostname_family = ? AND created_at = ?
            AND owner_system = 'v1' AND owner_id = ? AND status = 'active'
            AND (owner_ref = ? OR owner_ref IS NULL)
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
        hostnameClaim.ownerId,
        hostnameClaim.ownerRef,
        hostnameClaim.source,
        hostnameClaim.acquiredAt,
        hostnameClaim.updatedAt,
        hostnameClaim.hostname,
        hostnameClaim.environment,
        hostnameClaim.normalizedSlug,
        expectedClaim.id,
        expectedClaim.hostnameFamily,
        expectedClaim.createdAt,
        expectedClaim.ownerId,
        expectedClaim.ownerRef,
        hostnameClaim.environment,
        hostnameClaim.normalizedSlug,
        now,
        hostnameClaim.hostname
      );
    const claimGuard = this.db
      .prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`)
      .bind('V1_TAKEOVER_STATE_CHANGED');

    const statements = [
      claimUpdate,
      claimGuard,
      this.db
        .prepare(
          `INSERT INTO sites (
              id, slug, environment, owner_type, owner_id, owner_user_id,
              default_visibility, default_exposure, default_access_mode,
              execution_mode_override, site_uuid, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          site.id,
          site.slug,
          site.environment,
          site.ownerType,
          site.ownerId,
          site.ownerUserId,
          site.defaultVisibility,
          site.defaultExposure,
          site.defaultAccessMode,
          site.executionModeOverride,
          site.siteUuid,
          site.createdAt,
          site.updatedAt,
          site.deletedAt
        ),
      this.db
        .prepare(
          `INSERT INTO site_routes (
              id, hostname, site_id, environment, runtime, execution_provider, worker_name,
              dispatch_type, dispatch_binding_name, slot_id,
              active_version_id, visibility, exposure, access_mode, policy_version, route_generation,
              runtime_config_generation, runtime_config_lock_id, runtime_config_lock_expires_at,
              route_status, cache_tier, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          route.id,
          route.hostname,
          route.siteId,
          route.environment,
          route.runtime,
          route.executionProvider,
          route.workerName,
          route.dispatchType,
          route.dispatchBindingName,
          route.slotId,
          route.activeVersionId,
          route.visibility,
          route.exposure,
          route.accessMode,
          route.policyVersion,
          route.routeGeneration,
          route.runtimeConfigGeneration,
          null,
          null,
          route.routeStatus,
          route.cacheTier,
          route.createdAt,
          route.updatedAt
        ),
      this.db
        .prepare(`INSERT INTO site_members (site_id, user_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(member.siteId, member.userId, member.role, member.createdBy, member.createdAt),
    ];
    if (input.auditEvent) statements.push(this.auditEventStatement(input.auditEvent));

    try {
      await this.db.batch(statements);
    } catch (error) {
      if (String(error?.message || error).includes('V1_TAKEOVER_STATE_CHANGED')) {
        throw takeoverError('V1_TAKEOVER_STATE_CHANGED');
      }
      if (!isSqliteConstraintError(error)) throw error;
      if (await this.findSiteBySlug(targetEnvironment, input.slug)) throw takeoverError('SITE_SLUG_CONFLICT');
      throw takeoverError('HOSTNAME_CLAIM_CONFLICT');
    }

    return cloneRecord(site);
  },

  async getHostnameClaim(hostname) {
    const row = await this.db.prepare('SELECT * FROM hostname_claims WHERE hostname = ?').bind(hostname).first();
    return row ? mapHostnameClaim(row) : null;
  },

  async findConflictingHostnameClaim(input) {
    const now = input.now || this.now();
    const row = await this.db
      .prepare(
        `SELECT * FROM hostname_claims
          WHERE environment = ?
            AND normalized_slug = ?
            AND (
              status IN ('pending', 'active', 'conflicted')
              OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
            )
            AND hostname != ?
          LIMIT 1`
      )
      .bind(input.environment, input.normalizedSlug, now, input.excludeHostname || '')
      .first();
    return row ? mapHostnameClaim(row) : null;
  },

  async getHostnameClaimForOwner(input) {
    const now = input.now || this.now();
    const row = await this.db
      .prepare(
        `SELECT * FROM hostname_claims
          WHERE environment = ? AND normalized_slug = ? AND owner_system = ? AND owner_id = ?
            AND (
              status IN ('pending', 'active', 'conflicted')
              OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
            )
          LIMIT 1`
      )
      .bind(input.environment, input.normalizedSlug, input.ownerSystem, input.ownerId, now)
      .first();
    return row ? mapHostnameClaim(row) : null;
  },

  async acquireHostnameClaim(input) {
    const now = input.acquiredAt || this.now();
    const existing = await this.getHostnameClaim(input.hostname);
    if (existing) {
      if (existing.status === 'released' || existing.status === 'held') {
        const revived = await this.reacquireReleasedHostnameClaim(input, now);
        if (revived) return { ok: true, claim: revived };
        return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: existing };
      }
      if (hostnameClaimOwnerMatches(existing, input) && existing.status !== 'conflicted') return { ok: true, claim: existing };
      return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: existing };
    }
    const existingOwnerClaim = await this.getHostnameClaimForOwner(input);
    if (existingOwnerClaim) {
      if (existingOwnerClaim.hostname === String(input.hostname || '').toLowerCase()) {
        return { ok: true, claim: existingOwnerClaim };
      }
      return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: existingOwnerClaim };
    }
    const conflicting = await this.findConflictingHostnameClaim(input);
    if (conflicting) return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: conflicting };

    const claim = createHostnameClaim(input, now);
    try {
      const result = await this.insertHostnameClaim(claim, now);
      if (result?.meta?.changes === 0) {
        return {
          ok: false,
          code: 'HOSTNAME_CLAIM_CONFLICT',
          claim: await this.findConflictingHostnameClaim(claim),
        };
      }
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        return {
          ok: false,
          code: 'HOSTNAME_CLAIM_CONFLICT',
          claim: (await this.getHostnameClaim(claim.hostname)) || (await this.findConflictingHostnameClaim(claim)),
        };
      }
      throw error;
    }
    return { ok: true, claim };
  },

  async reacquireReleasedHostnameClaim(input, now) {
    const claim = createHostnameClaim(input, now);
    const conflicting = await this.findConflictingHostnameClaim({
      ...claim,
      ownerSystem: '__reacquire__',
      ownerId: claim.id,
      excludeHostname: claim.hostname,
    });
    if (conflicting) return null;
    try {
      const result = await this.db
        .prepare(
          `UPDATE hostname_claims
            SET environment = ?, normalized_slug = ?, hostname_family = ?, owner_system = ?, owner_id = ?,
              owner_ref = ?, status = ?, source = ?, acquired_at = ?, lease_expires_at = ?,
              released_at = NULL, reuse_hold_until = ?, release_reason = NULL, updated_at = ?
            WHERE hostname = ?
              AND status IN ('released', 'held')
              AND (reuse_hold_until IS NULL OR reuse_hold_until <= ?)
              AND NOT EXISTS (
                SELECT 1 FROM hostname_claims
                WHERE environment = ?
                  AND normalized_slug = ?
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
          claim.ownerSystem,
          claim.ownerId,
          claim.ownerRef,
          claim.status,
          claim.source,
          claim.acquiredAt,
          claim.leaseExpiresAt,
          claim.reuseHoldUntil,
          claim.updatedAt,
          claim.hostname,
          now,
          claim.environment,
          claim.normalizedSlug,
          now,
          claim.hostname
        )
        .run();
      if (result?.meta?.changes === 0) return null;
      return this.getHostnameClaim(claim.hostname);
    } catch (error) {
      if (isSqliteConstraintError(error)) return null;
      throw error;
    }
  },

  async confirmHostnameClaim(input) {
    const now = input.confirmedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE hostname_claims
          SET status = 'active', lease_expires_at = NULL, updated_at = ?
          WHERE hostname = ? AND owner_system = ? AND owner_id = ?
            AND status IN ('pending', 'active')`
      )
      .bind(now, String(input.hostname || '').toLowerCase(), input.ownerSystem, input.ownerId)
      .run();
    if (result?.meta?.changes === 0) return { ok: false, code: 'HOSTNAME_CLAIM_NOT_FOUND' };
    return { ok: true, claim: await this.getHostnameClaim(input.hostname) };
  },

  async releaseHostnameClaim(input) {
    const now = input.releasedAt || this.now();
    const targetStatus = input.reuseHoldUntil ? 'held' : 'released';
    const allowedStatuses = input.reuseHoldUntil ? ['pending', 'active', 'held'] : ['pending'];
    const result = await this.db
      .prepare(
        `UPDATE hostname_claims
          SET status = ?, released_at = ?, reuse_hold_until = ?, release_reason = ?, updated_at = ?
          WHERE hostname = ? AND owner_system = ? AND owner_id = ?
            AND status IN (${allowedStatuses.map(() => '?').join(', ')})`
      )
      .bind(
        targetStatus,
        now,
        input.reuseHoldUntil || null,
        input.releaseReason || null,
        now,
        String(input.hostname || '').toLowerCase(),
        input.ownerSystem,
        input.ownerId,
        ...allowedStatuses
      )
      .run();
    if (result?.meta?.changes === 0) return { ok: false, code: 'HOSTNAME_CLAIM_NOT_FOUND' };
    return { ok: true, claim: await this.getHostnameClaim(input.hostname) };
  },

  async deleteSite(siteId, { deletedAt, reuseHoldUntil, releaseReason = 'site_deleted' } = {}, environment) {
    const site = await this.getSite(siteId);
    const route = await this.getRouteBySiteId(siteId, environment);
    if (!site || site.deletedAt || !route) return null;
    if (environment && site.environment !== environment) return null;
    const now = deletedAt || this.now();
    await this.db.batch([
      this.db
        .prepare(`UPDATE sites SET deleted_at = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, now, siteId, environment] : [now, now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
            SET route_status = 'deleted', runtime = 'disabled', active_version_id = NULL,
              worker_name = NULL, dispatch_type = NULL, dispatch_binding_name = NULL, slot_id = NULL,
              route_generation = route_generation + 1, updated_at = ?
            WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE hostname_claims
            SET status = 'held', released_at = ?, reuse_hold_until = ?, release_reason = ?, updated_at = ?
            WHERE hostname = ? AND owner_system = 'v2' AND owner_id = ?
              AND status IN ('pending', 'active', 'held')`
        )
        .bind(now, reuseHoldUntil || null, releaseReason, now, route.hostname, siteId),
    ]);
    return this.getSite(siteId);
  },

  async transferSiteOwner(siteId, { ownerType, ownerId, ownerUserId, defaultVisibility, updatedAt, auditEvent }, environment) {
    const site = await this.getSite(siteId);
    if (!site || site.deletedAt) return null;
    if (environment && site.environment !== environment) return null;

    const nextOwnerType = ownerType || 'user';
    const now = updatedAt || this.now();
    const nextDefaultVisibility = defaultVisibility || site.defaultVisibility;
    const nextDefaultAccessMode = accessModeFromVisibility(nextDefaultVisibility);
    const statements = [
      this.db
        .prepare(
          `UPDATE sites
            SET owner_type = ?, owner_id = ?, owner_user_id = ?, default_visibility = ?, default_access_mode = ?, updated_at = ?
            WHERE id = ?${environment ? ' AND environment = ?' : ''} AND deleted_at IS NULL`
        )
        .bind(
          ...(environment
            ? [nextOwnerType, ownerId, ownerUserId, nextDefaultVisibility, nextDefaultAccessMode, now, siteId, environment]
            : [nextOwnerType, ownerId, ownerUserId, nextDefaultVisibility, nextDefaultAccessMode, now, siteId])
        ),
    ];

    if (nextOwnerType === 'user') {
      statements.push(
        this.db.prepare('DELETE FROM site_members WHERE site_id = ? AND user_id != ?').bind(siteId, ownerUserId),
        this.db
          .prepare(
            `INSERT INTO site_members (site_id, user_id, role, created_by, created_at)
              VALUES (?, ?, 'owner', ?, ?)
              ON CONFLICT(site_id, user_id) DO UPDATE SET role = 'owner'`
          )
          .bind(siteId, ownerUserId, ownerUserId, now)
      );
    }
    if (auditEvent) statements.push(this.auditEventStatement(auditEvent));

    await this.db.batch(statements);
    return this.getSite(siteId);
  },

  async insertHostnameClaim(claim, now = claim.acquiredAt || this.now()) {
    return this.db
      .prepare(
        `INSERT INTO hostname_claims (
            id, environment, hostname, normalized_slug, hostname_family, owner_system, owner_id,
            owner_ref, status, source, acquired_at, lease_expires_at, released_at, reuse_hold_until,
            release_reason, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM hostname_claims
            WHERE environment = ?
              AND normalized_slug = ?
              AND (
                status IN ('pending', 'active', 'conflicted')
                OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
              )
              AND hostname != ?
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
        now,
        claim.hostname
      )
      .run();
  },

  createHostnameClaimGuardStatement(claim) {
    return this.db
      .prepare(
        `INSERT INTO hostname_claims (id, environment)
          SELECT ?, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM hostname_claims
            WHERE hostname = ? AND owner_system = ? AND owner_id = ? AND status = ?
          )`
      )
      .bind(`claim_guard_${claim.id}`, claim.hostname, claim.ownerSystem, claim.ownerId, claim.status);
  },
};
