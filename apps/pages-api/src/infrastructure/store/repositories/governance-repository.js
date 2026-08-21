import {
  ADMIN_EXPOSURE_EVENT_TYPE,
  mapAdminDeploymentWithOwner,
  mapAdminSiteWithOwner,
  mapAuditEvent,
  mapTeam,
  mapUser,
  normalizeNullableString,
  parseJsonColumn,
  resolveLatestAdminSitePublicExposureReason,
} from '../store-support.js';

export const governanceRepositoryMethods = {
  async getAdminDashboard({ environment }) {
    const [
      siteRow,
      userRow,
      teamRow,
      deploymentRow,
      failedDeploymentCountRow,
      pendingCleanupRow,
      failedCleanupRow,
      oldestPendingCleanupRow,
      failedDeploymentsResult,
    ] = await Promise.all([
      this.db
        .prepare('SELECT COUNT(*) AS count FROM sites WHERE environment = ? AND deleted_at IS NULL')
        .bind(environment)
        .first(),
      this.db.prepare('SELECT COUNT(*) AS count FROM users').first(),
      this.db
        .prepare("SELECT COUNT(*) AS count FROM teams WHERE environment = ? AND status = 'active' AND deleted_at IS NULL")
        .bind(environment)
        .first(),
      this.db.prepare('SELECT COUNT(*) AS count FROM deployments WHERE environment = ?').bind(environment).first(),
      this.db
        .prepare("SELECT COUNT(*) AS count FROM deployments WHERE environment = ? AND status = 'failed'")
        .bind(environment)
        .first(),
      this.db
        .prepare("SELECT COUNT(*) AS count FROM deployment_resource_cleanup_tasks WHERE environment = ? AND status = 'pending'")
        .bind(environment)
        .first(),
      this.db
        .prepare("SELECT COUNT(*) AS count FROM deployment_resource_cleanup_tasks WHERE environment = ? AND status = 'failed'")
        .bind(environment)
        .first(),
      this.db
        .prepare(
          `SELECT MIN(cleanup_after) AS oldest_pending_at
            FROM deployment_resource_cleanup_tasks
            WHERE environment = ? AND status = 'pending'`
        )
        .bind(environment)
        .first(),
      this.db
        .prepare(
          `SELECT deployments.*,
              sites.id AS joined_site_id,
              sites.slug AS site_slug,
              sites.owner_type AS site_owner_type,
              sites.owner_id AS site_owner_id,
              sites.owner_user_id AS site_owner_user_id,
              owner_users.email AS owner_user_email,
              owner_users.realname AS owner_user_realname,
              actor_users.email AS actor_user_email,
              actor_users.realname AS actor_user_realname,
              owner_teams.name AS owner_team_name,
              owner_teams.team_type AS owner_team_type,
              owner_teams.department_path AS owner_team_department_path
            FROM deployments
            LEFT JOIN sites
              ON sites.id = deployments.site_id
              AND sites.environment = deployments.environment
            LEFT JOIN users AS owner_users
              ON COALESCE(sites.owner_type, 'user') = 'user'
              AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
            LEFT JOIN users AS actor_users
              ON actor_users.user_id = deployments.actor_user_id
            LEFT JOIN teams AS owner_teams
              ON sites.owner_type = 'team'
              AND owner_teams.id = sites.owner_id
              AND owner_teams.environment = deployments.environment
              AND owner_teams.deleted_at IS NULL
            WHERE deployments.environment = ? AND deployments.status = 'failed'
            ORDER BY deployments.created_at DESC
            LIMIT 10`
        )
        .bind(environment)
        .all(),
    ]);

    return {
      environment,
      counts: {
        sites: Number(siteRow?.count || 0),
        users: Number(userRow?.count || 0),
        teams: Number(teamRow?.count || 0),
        deployments: Number(deploymentRow?.count || 0),
        failedDeployments: Number(failedDeploymentCountRow?.count || 0),
      },
      resourceCleanup: {
        pendingTasks: Number(pendingCleanupRow?.count || 0),
        failedTasks: Number(failedCleanupRow?.count || 0),
        oldestPendingAt: oldestPendingCleanupRow?.oldest_pending_at || null,
      },
      failedDeployments: (failedDeploymentsResult.results || []).map(mapAdminDeploymentWithOwner),
    };
  },

  async listWorkerOrphanScanReferences({ environment, limit } = {}) {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : null;
    const queryLimit = normalizedLimit ? normalizedLimit + 1 : null;
    const [activeRoutesResult, versionsResult, cleanupTasksResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT worker_name, site_id, active_version_id, execution_provider, dispatch_type
            FROM site_routes
            WHERE environment = ? AND route_status = 'active' AND worker_name IS NOT NULL${queryLimit ? ' LIMIT ?' : ''}`
        )
        .bind(...(queryLimit ? [environment, queryLimit] : [environment]))
        .all(),
      this.db
        .prepare(
          `SELECT site_versions.id, site_versions.worker_name, site_versions.site_id,
              site_versions.artifact_availability, site_versions.execution_provider,
              site_versions.dispatch_type, site_versions.created_at, sites.slug AS site_slug,
              sites.deleted_at AS site_deleted_at
            FROM site_versions
            LEFT JOIN sites ON sites.id = site_versions.site_id
            WHERE sites.environment = ? AND site_versions.worker_name IS NOT NULL${queryLimit ? ' LIMIT ?' : ''}`
        )
        .bind(...(queryLimit ? [environment, queryLimit] : [environment]))
        .all(),
      this.db
        .prepare(
          `SELECT id, resource_ref, status
            FROM deployment_resource_cleanup_tasks
            WHERE environment = ? AND resource_type = 'wfp_user_worker'
              AND status IN ('pending', 'failed', 'running')${queryLimit ? ' LIMIT ?' : ''}`
        )
        .bind(...(queryLimit ? [environment, queryLimit] : [environment]))
        .all(),
    ]);
    const activeRoutes = (activeRoutesResult.results || []).map((row) => ({
      workerName: row.worker_name,
      siteId: row.site_id,
      versionId: row.active_version_id || null,
      executionProvider: row.execution_provider || null,
      dispatchType: row.dispatch_type || null,
    }));
    const versions = (versionsResult.results || []).map((row) => ({
      id: row.id,
      workerName: row.worker_name,
      siteId: row.site_id,
      siteSlug: row.site_slug || null,
      siteDeletedAt: row.site_deleted_at || null,
      artifactAvailability: row.artifact_availability || 'active',
      executionProvider: row.execution_provider || null,
      dispatchType: row.dispatch_type || null,
      createdAt: row.created_at || null,
    }));
    const cleanupTasks = (cleanupTasksResult.results || []).map((row) => ({
      id: row.id,
      resourceRef: row.resource_ref,
      status: row.status,
    }));
    if (!normalizedLimit) return { activeRoutes, versions, cleanupTasks };
    return {
      activeRoutes: activeRoutes.slice(0, normalizedLimit),
      versions: versions.slice(0, normalizedLimit),
      cleanupTasks: cleanupTasks.slice(0, normalizedLimit),
      scanLimitExceeded:
        activeRoutes.length > normalizedLimit || versions.length > normalizedLimit || cleanupTasks.length > normalizedLimit,
    };
  },

  async listSiteWfpCleanupReferences({ siteId, environment }) {
    const [activeRoutesResult, versionsResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT worker_name, site_id, active_version_id, execution_provider, dispatch_type
            FROM site_routes
            WHERE site_id = ? AND environment = ? AND route_status = 'active' AND worker_name IS NOT NULL`
        )
        .bind(siteId, environment)
        .all(),
      this.db
        .prepare(
          `SELECT site_versions.id, site_versions.worker_name, site_versions.site_id,
              site_versions.execution_provider, site_versions.dispatch_type,
              site_versions.artifact_availability
            FROM site_versions
            JOIN sites ON sites.id = site_versions.site_id
            WHERE site_versions.site_id = ? AND sites.environment = ?
              AND site_versions.artifact_availability = 'active'
              AND site_versions.worker_name IS NOT NULL`
        )
        .bind(siteId, environment)
        .all(),
    ]);
    return {
      activeRoutes: (activeRoutesResult.results || []).map((row) => ({
        workerName: row.worker_name,
        siteId: row.site_id,
        versionId: row.active_version_id || null,
        executionProvider: row.execution_provider || null,
        dispatchType: row.dispatch_type || null,
      })),
      versions: (versionsResult.results || []).map((row) => ({
        id: row.id,
        workerName: row.worker_name,
        siteId: row.site_id,
        artifactAvailability: row.artifact_availability || 'active',
        executionProvider: row.execution_provider || null,
        dispatchType: row.dispatch_type || null,
      })),
    };
  },

  async listWorkerCleanupOwnershipReferences({ workerName }) {
    const [routesResult, versionsResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT worker_name, site_id, environment, active_version_id, execution_provider, dispatch_type
            FROM site_routes
            WHERE worker_name = ?`
        )
        .bind(workerName)
        .all(),
      this.db
        .prepare(
          `SELECT site_versions.id, site_versions.worker_name, site_versions.site_id,
              site_versions.execution_provider, site_versions.dispatch_type,
              sites.environment AS ownership_environment
            FROM site_versions
            LEFT JOIN sites ON sites.id = site_versions.site_id
            WHERE site_versions.worker_name = ?`
        )
        .bind(workerName)
        .all(),
    ]);
    return {
      routes: (routesResult.results || []).map((row) => ({
        workerName: row.worker_name,
        siteId: row.site_id,
        versionId: row.active_version_id || null,
        ownershipEnvironment: row.environment || null,
        executionProvider: row.execution_provider || null,
        dispatchType: row.dispatch_type || null,
      })),
      versions: (versionsResult.results || []).map((row) => ({
        id: row.id,
        workerName: row.worker_name,
        siteId: row.site_id,
        ownershipEnvironment: row.ownership_environment || null,
        executionProvider: row.execution_provider || null,
        dispatchType: row.dispatch_type || null,
      })),
    };
  },

  async listActiveSiteSlugs({ environment }) {
    const result = await this.db
      .prepare('SELECT id, slug FROM sites WHERE environment = ? AND deleted_at IS NULL ORDER BY slug ASC')
      .bind(environment)
      .all();
    return (result.results || []).map((row) => ({ id: row.id, slug: row.slug }));
  },

  async listAdminUsers({ environment, query, limit = 50, offset = 0, admin, status }) {
    const normalizedQuery = normalizeNullableString(query);
    const parsedLimit = Number(limit);
    const normalizedLimit = Number.isInteger(parsedLimit) && parsedLimit >= 1 ? Math.min(parsedLimit, 100) : 50;
    const parsedOffset = Number(offset);
    const normalizedOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const normalizedAdmin = admin === 'admin' || admin === 'user' ? admin : null;
    const normalizedStatus = status === 'active' || status === 'inactive' ? status : null;
    const conditions = [];
    const queryCondition = normalizedQuery
      ? `(LOWER(COALESCE(users.realname, '')) LIKE ?
            OR LOWER(COALESCE(users.email, '')) LIKE ?
            OR LOWER(COALESCE(users.account, '')) LIKE ?
            OR LOWER(users.user_id) LIKE ?
            OR LOWER(COALESCE(users.department_path, '')) LIKE ?)`
      : '';
    if (queryCondition) conditions.push(queryCondition);
    if (normalizedAdmin === 'admin') conditions.push('platform_admins.user_id IS NOT NULL');
    if (normalizedAdmin === 'user') conditions.push('platform_admins.user_id IS NULL');
    if (normalizedStatus === 'active') conditions.push("users.employee_status = 'active'");
    if (normalizedStatus === 'inactive') conditions.push("COALESCE(users.employee_status, 'unknown') != 'active'");
    const whereClause = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
    const queryBinds = [environment];
    if (normalizedQuery) {
      const like = `%${normalizedQuery.toLowerCase()}%`;
      queryBinds.push(like, like, like, like, like);
    }
    const join = `
          LEFT JOIN platform_admins
            ON platform_admins.user_id = users.user_id
            AND platform_admins.environment = ?
            AND platform_admins.revoked_at IS NULL`;
    const countResultPromise = this.db
      .prepare(`SELECT COUNT(*) AS count FROM users${join} WHERE 1 = 1 ${whereClause}`)
      .bind(...queryBinds)
      .first();
    const rowsResultPromise = this.db
      .prepare(
        `SELECT users.*, platform_admins.user_id AS platform_admin_user_id
          FROM users
          ${join}
          WHERE 1 = 1 ${whereClause}
          ORDER BY users.email ASC
          LIMIT ? OFFSET ?`
      )
      .bind(...queryBinds, normalizedLimit, normalizedOffset)
      .all();
    const [countResult, rowsResult] = await Promise.all([countResultPromise, rowsResultPromise]);
    return {
      users: (rowsResult.results || []).map((row) => ({
        ...mapUser(row),
        isPlatformAdmin: Boolean(row.platform_admin_user_id),
      })),
      total: Number(countResult?.count || 0),
      limit: normalizedLimit,
      offset: normalizedOffset,
    };
  },

  async listConsoleUsers({ query, limit = 20 } = {}) {
    const normalizedQuery = normalizeNullableString(query);
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const conditions = ["COALESCE(employee_status, 'unknown') IN ('active', 'unknown')"];
    const binds = [];
    if (normalizedQuery) {
      const like = `%${normalizedQuery.toLowerCase()}%`;
      conditions.push(
        `(LOWER(COALESCE(realname, '')) LIKE ?
            OR LOWER(COALESCE(email, '')) LIKE ?
            OR LOWER(COALESCE(account, '')) LIKE ?
            OR LOWER(user_id) LIKE ?)`
      );
      binds.push(like, like, like, like);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM users
          WHERE ${conditions.join(' AND ')}
          ORDER BY COALESCE(realname, email, user_id) ASC
          LIMIT ?`
      )
      .bind(...binds, normalizedLimit)
      .all();
    return (result.results || []).map(mapUser);
  },

  async listAdminSites({ environment, limit = 200, exposure } = {}) {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    const exposureFilter = exposure === 'public' || exposure === 'internal' ? exposure : null;
    const result = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
            site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
            site_routes.execution_provider AS route_execution_provider,
            site_routes.dispatch_type AS route_dispatch_type,
            site_routes.dispatch_binding_name AS route_dispatch_binding_name,
            site_routes.slot_id AS route_slot_id,
            site_routes.active_version_id AS route_active_version_id,
            site_routes.visibility AS route_visibility, site_routes.exposure AS route_exposure,
            site_routes.access_mode AS route_access_mode, site_routes.policy_version AS route_policy_version,
            site_routes.route_generation AS route_route_generation,
            site_routes.runtime_config_generation AS route_runtime_config_generation,
            site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
            site_versions.deployment_shape AS active_version_deployment_shape,
            owner_users.email AS owner_user_email, owner_users.realname AS owner_user_realname,
            owner_teams.name AS owner_team_name, owner_teams.team_type AS owner_team_type,
            owner_teams.department_path AS owner_team_department_path
          FROM sites
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          LEFT JOIN site_versions
            ON site_versions.id = site_routes.active_version_id
            AND site_versions.site_id = sites.id
          LEFT JOIN users AS owner_users
            ON COALESCE(sites.owner_type, 'user') = 'user'
            AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
          LEFT JOIN teams AS owner_teams
            ON sites.owner_type = 'team'
            AND owner_teams.id = sites.owner_id
            AND owner_teams.deleted_at IS NULL
          WHERE sites.environment = ? AND sites.deleted_at IS NULL
            ${exposureFilter ? "AND COALESCE(site_routes.exposure, 'internal') = ?" : ''}
          ORDER BY sites.updated_at DESC
          LIMIT ?`
      )
      .bind(...(exposureFilter ? [environment, exposureFilter, normalizedLimit] : [environment, normalizedLimit]))
      .all();
    return (result.results || []).map(mapAdminSiteWithOwner);
  },

  async getAdminSiteById(siteId, environment) {
    const row = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
            site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
            site_routes.execution_provider AS route_execution_provider,
            site_routes.dispatch_type AS route_dispatch_type,
            site_routes.dispatch_binding_name AS route_dispatch_binding_name,
            site_routes.slot_id AS route_slot_id,
            site_routes.active_version_id AS route_active_version_id,
            site_routes.visibility AS route_visibility, site_routes.exposure AS route_exposure,
            site_routes.access_mode AS route_access_mode, site_routes.policy_version AS route_policy_version,
            site_routes.route_generation AS route_route_generation,
            site_routes.runtime_config_generation AS route_runtime_config_generation,
            site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
            site_versions.deployment_shape AS active_version_deployment_shape,
            owner_users.email AS owner_user_email, owner_users.realname AS owner_user_realname,
            owner_teams.name AS owner_team_name, owner_teams.team_type AS owner_team_type,
            owner_teams.department_path AS owner_team_department_path
          FROM sites
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          LEFT JOIN site_versions
            ON site_versions.id = site_routes.active_version_id
            AND site_versions.site_id = sites.id
          LEFT JOIN users AS owner_users
            ON COALESCE(sites.owner_type, 'user') = 'user'
            AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
          LEFT JOIN teams AS owner_teams
            ON sites.owner_type = 'team'
            AND owner_teams.id = sites.owner_id
            AND owner_teams.deleted_at IS NULL
          WHERE sites.id = ? AND sites.environment = ? AND sites.deleted_at IS NULL`
      )
      .bind(siteId, environment)
      .first();
    return row ? mapAdminSiteWithOwner(row) : null;
  },

  async listAdminSiteDeployments({ environment, siteId, limit = 100 }) {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const result = await this.db
      .prepare(
        `SELECT deployments.*,
            sites.id AS joined_site_id,
            sites.slug AS site_slug,
            sites.owner_type AS site_owner_type,
            sites.owner_id AS site_owner_id,
            sites.owner_user_id AS site_owner_user_id,
            owner_users.email AS owner_user_email,
            owner_users.realname AS owner_user_realname,
            actor_users.email AS actor_user_email,
            actor_users.realname AS actor_user_realname,
            owner_teams.name AS owner_team_name,
            owner_teams.team_type AS owner_team_type,
            owner_teams.department_path AS owner_team_department_path
          FROM deployments
          LEFT JOIN sites
            ON sites.id = deployments.site_id
            AND sites.environment = deployments.environment
          LEFT JOIN users AS owner_users
            ON COALESCE(sites.owner_type, 'user') = 'user'
            AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
          LEFT JOIN users AS actor_users
            ON actor_users.user_id = deployments.actor_user_id
          LEFT JOIN teams AS owner_teams
            ON sites.owner_type = 'team'
            AND owner_teams.id = sites.owner_id
            AND owner_teams.environment = deployments.environment
            AND owner_teams.deleted_at IS NULL
          WHERE deployments.environment = ? AND deployments.site_id = ?
          ORDER BY deployments.created_at DESC
          LIMIT ?`
      )
      .bind(environment, siteId, normalizedLimit)
      .all();
    return (result.results || []).map(mapAdminDeploymentWithOwner);
  },

  async listAdminTeams({ environment, teamType, status, limit = 200 } = {}) {
    const conditions = ['environment = ?', 'deleted_at IS NULL'];
    const binds = [environment];
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    if (teamType) {
      conditions.push('team_type = ?');
      binds.push(teamType);
    }
    if (status) {
      conditions.push('status = ?');
      binds.push(status);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM teams
          WHERE ${conditions.join(' AND ')}
          ORDER BY name ASC
          LIMIT ?`
      )
      .bind(...binds, normalizedLimit)
      .all();
    return (result.results || []).map(mapTeam);
  },

  async listAuditEvents({ environment } = {}) {
    const result = environment
      ? await this.db
          .prepare(
            `SELECT audit_events.*, actor_users.email AS actor_email, actor_users.realname AS actor_realname
              FROM audit_events
              LEFT JOIN users actor_users ON actor_users.user_id = audit_events.actor_user_id
              WHERE audit_events.environment = ?
              ORDER BY audit_events.created_at DESC
              LIMIT 100`
          )
          .bind(environment)
          .all()
      : await this.db
          .prepare(
            `SELECT audit_events.*, actor_users.email AS actor_email, actor_users.realname AS actor_realname
              FROM audit_events
              LEFT JOIN users actor_users ON actor_users.user_id = audit_events.actor_user_id
              ORDER BY audit_events.created_at DESC
              LIMIT 100`
          )
          .all();
    return (result.results || []).map(mapAuditEvent);
  },

  async getLatestAdminSitePublicExposureReason({ environment, siteId, currentExposure } = {}) {
    if (currentExposure !== 'public') return null;
    const result = await this.db
      .prepare(
        `SELECT id, event_type, metadata_json, created_at
          FROM audit_events
          WHERE environment = ? AND site_id = ? AND event_type = ?
          ORDER BY created_at DESC, id DESC`
      )
      .bind(environment, siteId, ADMIN_EXPOSURE_EVENT_TYPE)
      .all();
    return resolveLatestAdminSitePublicExposureReason(
      (result.results || []).map((row) => ({
        id: row.id,
        eventType: row.event_type,
        metadata: parseJsonColumn(row.metadata_json),
        createdAt: row.created_at,
      })),
      { currentExposure }
    );
  },
};
