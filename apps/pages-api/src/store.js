export function createPagesStore(env = {}) {
  if (env.PAGES_STORE) return env.PAGES_STORE;
  if (!env.PAGES_METADATA) throw new Error('PAGES_METADATA binding is required');
  return new D1PagesStore(env.PAGES_METADATA);
}

export class D1PagesStore {
  constructor(db, { now = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.now = now;
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

    await this.db.batch([
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
            route_status, cache_tier, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

    return cloneRecord(site);
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
    const query = `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
        FROM sites
        JOIN site_members ON site_members.site_id = sites.id
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE site_members.user_id = ? AND sites.deleted_at IS NULL
          ${environment ? 'AND sites.environment = ?' : ''}
          ${siteScope ? 'AND sites.id = ?' : ''}
        ORDER BY sites.created_at DESC`;
    const binds = [userId];
    if (environment) binds.push(environment);
    if (siteScope) binds.push(siteScope);
    const result = await this.db
      .prepare(query)
      .bind(...binds)
      .all();
    return (result.results || []).map(mapSiteWithJoinedRoute);
  }

  async getSiteForUser(siteId, userId, actor = {}, environment) {
    if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return null;

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
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
        FROM sites
        JOIN site_members ON site_members.site_id = sites.id
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE sites.id = ? AND site_members.user_id = ? AND sites.deleted_at IS NULL` +
          (environment ? ' AND sites.environment = ?' : '')
      )
      .bind(...(environment ? [siteId, userId, environment] : [siteId, userId]))
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
    if (expectedRoute && !routesMatch(await this.getRouteBySiteId(siteId, environment), expectedRoute)) {
      return this.getRouteBySiteId(siteId, environment);
    }
    await this.db
      .prepare(`UPDATE sites SET default_visibility = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
      .bind(
        ...(environment
          ? [previousSite.defaultVisibility, previousSite.updatedAt, siteId, environment]
          : [previousSite.defaultVisibility, previousSite.updatedAt, siteId])
      )
      .run();
    return this.restoreSiteRoute(siteId, previousRoute, environment);
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
    if (expectedRoute && !routesMatch(await this.getRouteBySiteId(siteId, environment), expectedRoute)) {
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
    await this.restoreSiteRoute(siteId, previousRoute, environment);
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
      artifactKind: input.artifactKind,
      artifactRef: input.artifactRef,
      contentHash: input.contentHash,
      createdBy: input.createdBy,
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO site_versions (
          id, site_id, deployment_id, worker_name, runtime, execution_provider,
          dispatch_type, dispatch_binding_name, slot_id, artifact_kind,
          artifact_ref, content_hash, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.artifactKind,
        record.artifactRef,
        record.contentHash,
        record.createdBy,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
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
      ? ' AND route_generation = ? AND policy_version = ? AND active_version_id IS ?'
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
                ? [expectedRoute.routeGeneration, expectedRoute.policyVersion, expectedRoute.activeVersionId]
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
                ? [expectedRoute.routeGeneration, expectedRoute.policyVersion, expectedRoute.activeVersionId]
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
          route_status = ?, cache_tier = ?, updated_at = ?
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
    if (!routesMatch(await this.getRouteBySiteId(siteId, environment), expectedRoute)) {
      return this.getRouteBySiteId(siteId, environment);
    }
    return this.restoreSiteRoute(siteId, previousRoute, environment);
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

export function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
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
    actual.routeStatus === expected.routeStatus
  );
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
    routeStatus: row.route_status,
    cacheTier: row.cache_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    artifactKind: row.artifact_kind,
    artifactRef: row.artifact_ref,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
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
