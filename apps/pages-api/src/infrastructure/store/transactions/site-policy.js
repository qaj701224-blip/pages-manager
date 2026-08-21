import {
  SITE_COMMIT_LOCK_RENEW_MS,
  SITE_COMMIT_TIMEOUT_MS,
  accessModeFromVisibility,
  assertSitePolicyExpected,
  cacheTierForVisibility,
  mapSiteCommitLock,
  normalizeExposure,
  normalizeSitePolicyAclEntries,
  normalizeSitePolicyExpected,
  normalizeSitePolicyLease,
  randomStoreId,
  resolveNextAccessMode,
  resolveNextExposure,
  routeRestoredAsNewPolicyCommit,
  routeWithLatestRuntimeConfig,
  routesMatchIgnoringRuntimeConfigGeneration,
  siteAclEntryKey,
  siteCommitLockExpiry,
  sitePolicyAclEntriesEqual,
  sitePolicyError,
  visibilityFromAccessMode,
} from '../store-support.js';

export const sitePolicyMethods = {
  async getSiteCommitLock(environment, siteId) {
    const row = await this.db
      .prepare(
        `SELECT environment, site_id, lock_id, fencing_token, acquired_at, expires_at, updated_at
          FROM site_policy_locks
          WHERE environment = ? AND site_id = ?`
      )
      .bind(environment, siteId)
      .first();
    return row ? mapSiteCommitLock(row) : null;
  },

  async acquireSiteCommitLock(environment, siteId, options = {}) {
    const acquiredAt = this.now();
    const lockId = options.lockId || randomStoreId('policy_lock');
    const expiresAt = siteCommitLockExpiry(acquiredAt, options.leaseMs);
    const result = await this.db
      .prepare(
        `INSERT INTO site_policy_locks (
            environment, site_id, lock_id, fencing_token, acquired_at, expires_at, updated_at
          )
          SELECT ?, ?, ?, 1, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM site_routes WHERE environment = ? AND site_id = ?
          )
          ON CONFLICT(environment, site_id) DO UPDATE SET
            lock_id = excluded.lock_id,
            fencing_token = site_policy_locks.fencing_token + 1,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
          WHERE site_policy_locks.expires_at <= excluded.acquired_at`
      )
      .bind(environment, siteId, lockId, acquiredAt, expiresAt, acquiredAt, environment, siteId)
      .run();
    if (result?.meta?.changes !== 1) return null;
    const lock = await this.getSiteCommitLock(environment, siteId);
    return lock?.lockId === lockId ? lock : null;
  },

  async renewSiteCommitLock(environment, siteId, lockId, options = {}) {
    const renewedAt = this.now();
    const expiresAt = siteCommitLockExpiry(renewedAt, options.leaseMs);
    const fencingCondition = options.fencingToken == null ? '' : ' AND fencing_token = ?';
    const binds = [expiresAt, renewedAt, environment, siteId, lockId, renewedAt];
    if (options.fencingToken != null) binds.push(options.fencingToken);
    const result = await this.db
      .prepare(
        `UPDATE site_policy_locks
          SET expires_at = ?, updated_at = ?
          WHERE environment = ? AND site_id = ? AND lock_id = ? AND expires_at > ?${fencingCondition}`
      )
      .bind(...binds)
      .run();
    if (result?.meta?.changes !== 1) return null;
    const lock = await this.getSiteCommitLock(environment, siteId);
    return lock?.lockId === lockId ? lock : null;
  },

  async releaseSiteCommitLock(environment, siteId, lockId) {
    const releasedAt = this.now();
    const result = await this.db
      .prepare(
        `UPDATE site_policy_locks
          SET expires_at = ?, updated_at = ?
          WHERE environment = ? AND site_id = ? AND lock_id = ? AND expires_at > ?`
      )
      .bind(releasedAt, releasedAt, environment, siteId, lockId, releasedAt)
      .run();
    return result?.meta?.changes === 1;
  },

  async withSiteCommitLock(environment, siteId, callback, options = {}) {
    let lock = await this.acquireSiteCommitLock(environment, siteId, options);
    const waitForLockMs = Number(options.waitForLockMs || 0);
    if (!lock && waitForLockMs > 0) {
      const deadline = Date.now() + waitForLockMs;
      while (!lock && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        lock = await this.acquireSiteCommitLock(environment, siteId, options);
      }
    }
    if (!lock) throw sitePolicyError('SITE_POLICY_LOCKED');

    let result;
    let failure;
    let currentLock = lock;
    const abortController = new globalThis.AbortController();
    const timeout = globalThis.setTimeout(() => {
      abortController.abort(sitePolicyError('SITE_COMMIT_TIMEOUT'));
    }, options.timeoutMs || SITE_COMMIT_TIMEOUT_MS);
    let renewal = Promise.resolve();
    const renew = () => {
      renewal = renewal
        .then(async () => {
          const renewed = await this.renewSiteCommitLock(environment, siteId, currentLock.lockId, {
            fencingToken: currentLock.fencingToken,
            leaseMs: options.leaseMs,
          });
          if (!renewed) throw sitePolicyError('SITE_POLICY_LOCKED');
          currentLock = renewed;
        })
        .catch((error) => {
          abortController.abort(error);
          throw error;
        });
      renewal.catch(() => {});
    };
    const timer = globalThis.setInterval(renew, options.renewIntervalMs || SITE_COMMIT_LOCK_RENEW_MS);
    try {
      result = await callback({ ...currentLock, signal: abortController.signal });
    } catch (error) {
      failure = error;
    }
    globalThis.clearInterval(timer);
    globalThis.clearTimeout(timeout);
    try {
      await renewal;
    } catch (error) {
      if (!failure) failure = error;
    }
    try {
      const released = await this.releaseSiteCommitLock(environment, siteId, currentLock.lockId);
      if (!released && !failure && !options.bestEffortRelease) failure = sitePolicyError('SITE_POLICY_LOCKED');
    } catch (error) {
      if (!failure && !options.bestEffortRelease) failure = error;
    }
    if (failure) throw failure;
    return result;
  },

  async updateSiteAccessPolicy(input) {
    const commitNow = this.now();
    const now = input.updatedAt || commitNow;
    const site = await this.getSite(input.siteId);
    const route = await this.getRouteBySiteId(input.siteId, input.environment);
    if (!site || !route || site.environment !== input.environment) throw sitePolicyError('SITE_POLICY_NOT_FOUND');
    assertSitePolicyExpected(route, input.expected);
    await this.assertSitePolicyLease(input.environment, input.siteId, input.lease, commitNow);

    const nextExposure = resolveNextExposure(route.exposure, input);
    const nextAccessMode = resolveNextAccessMode(route.accessMode, input);
    const nextVisibility = visibilityFromAccessMode(nextAccessMode);
    if (!nextVisibility) throw sitePolicyError('SITE_POLICY_INVALID');

    const currentAclEntries = await this.listSiteAclEntries(input.siteId);
    const nextAclEntries = Object.hasOwn(input, 'aclEntries')
      ? normalizeSitePolicyAclEntries(input.aclEntries, input.siteId, input.actorUserId, now)
      : currentAclEntries;
    const aclChanged = !sitePolicyAclEntriesEqual(currentAclEntries, nextAclEntries);
    const policyChanged =
      nextExposure !== route.exposure || nextAccessMode !== route.accessMode || nextVisibility !== route.visibility;

    if (!policyChanged && !aclChanged) {
      return {
        changed: false,
        site,
        route,
        aclEntries: currentAclEntries,
      };
    }

    const expected = normalizeSitePolicyExpected(input.expected);
    const lease = normalizeSitePolicyLease(input.lease);
    const statements = [
      this.db
        .prepare(
          `UPDATE site_routes
            SET exposure = ?, access_mode = ?, visibility = ?, cache_tier = ?,
              policy_version = policy_version + 1, updated_at = ?
            WHERE environment = ? AND site_id = ?
              AND policy_version = ? AND route_generation = ?
              AND active_version_id IS ? AND runtime_config_generation = ?
              AND EXISTS (
                SELECT 1 FROM site_policy_locks
                WHERE environment = ? AND site_id = ? AND lock_id = ? AND fencing_token = ? AND expires_at > ?
              )`
        )
        .bind(
          nextExposure,
          nextAccessMode,
          nextVisibility,
          cacheTierForVisibility(nextVisibility),
          now,
          input.environment,
          input.siteId,
          expected.policyVersion,
          expected.routeGeneration,
          expected.activeVersionId,
          expected.runtimeConfigGeneration,
          input.environment,
          input.siteId,
          lease.lockId,
          lease.fencingToken,
          commitNow
        ),
      this.sitePolicyGuardStatement(),
      this.db
        .prepare(
          `UPDATE sites
            SET default_exposure = ?, default_access_mode = ?, default_visibility = ?, updated_at = ?
            WHERE id = ? AND environment = ? AND deleted_at IS NULL`
        )
        .bind(nextExposure, nextAccessMode, nextVisibility, now, input.siteId, input.environment),
    ];

    if (Object.hasOwn(input, 'aclEntries')) {
      statements.push(this.db.prepare('DELETE FROM site_acl_entries WHERE site_id = ?').bind(input.siteId));
      for (const entry of nextAclEntries) {
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
              input.siteId,
              entry.subjectType,
              entry.subjectValue,
              entry.accessRole,
              entry.effect,
              entry.createdBy,
              entry.createdAt
            )
        );
      }
    }
    if (input.auditEvent) statements.push(this.auditEventStatement(input.auditEvent));

    await this.db.batch(statements);
    return {
      changed: true,
      site: await this.getSite(input.siteId),
      route: await this.getRouteBySiteId(input.siteId, input.environment),
      aclEntries: await this.listSiteAclEntries(input.siteId),
    };
  },

  async assertSitePolicyLease(environment, siteId, leaseInput, now = this.now()) {
    const lease = normalizeSitePolicyLease(leaseInput);
    const current = await this.getSiteCommitLock(environment, siteId);
    if (!current || current.lockId !== lease.lockId || current.fencingToken !== lease.fencingToken || current.expiresAt <= now) {
      throw sitePolicyError('SITE_POLICY_CONFLICT');
    }
    return current;
  },

  async updateSiteVisibility(siteId, { visibility, updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return null;
    const now = updatedAt || this.now();
    const cacheTier = cacheTierForVisibility(visibility);
    const accessMode = accessModeFromVisibility(visibility);
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE sites SET default_visibility = ?, default_access_mode = ?, updated_at = ?
            WHERE id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [visibility, accessMode, now, siteId, environment] : [visibility, accessMode, now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
            SET visibility = ?, access_mode = ?, policy_version = policy_version + 1,
              cache_tier = ?, updated_at = ?
            WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(
          ...(environment
            ? [visibility, accessMode, cacheTier, now, siteId, environment]
            : [visibility, accessMode, cacheTier, now, siteId])
        ),
    ]);
    return this.getRouteBySiteId(siteId, environment);
  },

  async restoreSiteVisibility(siteId, previousSite, previousRoute, environment) {
    return this.restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, null, environment);
  },

  async restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, expectedRoute, environment) {
    if (!previousRoute) return null;
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (expectedRoute && !routesMatchIgnoringRuntimeConfigGeneration(currentRoute, expectedRoute)) {
      return currentRoute;
    }
    await this.db
      .prepare(
        `UPDATE sites SET default_visibility = ?, default_exposure = ?, default_access_mode = ?, updated_at = ?
            WHERE id = ?${environment ? ' AND environment = ?' : ''}`
      )
      .bind(
        ...(environment
          ? [
              previousSite.defaultVisibility,
              normalizeExposure(previousSite.defaultExposure),
              accessModeFromVisibility(previousSite.defaultVisibility),
              previousSite.updatedAt,
              siteId,
              environment,
            ]
          : [
              previousSite.defaultVisibility,
              normalizeExposure(previousSite.defaultExposure),
              accessModeFromVisibility(previousSite.defaultVisibility),
              previousSite.updatedAt,
              siteId,
            ])
      )
      .run();
    return this.restoreSiteRoute(siteId, routeRestoredAsNewPolicyCommit(previousRoute, currentRoute), environment);
  },

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
  },

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
  },

  async removeSiteAclEntries(siteId, entries, { updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return [];
    const existing = await this.listSiteAclEntries(siteId);
    const removedKeys = new Set(entries.map(siteAclEntryKey));
    if (existing.every((entry) => !removedKeys.has(siteAclEntryKey(entry)))) return existing;

    const now = updatedAt || this.now();
    const conditions = entries
      .map(() => '(subject_type = ? AND subject_value = ? AND access_role = ? AND effect = ?)')
      .join(' OR ');
    const deleteBinds = entries.flatMap((entry) => [entry.subjectType, entry.subjectValue, entry.accessRole, entry.effect]);
    await this.db.batch([
      this.db.prepare(`DELETE FROM site_acl_entries WHERE site_id = ? AND (${conditions})`).bind(siteId, ...deleteBinds),
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
  },

  async restoreSiteAclEntries(siteId, previousEntries, previousRoute, previousSite, environment) {
    return this.restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, null, environment);
  },

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
  },

  sitePolicyGuardStatement() {
    return this.db
      .prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`)
      .bind('SITE_POLICY_CONFLICT');
  },
};
