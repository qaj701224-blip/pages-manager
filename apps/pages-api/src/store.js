export function createPagesStore(env = {}) {
  if (env.PAGES_STORE) return env.PAGES_STORE;
  if (!env.PAGES_METADATA) throw new Error('PAGES_METADATA binding is required');
  return new D1PagesStore(env.PAGES_METADATA, {
    secretEncryptionKey: env.SITE_SECRET_ENCRYPTION_KEY || env.PAGES_SECRET_ENCRYPTION_KEY,
  });
}

export class D1PagesStore {
  constructor(db, { now = () => new Date().toISOString(), secretEncryptionKey = null } = {}) {
    this.db = db;
    this.now = now;
    this.secretEncryptionKey = secretEncryptionKey;
  }

  async createUser(input) {
    const now = this.now();
    const userId = input.userId || input.id;
    const record = {
      id: userId,
      email: input.email,
      realname: input.realname || null,
      account: input.account || null,
      accountId: input.accountId || null,
      employeenum: input.employeenum || null,
      employeeStatus: input.employeeStatus || 'unknown',
      sessionVersion: input.sessionVersion || 1,
      lastLoginAt: input.lastLoginAt || null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO users (
          user_id, account, account_id, email, realname, employeenum, employee_status, session_version,
          last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.account,
        record.accountId,
        record.email,
        record.realname,
        record.employeenum,
        record.employeeStatus,
        record.sessionVersion,
        record.lastLoginAt,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(record);
  }

  async upsertUserFromSso(input) {
    const userId = input.userId || input.id;
    const now = input.updatedAt || this.now();
    const incomingSessionVersion = input.sessionVersion || 1;
    const record = {
      id: userId,
      email: input.email,
      realname: input.realname || null,
      account: input.account || null,
      accountId: input.accountId || null,
      employeenum: input.employeenum || null,
      employeeStatus: input.employeeStatus || 'unknown',
      sessionVersion: incomingSessionVersion,
      lastLoginAt: input.lastLoginAt || now,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO users (
          user_id, account, account_id, email, realname, employeenum, employee_status, session_version,
          last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          account = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.account
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.account
            ELSE COALESCE(excluded.account, users.account)
          END,
          account_id = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.account_id
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.account_id
            ELSE COALESCE(excluded.account_id, users.account_id)
          END,
          email = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.email
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.email
            ELSE excluded.email
          END,
          realname = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.realname
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.realname
            ELSE COALESCE(excluded.realname, users.realname)
          END,
          employeenum = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.employeenum
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.employeenum
            ELSE COALESCE(excluded.employeenum, users.employeenum)
          END,
          employee_status = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.employee_status
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.employee_status
            ELSE excluded.employee_status
          END,
          session_version = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.session_version
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.session_version
            WHEN users.employee_status = CASE
              WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.employee_status
              WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
                THEN users.employee_status
              ELSE excluded.employee_status
            END
              THEN MAX(users.session_version, excluded.session_version)
            ELSE MAX(users.session_version + 1, excluded.session_version)
          END,
          last_login_at = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.last_login_at
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.last_login_at
            ELSE excluded.last_login_at
          END,
          updated_at = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.updated_at
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.updated_at
            ELSE excluded.updated_at
          END`
      )
      .bind(
        record.id,
        record.account,
        record.accountId,
        record.email,
        record.realname,
        record.employeenum,
        record.employeeStatus,
        record.sessionVersion,
        record.lastLoginAt,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return this.getUser(userId);
  }

  async getUser(id) {
    const row = await this.db.prepare('SELECT * FROM users WHERE user_id = ?').bind(id).first();
    return row ? mapUser(row) : null;
  }

  async createSite(input) {
    const now = this.now();
    if (await this.findSiteBySlug(input.environment, input.slug)) throw new Error('SITE_SLUG_CONFLICT');

    const site = {
      id: input.id,
      slug: input.slug,
      environment: input.environment,
      ownerUserId: input.ownerUserId,
      defaultVisibility: input.defaultVisibility,
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
              id, slug, environment, owner_user_id, default_visibility, execution_mode_override, site_uuid,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            site.id,
            site.slug,
            site.environment,
            site.ownerUserId,
            site.defaultVisibility,
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
              active_version_id, visibility, policy_version, route_generation,
              runtime_config_generation, runtime_config_lock_id, route_status, cache_tier, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            route.policyVersion,
            route.routeGeneration,
            route.runtimeConfigGeneration,
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
  }

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
  }

  async getHostnameClaim(hostname) {
    const row = await this.db.prepare('SELECT * FROM hostname_claims WHERE hostname = ?').bind(hostname).first();
    return row ? mapHostnameClaim(row) : null;
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  async findSiteBySlug(environment, slug) {
    const row = await this.db
      .prepare('SELECT * FROM sites WHERE environment = ? AND slug = ? AND deleted_at IS NULL')
      .bind(environment, slug)
      .first();
    return row ? mapSite(row) : null;
  }

  async getSite(id) {
    const row = await this.db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
    return row ? mapSite(row) : null;
  }

  async listSitesForUser(userId, actor = {}, environment) {
    const siteScope = actor.type === 'access_key' && actor.siteId ? actor.siteId : null;
    if (actor.type === 'access_key') {
      if (!siteScope) return [];
      const result = await this.db
        .prepare(
          `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
            site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
            site_routes.execution_provider AS route_execution_provider,
            site_routes.dispatch_type AS route_dispatch_type,
            site_routes.dispatch_binding_name AS route_dispatch_binding_name,
            site_routes.slot_id AS route_slot_id,
            site_routes.active_version_id AS route_active_version_id,
            site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
            site_routes.route_generation AS route_route_generation,
            site_routes.runtime_config_generation AS route_runtime_config_generation,
            site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
          FROM sites
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          WHERE sites.id = ? AND sites.deleted_at IS NULL
            ${environment ? 'AND sites.environment = ?' : ''}
          ORDER BY sites.created_at DESC`
        )
        .bind(...(environment ? [siteScope, environment] : [siteScope]))
        .all();
      return (result.results || []).map(mapSiteWithJoinedRoute);
    }

    const query = `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
        FROM sites
        JOIN site_members ON site_members.site_id = sites.id
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE site_members.user_id = ? AND sites.deleted_at IS NULL
          ${environment ? 'AND sites.environment = ?' : ''}
        ORDER BY sites.created_at DESC`;
    const binds = [userId];
    if (environment) binds.push(environment);
    const result = await this.db
      .prepare(query)
      .bind(...binds)
      .all();
    return (result.results || []).map(mapSiteWithJoinedRoute);
  }

  async getSiteForUser(siteId, userId, actor = {}, environment) {
    if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return null;
    const accessKeyActor = actor.type === 'access_key';
    if (accessKeyActor && !actor.siteId) return null;

    const row = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
        FROM sites
        ${accessKeyActor ? '' : 'JOIN site_members ON site_members.site_id = sites.id'}
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE sites.id = ?${accessKeyActor ? '' : ' AND site_members.user_id = ?'} AND sites.deleted_at IS NULL` +
          (environment ? ' AND sites.environment = ?' : '')
      )
      .bind(
        ...(environment
          ? [siteId, ...(accessKeyActor ? [] : [userId]), environment]
          : [siteId, ...(accessKeyActor ? [] : [userId])])
      )
      .first();
    return row ? mapSiteWithJoinedRoute(row) : null;
  }

  async listSiteMembers(siteId) {
    const result = await this.db.prepare('SELECT * FROM site_members WHERE site_id = ?').bind(siteId).all();
    return (result.results || []).map(mapSiteMember);
  }

  async listSiteAclEntries(siteId) {
    const result = await this.db
      .prepare('SELECT * FROM site_acl_entries WHERE site_id = ? ORDER BY created_at ASC, id ASC')
      .bind(siteId)
      .all();
    return (result.results || []).map(mapSiteAclEntry);
  }

  async getRouteBySiteId(siteId, environment) {
    const row = await this.db
      .prepare('SELECT * FROM site_routes WHERE site_id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .first();
    return row ? mapSiteRoute(row) : null;
  }

  async updateSiteVisibility(siteId, { visibility, updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return null;
    const now = updatedAt || this.now();
    const cacheTier = cacheTierForVisibility(visibility);
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE sites SET default_visibility = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [visibility, now, siteId, environment] : [visibility, now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET visibility = ?, policy_version = policy_version + 1,
            cache_tier = ?, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [visibility, cacheTier, now, siteId, environment] : [visibility, cacheTier, now, siteId])),
    ]);
    return this.getRouteBySiteId(siteId, environment);
  }

  async restoreSiteVisibility(siteId, previousSite, previousRoute, environment) {
    return this.restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, null, environment);
  }

  async restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, expectedRoute, environment) {
    if (!previousRoute) return null;
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (expectedRoute && !routesMatchIgnoringRuntimeConfigGeneration(currentRoute, expectedRoute)) {
      return currentRoute;
    }
    await this.db
      .prepare(`UPDATE sites SET default_visibility = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
      .bind(
        ...(environment
          ? [previousSite.defaultVisibility, previousSite.updatedAt, siteId, environment]
          : [previousSite.defaultVisibility, previousSite.updatedAt, siteId])
      )
      .run();
    return this.restoreSiteRoute(siteId, routeWithLatestRuntimeConfig(previousRoute, currentRoute), environment);
  }

  async replaceSiteAclEntries(siteId, entries, { createdBy, updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return [];
    const now = updatedAt || this.now();
    const statements = [
      this.db.prepare('DELETE FROM site_acl_entries WHERE site_id = ?').bind(siteId),
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET policy_version = policy_version + 1, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
    ];
    for (const entry of entries) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO site_acl_entries (
              id, site_id, subject_type, subject_value, access_role,
              effect, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(entry.id, siteId, entry.subjectType, entry.subjectValue, entry.accessRole, entry.effect, createdBy, now)
      );
    }
    await this.db.batch(statements);
    return this.listSiteAclEntries(siteId);
  }

  async addSiteAclEntries(siteId, entries, { createdBy, updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return [];
    const existing = await this.listSiteAclEntries(siteId);
    const existingKeys = new Set(existing.map(siteAclEntryKey));
    const entriesToInsert = entries.filter((entry) => !existingKeys.has(siteAclEntryKey(entry)));
    if (entriesToInsert.length === 0) return existing;

    const now = updatedAt || this.now();
    const statements = [
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET policy_version = policy_version + 1, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
    ];
    for (const entry of entriesToInsert) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO site_acl_entries (
              id, site_id, subject_type, subject_value, access_role,
              effect, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(entry.id, siteId, entry.subjectType, entry.subjectValue, entry.accessRole, entry.effect, createdBy, now)
      );
    }
    await this.db.batch(statements);
    return this.listSiteAclEntries(siteId);
  }

  async removeSiteAclEntries(siteId, entries, { updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return [];
    const existing = await this.listSiteAclEntries(siteId);
    const removedKeys = new Set(entries.map(siteAclEntryKey));
    if (existing.every((entry) => !removedKeys.has(siteAclEntryKey(entry)))) return existing;

    const now = updatedAt || this.now();
    const conditions = entries
      .map(() => '(subject_type = ? AND subject_value = ? AND access_role = ? AND effect = ?)')
      .join(' OR ');
    const deleteBinds = entries.flatMap((entry) => [
      entry.subjectType,
      entry.subjectValue,
      entry.accessRole,
      entry.effect,
    ]);
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM site_acl_entries WHERE site_id = ? AND (${conditions})`)
        .bind(siteId, ...deleteBinds),
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET policy_version = policy_version + 1, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
    ]);
    return this.listSiteAclEntries(siteId);
  }

  async restoreSiteAclEntries(siteId, previousEntries, previousRoute, previousSite, environment) {
    return this.restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, null, environment);
  }

  async restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, expectedRoute, environment) {
    if (!previousRoute) return [];
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (expectedRoute && !routesMatchIgnoringRuntimeConfigGeneration(currentRoute, expectedRoute)) {
      return this.listSiteAclEntries(siteId);
    }
    const statements = [
      this.db.prepare('DELETE FROM site_acl_entries WHERE site_id = ?').bind(siteId),
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [previousSite.updatedAt, siteId, environment] : [previousSite.updatedAt, siteId])),
    ];
    for (const entry of previousEntries) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO site_acl_entries (
              id, site_id, subject_type, subject_value, access_role,
              effect, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            entry.id,
            siteId,
            entry.subjectType,
            entry.subjectValue,
            entry.accessRole,
            entry.effect,
            entry.createdBy,
            entry.createdAt
          )
      );
    }
    await this.db.batch(statements);
    await this.restoreSiteRoute(siteId, routeWithLatestRuntimeConfig(previousRoute, currentRoute), environment);
    return this.listSiteAclEntries(siteId);
  }

  async createSiteVersion(input) {
    const now = this.now();
    const record = {
      id: input.id,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      workerName: input.workerName,
      runtime: input.runtime,
      executionProvider: input.executionProvider || executionProviderFromRuntime(input.runtime),
      dispatchType: input.dispatchType || dispatchTypeFromExecutionProvider(input.executionProvider),
      dispatchBindingName: input.dispatchBindingName || null,
      slotId: input.slotId || null,
      artifactRef: input.artifactRef,
      contentHash: input.contentHash,
      deploymentShape: input.deploymentShape,
      requestedFallback: input.requestedFallback,
      resolvedFallback: input.resolvedFallback || null,
      routingMode: input.routingMode,
      workerEntry: input.workerEntry || null,
      assetsConfigJson: input.assetsConfigJson ?? null,
      workerModulesJson: input.workerModulesJson ?? null,
      assetManifestJson: input.assetManifestJson ?? null,
      canonicalContentHash: input.canonicalContentHash || input.contentHash,
      varNamesJson: input.varNamesJson ?? null,
      secretNamesJson: input.secretNamesJson ?? null,
      runtimeConfigSnapshotJson: input.runtimeConfigSnapshotJson ?? null,
      artifactAvailability: input.artifactAvailability || 'active',
      createdBy: input.createdBy,
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO site_versions (
          id, site_id, deployment_id, worker_name, runtime, execution_provider,
          dispatch_type, dispatch_binding_name, slot_id,
          artifact_ref, content_hash, deployment_shape, requested_fallback,
          resolved_fallback, routing_mode, worker_entry, assets_config_json,
          worker_modules_json, asset_manifest_json, canonical_content_hash,
          var_names_json, secret_names_json, runtime_config_snapshot_json,
          artifact_availability, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.siteId,
        record.deploymentId,
        record.workerName,
        record.runtime,
        record.executionProvider,
        record.dispatchType,
        record.dispatchBindingName,
        record.slotId,
        record.artifactRef,
        record.contentHash,
        record.deploymentShape,
        record.requestedFallback,
        record.resolvedFallback,
        record.routingMode,
        record.workerEntry,
        stringifyJsonColumn(record.assetsConfigJson),
        stringifyJsonColumn(record.workerModulesJson),
        stringifyJsonColumn(record.assetManifestJson),
        record.canonicalContentHash,
        stringifyJsonColumn(record.varNamesJson),
        stringifyJsonColumn(record.secretNamesJson),
        stringifyJsonColumn(record.runtimeConfigSnapshotJson),
        record.artifactAvailability,
        record.createdBy,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  }

  async putSiteSecret(input) {
    const now = input.updatedAt || this.now();
    const encryptedValue = await encryptSiteSecretValue(input.value, this.secretEncryptionKey);
    const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
    const revision = (await this.nextSiteSecretRevision(input.environment, input.siteId, input.name)) + 1;
    const id = existing?.id || input.id;
    if (existing) {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE site_secrets
            SET encrypted_value = ?, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ? AND deleted_at IS NULL`
          )
          .bind(encryptedValue, revision, now, existing.id, Number(existing.revision || 0)),
        this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
          secretId: id,
          revision,
          encryptedValue,
        }),
      ]);
      if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
        throw new Error('SITE_SECRET_REVISION_CONFLICT');
      }
    } else {
      const results = await this.db.batch([
        this.siteSecretInsertStatement({
          id,
          environment: input.environment,
          siteId: input.siteId,
          name: input.name,
          encryptedValue,
          revision,
          createdBy: input.actorId || input.createdBy,
          createdAt: now,
          updatedAt: now,
        }),
        this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
          secretId: id,
          revision,
          encryptedValue,
        }),
      ]);
      if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
        throw new Error('SITE_SECRET_REVISION_CONFLICT');
      }
    }
    return {
      id,
      environment: input.environment,
      siteId: input.siteId,
      name: input.name,
      value: input.value,
      revision,
      createdBy: input.actorId || input.createdBy,
      createdAt: existing?.created_at || now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  async putSiteSecretWithAudit(input) {
    const now = input.updatedAt || this.now();
    const encryptedValue = await encryptSiteSecretValue(input.value, this.secretEncryptionKey);
    const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
    const revision = (await this.nextSiteSecretRevision(input.environment, input.siteId, input.name)) + 1;
    const id = existing?.id || input.id;
    const secretStatement = existing
      ? this.db
          .prepare(
            `UPDATE site_secrets
            SET encrypted_value = ?, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ? AND deleted_at IS NULL`
          )
          .bind(encryptedValue, revision, now, existing.id, Number(existing.revision || 0))
      : this.siteSecretInsertStatement({
            id,
            environment: input.environment,
            siteId: input.siteId,
            name: input.name,
            encryptedValue,
            revision,
            createdBy: input.actorId || input.createdBy,
            createdAt: now,
            updatedAt: now,
          });
    const auditRecord = secretAuditEvent(input, 'site_secret.put', { name: input.name, revision }, now);
    const auditStatement = this.siteSecretPutAuditEventStatement(auditRecord, {
      secretId: id,
      revision,
      encryptedValue,
      updatedAt: now,
    });
    const results = await this.db.batch([
      secretStatement,
      this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
        secretId: id,
        revision,
        encryptedValue,
      }),
      auditStatement,
    ]);
    if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1 || results?.[2]?.meta?.changes !== 1) {
      throw new Error('SITE_SECRET_REVISION_CONFLICT');
    }
    return {
      id,
      environment: input.environment,
      siteId: input.siteId,
      name: input.name,
      value: input.value,
      revision,
      createdBy: input.actorId || input.createdBy,
      createdAt: existing?.created_at || now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  async getLiveSiteSecretRow(environment, siteId, name) {
    return this.db
      .prepare(
        `SELECT * FROM site_secrets
        WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL`
      )
      .bind(environment, siteId, name)
      .first();
  }

  async nextSiteSecretRevision(environment, siteId, name) {
    const row = await this.db
      .prepare(
        `SELECT MAX(revision) AS max_revision FROM site_secrets
        WHERE environment = ? AND site_id = ? AND name = ?`
      )
      .bind(environment, siteId, name)
      .first();
    return Number(row?.max_revision || 0);
  }

  siteSecretInsertStatement({ id, environment, siteId, name, encryptedValue, revision, createdBy, createdAt, updatedAt }) {
    return this.db
      .prepare(
        `INSERT INTO site_secrets (
          id, environment, site_id, name, encrypted_value, revision,
          created_by, created_at, updated_at, deleted_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM site_secrets
          WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL
        )`
      )
      .bind(
        id,
        environment,
        siteId,
        name,
        encryptedValue,
        revision,
        createdBy,
        createdAt,
        updatedAt,
        environment,
        siteId,
        name
      );
  }

  bumpRuntimeConfigGenerationForPutStatement(environment, siteId, updatedAt, { secretId, revision, encryptedValue }) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
        WHERE environment = ? AND site_id = ?
          AND EXISTS (
            SELECT 1 FROM site_secrets
            WHERE id = ? AND revision = ? AND encrypted_value = ? AND deleted_at IS NULL
          )`
      )
      .bind(updatedAt, environment, siteId, secretId, revision, encryptedValue);
  }

  bumpRuntimeConfigGenerationForDeleteStatement(environment, siteId, updatedAt, { secretId, revision, deletedAt }) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
        WHERE environment = ? AND site_id = ?
          AND EXISTS (
            SELECT 1 FROM site_secrets
            WHERE id = ? AND revision = ? AND deleted_at = ?
          )`
      )
      .bind(updatedAt, environment, siteId, secretId, revision, deletedAt);
  }

  async deleteSiteSecret(environment, siteId, name, { deletedAt } = {}) {
    const now = deletedAt || this.now();
    const existing = await this.db
      .prepare(
        `SELECT * FROM site_secrets
        WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL`
      )
      .bind(environment, siteId, name)
      .first();
    if (!existing) return null;
    const results = await this.db.batch([
      this.db
        .prepare('UPDATE site_secrets SET deleted_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
        .bind(now, now, existing.id, Number(existing.revision || 0)),
      this.bumpRuntimeConfigGenerationForDeleteStatement(environment, siteId, now, {
        secretId: existing.id,
        revision: Number(existing.revision || 0),
        deletedAt: now,
      }),
    ]);
    if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
      throw new Error('SITE_SECRET_REVISION_CONFLICT');
    }
    return mapSiteSecretMetadata({ ...existing, deleted_at: now, updated_at: now });
  }

  async deleteSiteSecretWithAudit(input) {
    const now = input.deletedAt || this.now();
    const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
    const secret = existing ? mapSiteSecretMetadata({ ...existing, deleted_at: now, updated_at: now }) : null;
    if (!existing) {
      await this.auditEventStatement(secretAuditEvent(input, 'site_secret.delete', { name: input.name }, now)).run();
      return null;
    }
    const auditRecord = secretAuditEvent(input, 'site_secret.delete', secret, now);
    const results = await this.db.batch([
      this.db
        .prepare('UPDATE site_secrets SET deleted_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
        .bind(now, now, existing.id, Number(existing.revision || 0)),
      this.bumpRuntimeConfigGenerationForDeleteStatement(input.environment, input.siteId, now, {
        secretId: existing.id,
        revision: Number(existing.revision || 0),
        deletedAt: now,
      }),
      this.siteSecretDeleteAuditEventStatement(auditRecord, {
        secretId: existing.id,
        revision: Number(existing.revision || 0),
        deletedAt: now,
      }),
    ]);
    if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1 || results?.[2]?.meta?.changes !== 1) {
      throw new Error('SITE_SECRET_REVISION_CONFLICT');
    }
    return secret;
  }

  async listEnabledSiteSecrets(environment, siteId) {
    const result = await this.db
      .prepare(
        `SELECT * FROM site_secrets
        WHERE environment = ? AND site_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`
      )
      .bind(environment, siteId)
      .all();
    const secrets = [];
    for (const row of result.results || []) {
      secrets.push(await mapSiteSecret(row, this.secretEncryptionKey));
    }
    return secrets;
  }

  async listEnabledSiteVars(environment, siteId) {
    const result = await this.db
      .prepare(
        `SELECT * FROM site_vars
        WHERE environment = ? AND site_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`
      )
      .bind(environment, siteId)
      .all();
    return (result.results || []).map(mapSiteVar);
  }

  async replaceSiteVars(input) {
    const now = input.updatedAt || this.now();
    const vars = input.vars || {};
    const lockId = input.lockId || randomStoreId('runtime_lock');
    const lock = await this.acquireRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
    if (lock?.meta?.changes !== 1) throw new Error('SITE_VAR_REVISION_CONFLICT');

    let released = false;
    try {
      const routeState = await this.getRuntimeConfigRouteState(input.environment, input.siteId);
      if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('SITE_VAR_REVISION_CONFLICT');
      const liveVars = await this.listEnabledSiteVars(input.environment, input.siteId);
      const liveByName = new Map(liveVars.map((record) => [record.name, record]));
      const desiredNames = Object.keys(vars).sort();
      const liveNames = [...liveByName.keys()].sort();
      const hasChanges =
        desiredNames.length !== liveNames.length ||
        desiredNames.some((name) => {
          const existing = liveByName.get(name);
          return !existing || existing.value !== vars[name];
        });
      if (!hasChanges) {
        const release = await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
        released = release?.meta?.changes === 1;
        if (!released) throw new Error('SITE_VAR_REVISION_CONFLICT');
        return liveVars;
      }

      const statements = [];
      for (const name of desiredNames) {
        const existing = liveByName.get(name);
        if (existing && existing.value === vars[name]) continue;
        const revision = (await this.nextSiteVarRevision(input.environment, input.siteId, name)) + 1;
        if (existing) {
          this.pushRuntimeChangeStatement(
            statements,
            this.db
              .prepare(
                `UPDATE site_vars
                SET value = ?, revision = ?, updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                  AND EXISTS (
                    SELECT 1 FROM site_routes
                    WHERE environment = ? AND site_id = ?
                      AND runtime_config_lock_id = ?
                  )`
              )
              .bind(vars[name], revision, now, existing.id, input.environment, input.siteId, lockId)
          );
        } else {
          const id = input.createId ? input.createId(name) : randomStoreId('var');
          this.pushRuntimeChangeStatement(
            statements,
            this.siteVarInsertStatement({
              id,
              environment: input.environment,
              siteId: input.siteId,
              name,
              value: vars[name],
              revision,
              createdBy: input.actorId || input.createdBy,
              createdAt: now,
              updatedAt: now,
              lockId,
            })
          );
        }
      }
      for (const name of liveNames) {
        if (desiredNames.includes(name)) continue;
        const existing = liveByName.get(name);
        this.pushRuntimeChangeStatement(
          statements,
          this.db
            .prepare(
              `UPDATE site_vars
              SET deleted_at = ?, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM site_routes
                  WHERE environment = ? AND site_id = ?
                    AND runtime_config_lock_id = ?
                )`
            )
            .bind(now, now, existing.id, input.environment, input.siteId, lockId)
        );
      }
      this.pushRuntimeChangeStatement(
        statements,
        this.bumpRuntimeConfigGenerationAndReleaseLockStatement(input.environment, input.siteId, now, lockId)
      );

      await this.db.batch(statements);
      released = true;
      return this.listEnabledSiteVars(input.environment, input.siteId);
    } catch (error) {
      if (!released) {
        try {
          await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
        } catch {
          // Best effort: the next runtime config operation will fail closed if the lock remains.
        }
      }
      throw error;
    }
  }

  async getRuntimeConfigRouteState(environment, siteId) {
    const row = await this.db
      .prepare(
        `SELECT runtime_config_generation, runtime_config_lock_id
        FROM site_routes
        WHERE environment = ? AND site_id = ?`
      )
      .bind(environment, siteId)
      .first();
    return row
      ? {
          runtimeConfigGeneration: row.runtime_config_generation || 0,
          runtimeConfigLockId: row.runtime_config_lock_id || null,
        }
      : null;
  }

  async nextSiteVarRevision(environment, siteId, name) {
    const row = await this.db
      .prepare(
        `SELECT MAX(revision) AS max_revision FROM site_vars
        WHERE environment = ? AND site_id = ? AND name = ?`
      )
      .bind(environment, siteId, name)
      .first();
    return Number(row?.max_revision || 0);
  }

  siteVarInsertStatement({
    id,
    environment,
    siteId,
    name,
    value,
    revision,
    createdBy,
    createdAt,
    updatedAt,
    lockId,
  }) {
    return this.db
      .prepare(
        `INSERT INTO site_vars (
          id, environment, site_id, name, value, revision,
          created_by, created_at, updated_at, deleted_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
        WHERE EXISTS (
          SELECT 1 FROM site_routes
          WHERE environment = ? AND site_id = ?
            AND runtime_config_lock_id = ?
        )`
      )
      .bind(
        id,
        environment,
        siteId,
        name,
        value,
        revision,
        createdBy,
        createdAt,
        updatedAt,
        environment,
        siteId,
        lockId
      );
  }

  acquireRuntimeConfigLockStatement(environment, siteId, lockId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_lock_id = ?, updated_at = ?
        WHERE environment = ? AND site_id = ? AND runtime_config_lock_id IS NULL`
      )
      .bind(lockId, updatedAt, environment, siteId);
  }

  releaseRuntimeConfigLockStatement(environment, siteId, lockId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_lock_id = NULL, updated_at = ?
        WHERE environment = ? AND site_id = ? AND runtime_config_lock_id = ?`
      )
      .bind(updatedAt, environment, siteId, lockId);
  }

  bumpRuntimeConfigGenerationAndReleaseLockStatement(environment, siteId, updatedAt, lockId) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1,
          runtime_config_lock_id = NULL,
          updated_at = ?
        WHERE environment = ? AND site_id = ?
          AND runtime_config_lock_id = ?`
      )
      .bind(updatedAt, environment, siteId, lockId);
  }

  pushRuntimeChangeStatement(statements, statement) {
    statements.push(statement, this.runtimeChangeGuardStatement());
  }

  runtimeChangeGuardStatement(errorCode = 'SITE_VAR_REVISION_CONFLICT') {
    return this.db
      .prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`)
      .bind(errorCode);
  }

  bumpRuntimeConfigGenerationStatement(environment, siteId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
        WHERE environment = ? AND site_id = ?`
      )
      .bind(updatedAt, environment, siteId);
  }

  async recordAuditEvent(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id,
      traceId: input.traceId || null,
      eventType: input.eventType,
      actorUserId: input.actorUserId || null,
      actorType: input.actorType,
      siteId: input.siteId || null,
      routeId: input.routeId || null,
      versionId: input.versionId || null,
      decision: input.decision,
      statusCode: input.statusCode ?? null,
      ipHash: input.ipHash || null,
      userAgentHash: input.userAgentHash || null,
      metadata: input.metadata || null,
      createdAt: now,
    };
    await this.auditEventStatement(record).run();
    return cloneRecord(record);
  }

  auditEventStatement(record) {
    return this.db
      .prepare(
        `INSERT INTO audit_events (
          id, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
          decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt
      );
  }

  siteSecretPutAuditEventStatement(record, { secretId, revision, encryptedValue, updatedAt }) {
    return this.db
      .prepare(
        `INSERT INTO audit_events (
          id, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
          decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM site_secrets
        WHERE id = ? AND revision = ? AND encrypted_value = ? AND updated_at = ? AND deleted_at IS NULL`
      )
      .bind(
        record.id,
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt,
        secretId,
        revision,
        encryptedValue,
        updatedAt
      );
  }

  siteSecretDeleteAuditEventStatement(record, { secretId, revision, deletedAt }) {
    return this.db
      .prepare(
        `INSERT INTO audit_events (
          id, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
          decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM site_secrets
        WHERE id = ? AND revision = ? AND deleted_at = ?`
      )
      .bind(
        record.id,
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt,
        secretId,
        revision,
        deletedAt
      );
  }

  async activateSiteVersion(
    siteId,
    {
      activeVersionId,
      workerName,
      runtime = 'worker',
      executionProvider,
      dispatchType,
      dispatchBindingName = null,
      slotId = null,
      visibility,
      updatedAt,
    },
    environment,
    expectedRoute = null
  ) {
    const expectedConditions = expectedRoute
      ? ' AND route_generation = ? AND policy_version = ? AND runtime_config_generation = ? AND active_version_id IS ?'
      : '';
    const result = await this.db
      .prepare(
        `UPDATE site_routes
        SET active_version_id = ?, worker_name = ?, runtime = ?,
          execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
          visibility = ?, route_status = 'active', route_generation = route_generation + 1,
          updated_at = ?
        WHERE site_id = ?${environment ? ' AND environment = ?' : ''}${expectedConditions}`
      )
      .bind(
        ...(environment
          ? [
              activeVersionId,
              workerName,
              runtime,
              executionProvider,
              dispatchType,
              dispatchBindingName,
              slotId,
              visibility,
              updatedAt,
              siteId,
              environment,
              ...(expectedRoute
                ? [
                    expectedRoute.routeGeneration,
                    expectedRoute.policyVersion,
                    expectedRoute.runtimeConfigGeneration || 0,
                    expectedRoute.activeVersionId,
                  ]
                : []),
            ]
          : [
              activeVersionId,
              workerName,
              runtime,
              executionProvider,
              dispatchType,
              dispatchBindingName,
              slotId,
              visibility,
              updatedAt,
              siteId,
              ...(expectedRoute
                ? [
                    expectedRoute.routeGeneration,
                    expectedRoute.policyVersion,
                    expectedRoute.runtimeConfigGeneration || 0,
                    expectedRoute.activeVersionId,
                  ]
                : []),
            ])
      )
      .run();
    if (expectedRoute && result?.meta?.changes === 0) return null;
    return this.getRouteBySiteId(siteId, environment);
  }

  async restoreSiteRoute(siteId, route, environment) {
    if (!route) return null;
    await this.db
      .prepare(
        `UPDATE site_routes
        SET active_version_id = ?, worker_name = ?, runtime = ?,
          execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
          visibility = ?, policy_version = ?, route_generation = ?,
          runtime_config_generation = ?, route_status = ?, cache_tier = ?, updated_at = ?
        WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
      )
      .bind(
        ...(environment
          ? [
              route.activeVersionId,
              route.workerName,
              route.runtime,
              route.executionProvider,
              route.dispatchType,
              route.dispatchBindingName,
              route.slotId,
              route.visibility,
              route.policyVersion,
              route.routeGeneration,
              route.runtimeConfigGeneration || 0,
              route.routeStatus,
              route.cacheTier,
              route.updatedAt,
              siteId,
              environment,
            ]
          : [
              route.activeVersionId,
              route.workerName,
              route.runtime,
              route.executionProvider,
              route.dispatchType,
              route.dispatchBindingName,
              route.slotId,
              route.visibility,
              route.policyVersion,
              route.routeGeneration,
              route.runtimeConfigGeneration || 0,
              route.routeStatus,
              route.cacheTier,
              route.updatedAt,
              siteId,
            ])
      )
      .run();
    return this.getRouteBySiteId(siteId, environment);
  }

  async restoreSiteRouteIfCurrent(siteId, previousRoute, expectedRoute, environment) {
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (!routesMatchExecutionState(currentRoute, expectedRoute)) {
      return currentRoute;
    }
    return this.restoreSiteRoute(
      siteId,
      routeRestoredAsNewCommit(previousRoute, currentRoute),
      environment
    );
  }

  async getSiteVersion(id, environment) {
    const row = await this.db
      .prepare(
        `SELECT site_versions.*
        FROM site_versions
        JOIN sites ON sites.id = site_versions.site_id
        WHERE site_versions.id = ?${environment ? ' AND sites.environment = ?' : ''}`
      )
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapSiteVersion(row) : null;
  }

  async createWorkerSlot(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id,
      environment: input.environment,
      slotNumber: input.slotNumber,
      workerName: input.workerName,
      bindingName: input.bindingName,
      status: input.status || 'provisioning',
      assignedSiteId: input.assignedSiteId || null,
      assignedRouteId: input.assignedRouteId || null,
      assignedVersionId: input.assignedVersionId || null,
      assignedAt: input.assignedAt || null,
      lastDeployedVersionId: input.lastDeployedVersionId || null,
      lastSeenAt: input.lastSeenAt || null,
      healthStatus: input.healthStatus || 'unknown',
      notes: input.notes || null,
      createdAt: now,
      updatedAt: input.updatedAt || now,
    };
    await this.db
      .prepare(
        `INSERT INTO worker_slots (
          id, environment, slot_number, worker_name, binding_name, status,
          assigned_site_id, assigned_route_id, assigned_version_id, assigned_at,
          last_deployed_version_id, last_seen_at, health_status, notes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.slotNumber,
        record.workerName,
        record.bindingName,
        record.status,
        record.assignedSiteId,
        record.assignedRouteId,
        record.assignedVersionId,
        record.assignedAt,
        record.lastDeployedVersionId,
        record.lastSeenAt,
        record.healthStatus,
        record.notes,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(record);
  }

  async getWorkerSlot(id) {
    const row = await this.db.prepare('SELECT * FROM worker_slots WHERE id = ?').bind(id).first();
    return row ? mapWorkerSlot(row) : null;
  }

  async listWorkerSlots(environment) {
    const result = await this.db
      .prepare(
        `SELECT * FROM worker_slots
        WHERE environment = ?
        ORDER BY slot_number ASC`
      )
      .bind(environment)
      .all();
    return (result.results || []).map(mapWorkerSlot);
  }

  async assignAvailableWorkerSlot({ environment, siteId, routeId, versionId, assignedAt }) {
    const slotsResult = await this.db
      .prepare(
        `SELECT * FROM worker_slots
        WHERE environment = ? AND status = 'available'
        ORDER BY slot_number ASC
        LIMIT 20`
      )
      .bind(environment)
      .all();
    const slots = slotsResult?.results || [];
    if (slots.length === 0) return null;
    const now = assignedAt || this.now();
    for (const slot of slots) {
      const result = await this.db
        .prepare(
          `UPDATE worker_slots
          SET status = 'assigned', assigned_site_id = ?, assigned_route_id = ?,
            assigned_version_id = ?, assigned_at = ?, last_deployed_version_id = ?,
            updated_at = ?
          WHERE id = ? AND status = 'available'`
        )
        .bind(siteId, routeId, versionId, now, versionId, now, slot.id)
        .run();
      if (!result?.meta || result.meta.changes !== 0) return this.getWorkerSlot(slot.id);
    }
    return null;
  }

  async releaseWorkerSlot(id, { status = 'available', updatedAt } = {}) {
    const now = updatedAt || this.now();
    await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = ?, assigned_site_id = NULL, assigned_route_id = NULL,
          assigned_version_id = NULL, assigned_at = NULL, updated_at = ?
        WHERE id = ?`
      )
      .bind(status, now, id)
      .run();
    return this.getWorkerSlot(id);
  }

  async markWorkerSlotCleanupPending(id, { expectedVersionId, updatedAt } = {}) {
    if (!expectedVersionId) return null;
    const now = updatedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = 'cleanup_pending', updated_at = ?
        WHERE id = ?
          AND status = 'assigned'
          AND assigned_version_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
          )`
      )
      .bind(now, id, expectedVersionId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getWorkerSlot(id);
  }

  async releaseCleanupWorkerSlot(id, { expectedVersionId, updatedAt } = {}) {
    if (!expectedVersionId) return null;
    const now = updatedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = 'available',
          assigned_site_id = NULL,
          assigned_route_id = NULL,
          assigned_version_id = NULL,
          assigned_at = NULL,
          last_deployed_version_id = COALESCE(last_deployed_version_id, ?),
          updated_at = ?
        WHERE id = ?
          AND status = 'cleanup_pending'
          AND assigned_version_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
          )`
      )
      .bind(expectedVersionId, now, id, expectedVersionId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getWorkerSlot(id);
  }

  async createAccessKey(input) {
    if ('plaintext' in input) throw new Error('ACCESS_KEY_PLAINTEXT_FORBIDDEN');
    const now = this.now();
    const record = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      keyHash: input.keyHash,
      pepperId: input.pepperId,
      name: input.name,
      scopes: [...input.scopes],
      siteId: input.siteId || null,
      expiresAt: input.expiresAt || null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO access_keys (
          id, owner_user_id, key_hash, pepper_id, name, scopes_json, site_id,
          expires_at, last_used_at, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.ownerUserId,
        record.keyHash,
        record.pepperId,
        record.name,
        JSON.stringify(record.scopes),
        record.siteId,
        record.expiresAt,
        record.lastUsedAt,
        record.revokedAt,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  }

  async getAccessKeyById(id, environment) {
    const row = await this.db
      .prepare(
        `SELECT access_keys.*
        FROM access_keys
        LEFT JOIN sites ON sites.id = access_keys.site_id
        WHERE access_keys.id = ?${environment ? ' AND (access_keys.site_id IS NULL OR sites.environment = ?)' : ''}`
      )
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapAccessKey(row) : null;
  }

  async listAccessKeysForOwner(ownerUserId, environment) {
    const result = await this.db
      .prepare(
        `SELECT access_keys.*
        FROM access_keys
        LEFT JOIN sites ON sites.id = access_keys.site_id
        WHERE access_keys.owner_user_id = ?
          ${environment ? 'AND (access_keys.site_id IS NULL OR sites.environment = ?)' : ''}
        ORDER BY access_keys.created_at DESC`
      )
      .bind(...(environment ? [ownerUserId, environment] : [ownerUserId]))
      .all();
    return (result.results || []).map(mapAccessKey);
  }

  async updateAccessKeyLastUsed(id, lastUsedAt) {
    await this.db.prepare('UPDATE access_keys SET last_used_at = ? WHERE id = ?').bind(lastUsedAt, id).run();
    return this.getAccessKeyById(id);
  }

  async revokeAccessKey(id, revokedAt) {
    await this.db.prepare('UPDATE access_keys SET revoked_at = ? WHERE id = ?').bind(revokedAt, id).run();
    return this.getAccessKeyById(id);
  }

  async getDeployment(id, environment) {
    const row = await this.db
      .prepare('SELECT * FROM deployments WHERE id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapDeployment(row) : null;
  }

  async updateDeployment(id, patch) {
    const existing = await this.getDeployment(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    await this.db
      .prepare(
        `UPDATE deployments SET
          version_id = ?, status = ?, terminal_response_json = ?, previous_version_id = ?,
          error_code = ?, error_message = ?, completed_at = ?
        WHERE id = ?`
      )
      .bind(
        next.versionId,
        next.status,
        next.terminalResponseJson,
        next.previousVersionId,
        next.errorCode,
        next.errorMessage,
        next.completedAt,
        id
      )
      .run();
    return this.getDeployment(id);
  }

  async createDeploymentForIdempotency(input) {
    const idempotencyScope = deploymentIdempotencyScope(input);
    const existing = await this.db
      .prepare('SELECT * FROM deployments WHERE idempotency_scope = ? AND idempotency_key = ?')
      .bind(idempotencyScope, input.idempotencyKey)
      .first();
    if (existing) {
      const deployment = mapDeployment(existing);
      if (deployment.requestHash !== input.requestHash) return { kind: 'conflict', deployment };
      return { kind: 'existing', deployment };
    }

    const now = this.now();
    const record = {
      id: input.id,
      environment: input.environment,
      siteId: input.siteId,
      versionId: input.versionId || null,
      actorId: input.actorId,
      actorUserId: input.actorUserId || null,
      actorType: input.actorType,
      source: input.source,
      operation: input.operation,
      visibility: input.visibility || null,
      status: input.status,
      idempotencyKey: input.idempotencyKey,
      idempotencyScope,
      requestHash: input.requestHash,
      terminalResponseJson: input.terminalResponseJson || null,
      previousVersionId: input.previousVersionId || null,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      createdAt: now,
      completedAt: input.completedAt || null,
    };
    await this.db
      .prepare(
        `INSERT INTO deployments (
          id, environment, site_id, version_id, actor_id, actor_user_id,
          actor_type, source, operation, visibility, status, idempotency_key,
          idempotency_scope, request_hash, terminal_response_json,
          previous_version_id, error_code, error_message, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.siteId,
        record.versionId,
        record.actorId,
        record.actorUserId,
        record.actorType,
        record.source,
        record.operation,
        record.visibility,
        record.status,
        record.idempotencyKey,
        record.idempotencyScope,
        record.requestHash,
        record.terminalResponseJson,
        record.previousVersionId,
        record.errorCode,
        record.errorMessage,
        record.createdAt,
        record.completedAt
      )
      .run();
    return { kind: 'created', deployment: cloneRecord(record) };
  }
}

export function deploymentIdempotencyScope({ environment, actorId, siteId, operation }) {
  return `${environment}:${actorId}:${siteId}:${operation}`;
}

export function cacheTierForVisibility(visibility) {
  if (visibility === 'disabled') return 'strict';
  if (visibility === 'acl' || visibility === 'owner') return 'sensitive';
  return 'fast';
}

export function createInitialRoute(input, now) {
  return {
    id: input.routeId,
    hostname: input.hostname,
    siteId: input.id,
    environment: input.environment,
    runtime: 'disabled',
    executionProvider: null,
    workerName: null,
    dispatchType: null,
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: null,
    visibility: input.defaultVisibility,
    policyVersion: 1,
    routeGeneration: 0,
    runtimeConfigGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: cacheTierForVisibility(input.defaultVisibility),
    createdAt: now,
    updatedAt: now,
  };
}

export function createOwnerMember(siteId, ownerUserId, now) {
  return {
    siteId,
    userId: ownerUserId,
    role: 'owner',
    createdBy: ownerUserId,
    createdAt: now,
  };
}

export function createHostnameClaim(input, now) {
  return {
    id: input.id || `claim_${input.ownerRef || input.ownerId}`,
    environment: input.environment,
    hostname: String(input.hostname || '').toLowerCase(),
    normalizedSlug: input.normalizedSlug,
    hostnameFamily: input.hostnameFamily || hostnameFamilyForHostname(input.hostname),
    ownerSystem: input.ownerSystem,
    ownerId: input.ownerId,
    ownerRef: input.ownerRef || null,
    status: input.status || 'active',
    source: input.source,
    acquiredAt: input.acquiredAt || now,
    leaseExpiresAt: input.leaseExpiresAt || null,
    releasedAt: input.releasedAt || null,
    reuseHoldUntil: input.reuseHoldUntil || null,
    releaseReason: input.releaseReason || null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

export function hostnameFamilyForHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (value.endsWith('.workers.xd.team')) return 'workers';
  if (value.endsWith('.pages.xd.team')) return 'pages';
  return 'custom';
}

export function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
}

function stringifyJsonColumn(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJsonColumn(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function routesMatch(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.id === expected.id &&
    actual.activeVersionId === expected.activeVersionId &&
    actual.workerName === expected.workerName &&
    actual.runtime === expected.runtime &&
    actual.executionProvider === expected.executionProvider &&
    actual.dispatchType === expected.dispatchType &&
    actual.dispatchBindingName === expected.dispatchBindingName &&
    actual.slotId === expected.slotId &&
    actual.visibility === expected.visibility &&
    actual.policyVersion === expected.policyVersion &&
    actual.routeGeneration === expected.routeGeneration &&
    (actual.runtimeConfigGeneration || 0) === (expected.runtimeConfigGeneration || 0) &&
    actual.routeStatus === expected.routeStatus
  );
}

function routesMatchIgnoringRuntimeConfigGeneration(actual, expected) {
  if (!actual || !expected) return false;
  return routesMatch(
    {
      ...actual,
      runtimeConfigGeneration: expected.runtimeConfigGeneration || 0,
    },
    expected
  );
}

function routesMatchExecutionState(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.id === expected.id &&
    actual.activeVersionId === expected.activeVersionId &&
    actual.workerName === expected.workerName &&
    actual.runtime === expected.runtime &&
    actual.executionProvider === expected.executionProvider &&
    actual.dispatchType === expected.dispatchType &&
    actual.dispatchBindingName === expected.dispatchBindingName &&
    actual.slotId === expected.slotId &&
    actual.routeGeneration === expected.routeGeneration &&
    actual.routeStatus === expected.routeStatus
  );
}

function routeWithLatestRuntimeConfig(route, latestRoute) {
  if (!route || !latestRoute) return route;
  return {
    ...route,
    runtimeConfigGeneration: latestRoute.runtimeConfigGeneration || 0,
    updatedAt: latestRoute.updatedAt,
  };
}

function routeRestoredAsNewCommit(previousRoute, currentRoute) {
  return {
    ...previousRoute,
    visibility: currentRoute.visibility,
    policyVersion: currentRoute.policyVersion,
    cacheTier: currentRoute.cacheTier,
    routeGeneration: Math.max(previousRoute.routeGeneration || 0, currentRoute.routeGeneration || 0) + 1,
    runtimeConfigGeneration: currentRoute.runtimeConfigGeneration || 0,
    updatedAt: currentRoute.updatedAt,
  };
}

function siteAclEntryKey(entry) {
  return `${entry.effect}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole}`;
}

function mapUser(row) {
  return {
    id: row.user_id,
    email: row.email,
    realname: row.realname,
    account: row.account,
    accountId: row.account_id,
    employeenum: row.employeenum,
    employeeStatus: row.employee_status,
    sessionVersion: row.session_version,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSite(row) {
  return {
    id: row.id,
    slug: row.slug,
    environment: row.environment,
    ownerUserId: row.owner_user_id,
    defaultVisibility: row.default_visibility,
    executionModeOverride: row.execution_mode_override || null,
    siteUuid: row.site_uuid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapSiteWithJoinedRoute(row) {
  const site = mapSite(row);
  site.route = row.route_id
    ? {
        id: row.route_id,
        hostname: row.route_hostname,
        siteId: site.id,
        environment: site.environment,
        runtime: row.route_runtime,
        executionProvider: row.route_execution_provider || executionProviderFromRuntime(row.route_runtime),
        workerName: row.route_worker_name,
        dispatchType:
          row.route_dispatch_type || dispatchTypeFromExecutionProvider(row.route_execution_provider || row.route_runtime),
        dispatchBindingName: row.route_dispatch_binding_name || null,
        slotId: row.route_slot_id || null,
        activeVersionId: row.route_active_version_id,
        visibility: row.route_visibility,
        policyVersion: row.route_policy_version,
        routeGeneration: row.route_route_generation,
        runtimeConfigGeneration: row.route_runtime_config_generation || 0,
        routeStatus: row.route_route_status,
        cacheTier: row.route_cache_tier,
        createdAt: row.route_created_at,
        updatedAt: row.route_updated_at,
      }
    : null;
  return site;
}

function mapSiteRoute(row) {
  return {
    id: row.id,
    hostname: row.hostname,
    siteId: row.site_id,
    environment: row.environment,
    runtime: row.runtime,
    executionProvider: row.execution_provider || executionProviderFromRuntime(row.runtime),
    workerName: row.worker_name,
    dispatchType: row.dispatch_type || dispatchTypeFromExecutionProvider(row.execution_provider || row.runtime),
    dispatchBindingName: row.dispatch_binding_name || null,
    slotId: row.slot_id || null,
    activeVersionId: row.active_version_id,
    visibility: row.visibility,
    policyVersion: row.policy_version,
    routeGeneration: row.route_generation,
    runtimeConfigGeneration: row.runtime_config_generation || 0,
    routeStatus: row.route_status,
    cacheTier: row.cache_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHostnameClaim(row) {
  return {
    id: row.id,
    environment: row.environment,
    hostname: row.hostname,
    normalizedSlug: row.normalized_slug,
    hostnameFamily: row.hostname_family,
    ownerSystem: row.owner_system,
    ownerId: row.owner_id,
    ownerRef: row.owner_ref,
    status: row.status,
    source: row.source,
    acquiredAt: row.acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    releasedAt: row.released_at,
    reuseHoldUntil: row.reuse_hold_until,
    releaseReason: row.release_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hostnameClaimOwnerMatches(existing, input) {
  return existing.ownerSystem === input.ownerSystem && existing.ownerId === input.ownerId;
}

function isSqliteConstraintError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /constraint|unique/i.test(message);
}

function mapSiteMember(row) {
  return {
    siteId: row.site_id,
    userId: row.user_id,
    role: row.role,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapSiteAclEntry(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    accessRole: row.access_role,
    effect: row.effect,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapSiteVersion(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    deploymentId: row.deployment_id,
    workerName: row.worker_name,
    runtime: row.runtime,
    executionProvider: row.execution_provider || executionProviderFromRuntime(row.runtime),
    dispatchType: row.dispatch_type || dispatchTypeFromExecutionProvider(row.execution_provider || row.runtime),
    dispatchBindingName: row.dispatch_binding_name || null,
    slotId: row.slot_id || null,
    artifactRef: row.artifact_ref,
    contentHash: row.content_hash,
    deploymentShape: row.deployment_shape || null,
    requestedFallback: row.requested_fallback || null,
    resolvedFallback: row.resolved_fallback || null,
    routingMode: row.routing_mode || null,
    workerEntry: row.worker_entry || null,
    assetsConfigJson: parseJsonColumn(row.assets_config_json),
    workerModulesJson: parseJsonColumn(row.worker_modules_json),
    assetManifestJson: parseJsonColumn(row.asset_manifest_json),
    canonicalContentHash: row.canonical_content_hash || row.content_hash,
    varNamesJson: parseJsonColumn(row.var_names_json),
    secretNamesJson: parseJsonColumn(row.secret_names_json),
    runtimeConfigSnapshotJson: parseJsonColumn(row.runtime_config_snapshot_json),
    artifactAvailability: row.artifact_availability || 'active',
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function mapSiteSecret(row, secretEncryptionKey) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    value: await decryptSiteSecretValue(row.encrypted_value, secretEncryptionKey),
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function mapSiteSecretMetadata(row) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function mapSiteVar(row) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    value: row.value,
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function randomStoreId(prefix) {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) throw new Error('STORE_ID_CRYPTO_UNAVAILABLE');
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function encryptSiteSecretValue(value, secretEncryptionKey) {
  if (!secretEncryptionKey) throw new Error('SITE_SECRET_ENCRYPTION_KEY_REQUIRED');
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle || !cryptoImpl.getRandomValues) throw new Error('SITE_SECRET_CRYPTO_UNAVAILABLE');
  const iv = new Uint8Array(12);
  cryptoImpl.getRandomValues(iv);
  const key = await importSiteSecretKey(secretEncryptionKey);
  const bytes = new globalThis.TextEncoder().encode(value);
  const encrypted = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(encrypted)}`;
}

async function decryptSiteSecretValue(value, secretEncryptionKey) {
  if (!secretEncryptionKey) throw new Error('SITE_SECRET_ENCRYPTION_KEY_REQUIRED');
  const parts = String(value || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('SITE_SECRET_CIPHERTEXT_INVALID');
  const key = await importSiteSecretKey(secretEncryptionKey);
  const iv = base64UrlDecode(parts[1]);
  const encrypted = base64UrlDecode(parts[2]);
  const decrypted = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

async function importSiteSecretKey(secretEncryptionKey) {
  const material = new globalThis.TextEncoder().encode(String(secretEncryptionKey));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
  return globalThis.crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function secretAuditEvent(input, eventType, secret, createdAt) {
  return {
    id: input.auditId,
    traceId: null,
    eventType,
    actorUserId: input.actorId,
    actorType: input.actorType,
    siteId: input.siteId,
    routeId: input.routeId || null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      siteSlug: input.siteSlug,
      revision: secret.revision ?? null,
    },
    createdAt,
  };
}

function mapWorkerSlot(row) {
  return {
    id: row.id,
    environment: row.environment,
    slotNumber: row.slot_number,
    workerName: row.worker_name,
    bindingName: row.binding_name,
    status: row.status,
    assignedSiteId: row.assigned_site_id,
    assignedRouteId: row.assigned_route_id,
    assignedVersionId: row.assigned_version_id,
    assignedAt: row.assigned_at,
    lastDeployedVersionId: row.last_deployed_version_id,
    lastSeenAt: row.last_seen_at,
    healthStatus: row.health_status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function executionProviderFromRuntime(runtime) {
  return runtime === 'wfp' ? 'wfp' : null;
}

function dispatchTypeFromExecutionProvider(value) {
  const executionProvider = executionProviderFromRuntime(value) || value;
  if (executionProvider === 'normal-worker-slot') return 'service-binding';
  if (executionProvider === 'wfp') return 'dispatch-namespace';
  return null;
}

function mapAccessKey(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    keyHash: row.key_hash,
    pepperId: row.pepper_id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json),
    siteId: row.site_id,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function mapDeployment(row) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    versionId: row.version_id,
    actorId: row.actor_id,
    actorUserId: row.actor_user_id,
    actorType: row.actor_type,
    source: row.source,
    operation: row.operation,
    visibility: row.visibility,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    idempotencyScope: row.idempotency_scope,
    requestHash: row.request_hash,
    terminalResponseJson: row.terminal_response_json,
    previousVersionId: row.previous_version_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
