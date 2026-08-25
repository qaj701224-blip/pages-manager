import {
  departmentTeamDisplayName,
  mapConsoleDirectorySite,
  mapConsoleTeamSite,
  mapDeployment,
  mapHostnameClaim,
  mapSite,
  mapSiteAclEntry,
  mapSiteMember,
  mapSiteRoute,
  mapSiteWithJoinedRoute,
} from '../store-support.js';

export const sitesRepositoryMethods = {
  async findSiteBySlug(environment, slug) {
    const row = await this.db
      .prepare(
        `SELECT * FROM sites
          WHERE environment = ? AND slug = ? AND deleted_at IS NULL`
      )
      .bind(environment, slug)
      .first();
    return row ? mapSite(row) : null;
  },

  async listSiteRetiringHostnameClaims(siteId, { environment } = {}) {
    const environmentFilter = environment ? ' AND environment = ?' : '';
    const result = await this.db
      .prepare(
        `SELECT * FROM hostname_claims
          WHERE owner_system = 'v2' AND owner_id = ?${environmentFilter}
            AND status = 'held'
            AND release_reason = 'site_slug_renamed_pending_cleanup'
            AND reuse_hold_until IS NULL
          ORDER BY released_at ASC, id ASC`
      )
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .all();
    return (result.results || []).map(mapHostnameClaim);
  },

  async listSiteHostnameClaims(siteId, { environment } = {}) {
    const environmentFilter = environment ? ' AND environment = ?' : '';
    const result = await this.db
      .prepare(
        `SELECT * FROM hostname_claims
          WHERE owner_system = 'v2' AND owner_id = ?${environmentFilter}
          ORDER BY created_at ASC, id ASC`
      )
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .all();
    return (result.results || []).map(mapHostnameClaim);
  },

  async listSitesPendingSlugRouting(environment, { limit = 50 } = {}) {
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
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
          FROM sites
          JOIN site_routes ON site_routes.site_id = sites.id AND site_routes.environment = sites.environment
          WHERE sites.environment = ? AND sites.deleted_at IS NULL
            AND sites.slug_routing_synced_revision != sites.slug_revision
          ORDER BY sites.slug_routing_reconcile_attempted_at ASC, sites.updated_at ASC, sites.id ASC
          LIMIT ?`
      )
      .bind(environment, Math.max(1, Math.min(Number(limit) || 50, 200)))
      .all();
    return (result.results || []).map(mapSiteWithJoinedRoute);
  },

  async getSite(id) {
    const row = await this.db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
    return row ? mapSite(row) : null;
  },

  async getSiteWithRoute(siteId, environment) {
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
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
          FROM sites
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          WHERE sites.id = ? AND sites.deleted_at IS NULL
            ${environment ? 'AND sites.environment = ?' : ''}`
      )
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .first();
    return row ? mapSiteWithJoinedRoute(row) : null;
  },

  async listSitesForUser(userId, actor = {}, environment) {
    if (actor.type === 'access_key') {
      const ownerType = actor.ownerType || 'user';
      const binds = [];
      const legacySiteScopedActor = actor.siteId && !actor.ownerType && !actor.ownerId && !actor.userId;
      const ownerWhere = legacySiteScopedActor
        ? '1 = 1'
        : ownerType === 'team'
          ? `(sites.owner_type = 'team' AND sites.owner_id = ?)`
          : `(
                (COALESCE(sites.owner_type, 'user') = 'user' AND COALESCE(sites.owner_id, sites.owner_user_id) = ?)
                OR EXISTS (
                  SELECT 1 FROM team_members
                  WHERE team_members.team_id = sites.owner_id
                    AND team_members.user_id = ?
                    AND team_members.removed_at IS NULL
                )
              )`;
      if (legacySiteScopedActor) {
        // Site-scoped access key actors created by older tests/callers carry only siteId.
      } else if (ownerType === 'team') {
        binds.push(actor.ownerId);
      } else {
        const ownerUserId = actor.ownerId || actor.userId;
        binds.push(ownerUserId, ownerUserId);
      }
      if (environment) binds.push(environment);
      if (actor.siteId) binds.push(actor.siteId);

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
              site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
            FROM sites
            LEFT JOIN site_routes ON site_routes.site_id = sites.id
            WHERE ${ownerWhere}
              AND sites.deleted_at IS NULL
              ${environment ? 'AND sites.environment = ?' : ''}
              ${actor.siteId ? 'AND sites.id = ?' : ''}
            ORDER BY sites.created_at DESC`
        )
        .bind(...binds)
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
            site_routes.visibility AS route_visibility, site_routes.exposure AS route_exposure,
            site_routes.access_mode AS route_access_mode, site_routes.policy_version AS route_policy_version,
            site_routes.route_generation AS route_route_generation,
            site_routes.runtime_config_generation AS route_runtime_config_generation,
            site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
            team_members.role AS management_role
          FROM sites
          LEFT JOIN site_members ON site_members.site_id = sites.id
            AND site_members.user_id = ?
          LEFT JOIN team_members ON team_members.team_id = sites.owner_id
            AND team_members.user_id = ? AND team_members.removed_at IS NULL
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          WHERE sites.deleted_at IS NULL
            AND (
              (COALESCE(sites.owner_type, 'user') = 'user' AND site_members.user_id IS NOT NULL)
              OR (sites.owner_type = 'team' AND team_members.user_id IS NOT NULL)
            )
            ${environment ? 'AND sites.environment = ?' : ''}
          ORDER BY sites.created_at DESC`;
    const binds = [userId, userId];
    if (environment) binds.push(environment);
    const result = await this.db
      .prepare(query)
      .bind(...binds)
      .all();
    return (result.results || []).map(mapSiteWithJoinedRoute);
  },

  async getSiteForUser(siteId, userId, actor = {}, environment) {
    if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return null;
    const accessKeyActor = actor.type === 'access_key';
    if (accessKeyActor) {
      const site = await this.getSiteWithRoute(siteId, environment);
      if (!site || site.deletedAt) return null;
      if (!(await this.accessKeyCanSeeSite(actor, site))) return null;
      return this.decorateAccessKeySite(actor, site);
    }

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
            team_members.role AS management_role
          FROM sites
          LEFT JOIN site_members ON site_members.site_id = sites.id AND site_members.user_id = ?
          LEFT JOIN team_members ON team_members.team_id = sites.owner_id
            AND team_members.user_id = ? AND team_members.removed_at IS NULL
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          WHERE sites.id = ? AND sites.deleted_at IS NULL
            AND (
              (site_members.user_id IS NOT NULL AND COALESCE(sites.owner_type, 'user') = 'user')
              OR (sites.owner_type = 'team' AND team_members.user_id IS NOT NULL)
            )` + (environment ? ' AND sites.environment = ?' : '')
      )
      .bind(...(environment ? [userId, userId, siteId, environment] : [userId, userId, siteId]))
      .first();
    return row ? mapSiteWithJoinedRoute(row) : null;
  },

  async accessKeyCanSeeSite(actor, site) {
    if (actor.siteId && !actor.ownerType && !actor.ownerId && !actor.userId) return actor.siteId === site.id;
    const ownerType = actor.ownerType || 'user';
    if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === actor.ownerId;
    const ownerUserId = actor.ownerId || actor.userId;
    if ((site.ownerType || 'user') === 'user') return (site.ownerId || site.ownerUserId) === ownerUserId;
    if (site.ownerType === 'team') {
      const member = await this.getTeamMember({ teamId: site.ownerId, userId: ownerUserId });
      return Boolean(member);
    }
    return false;
  },

  async decorateAccessKeySite(actor, site) {
    if ((actor.ownerType || 'user') !== 'user' || site.ownerType !== 'team') return site;
    const member = await this.getTeamMember({ teamId: site.ownerId, userId: actor.ownerId || actor.userId });
    return {
      ...site,
      managementRole: member?.role || null,
    };
  },

  async listConsoleDirectorySites({ environment, viewerUserId } = {}) {
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
            owner_users.realname AS owner_user_realname, owner_users.email AS owner_user_email,
            teams.id AS owner_team_id, teams.name AS owner_team_name, teams.team_type AS owner_team_type,
            teams.department_path AS owner_team_department_path
          FROM sites
          JOIN site_routes ON site_routes.id = (
            SELECT route.id
            FROM site_routes AS route
            WHERE route.site_id = sites.id
              AND route.environment = sites.environment
            ORDER BY route.updated_at DESC, route.id DESC
            LIMIT 1
          )
          LEFT JOIN users AS owner_users
            ON COALESCE(sites.owner_type, 'user') = 'user'
            AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
          LEFT JOIN teams
            ON sites.owner_type = 'team'
            AND teams.id = sites.owner_id
            AND teams.deleted_at IS NULL
          WHERE sites.deleted_at IS NULL
            ${environment ? 'AND sites.environment = ?' : ''}
            AND COALESCE(site_routes.visibility, sites.default_visibility) = 'internal'
          ORDER BY sites.slug ASC`
      )
      .bind(...(environment ? [environment] : []))
      .all();
    const sitesById = new Map(
      (result.results || []).map((row) => {
        const site = mapConsoleDirectorySite(row);
        return [site.id, site];
      })
    );
    if (viewerUserId) {
      const accessibleResult = await this.db
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
              owner_users.realname AS owner_user_realname, owner_users.email AS owner_user_email,
              teams.id AS owner_team_id, teams.name AS owner_team_name, teams.team_type AS owner_team_type,
              teams.department_path AS owner_team_department_path
            FROM sites
            JOIN users AS viewer_users
              ON viewer_users.user_id = ?
              AND viewer_users.employee_status = 'active'
            JOIN site_routes ON site_routes.id = (
              SELECT route.id
              FROM site_routes AS route
              WHERE route.site_id = sites.id
                AND route.environment = sites.environment
              ORDER BY route.updated_at DESC, route.id DESC
              LIMIT 1
            )
            LEFT JOIN users AS owner_users
              ON COALESCE(sites.owner_type, 'user') = 'user'
              AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
            LEFT JOIN teams
              ON sites.owner_type = 'team'
              AND teams.id = sites.owner_id
              AND teams.deleted_at IS NULL
            WHERE sites.deleted_at IS NULL
              ${environment ? 'AND sites.environment = ?' : ''}
              AND (
                COALESCE(site_routes.visibility, sites.default_visibility) = 'org'
                OR (
                  COALESCE(site_routes.visibility, sites.default_visibility) = 'acl'
                  AND EXISTS (
                    SELECT 1 FROM site_acl_entries
                    WHERE site_acl_entries.site_id = sites.id
                      AND site_acl_entries.effect = 'allow'
                      AND (
                        (
                          site_acl_entries.subject_type = 'email'
                          AND trim(site_acl_entries.subject_value) <> ''
                          AND trim(COALESCE(viewer_users.email, '')) <> ''
                          AND lower(trim(site_acl_entries.subject_value)) = lower(trim(COALESCE(viewer_users.email, '')))
                        )
                        OR (
                          site_acl_entries.subject_type = 'department'
                          AND viewer_users.department_path IS NOT NULL
                          AND (
                            viewer_users.department_path = site_acl_entries.subject_value
                            OR substr(viewer_users.department_path, 1, length(site_acl_entries.subject_value) + 1) =
                              site_acl_entries.subject_value || '/'
                          )
                        )
                      )
                  )
                )
              )
            ORDER BY sites.slug ASC`
        )
        .bind(...(environment ? [viewerUserId, environment] : [viewerUserId]))
        .all();
      for (const row of accessibleResult.results || []) {
        const site = mapConsoleDirectorySite(row);
        sitesById.set(site.id, site);
      }
      for (const site of await this.listSitesForUser(viewerUserId, { type: 'user', userId: viewerUserId }, environment)) {
        if ((site.ownerType || 'user') !== 'user') continue;
        sitesById.set(site.id, await this.decorateConsoleSiteOwner(site));
      }
      for (const site of await this.listTeamOwnedSitesForUser({ environment, userId: viewerUserId })) {
        sitesById.set(site.id, site);
      }
    }
    return [...sitesById.values()].sort((left, right) => left.slug.localeCompare(right.slug));
  },

  async listWorkspaceSites({ environment, userId, ownerFilter, teamId } = {}) {
    if (ownerFilter === 'team') return this.listTeamOwnedSitesForUser({ environment, userId, teamId });
    const sites = await this.listSitesForUser(userId, { type: 'user', userId }, environment);
    const personalSites = sites.filter((site) => {
      return (site.ownerType || 'user') === 'user' && (site.ownerId || site.ownerUserId) === userId;
    });
    return Promise.all(personalSites.map((site) => this.decorateConsoleSiteOwner(site)));
  },

  async decorateConsoleSiteOwner(site) {
    if (!site) return site;
    if ((site.ownerType || 'user') === 'team') {
      const team = await this.getTeam(site.ownerId);
      return {
        ...site,
        ownerDisplayName: team ? departmentTeamDisplayName(team) : null,
        ownerTeamType: team?.teamType || null,
        ownerTeamId: team?.id || null,
      };
    }
    const user = await this.getUser(site.ownerId || site.ownerUserId);
    return {
      ...site,
      ownerDisplayName: user?.realname || user?.email || null,
    };
  },

  async listTeamOwnedSitesForUser({ environment, userId, teamId } = {}) {
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
            teams.id AS owner_team_id, teams.name AS owner_team_name, teams.team_type AS owner_team_type,
            teams.department_path AS owner_team_department_path,
            team_members.role AS management_role
          FROM sites
          JOIN teams ON teams.id = sites.owner_id AND sites.owner_type = 'team'
          JOIN team_members ON team_members.team_id = teams.id AND team_members.user_id = ? AND team_members.removed_at IS NULL
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          WHERE sites.deleted_at IS NULL
            AND teams.status = 'active' AND teams.deleted_at IS NULL
            ${environment ? 'AND sites.environment = ? AND teams.environment = ?' : ''}
            ${teamId ? 'AND teams.id = ?' : ''}
          ORDER BY sites.created_at DESC`
      )
      .bind(...[userId, ...(environment ? [environment, environment] : []), ...(teamId ? [teamId] : [])])
      .all();
    return (result.results || []).map(mapConsoleTeamSite);
  },

  async getConsoleSiteDetail({ environment, userId, siteId } = {}) {
    const site = await this.getSiteWithRoute(siteId, environment);
    if (!site) return null;
    if ((site.ownerType || 'user') === 'team') {
      const team = await this.getTeam(site.ownerId);
      if (!team || (environment && team.environment !== environment)) return null;
      const member = await this.getTeamMember({ teamId: team.id, userId });
      if (!member) return null;
      return {
        ...site,
        ownerType: 'team',
        ownerDisplayName: departmentTeamDisplayName(team),
        ownerTeamType: team.teamType,
        ownerTeamId: team.id,
        currentUserId: userId,
        managementRole: member.role,
      };
    }
    if ((site.ownerId || site.ownerUserId) !== userId) return null;
    const ownerUser = await this.getUser(site.ownerId || site.ownerUserId);
    return {
      ...site,
      ownerType: 'user',
      ownerDisplayName: ownerUser?.realname || ownerUser?.email || null,
      currentUserId: userId,
      managementRole: 'admin',
    };
  },

  async listConsoleSiteDeployments({ environment, userId, siteId } = {}) {
    const site = await this.getConsoleSiteDetail({ environment, userId, siteId });
    if (!site) return [];

    const result = await this.db
      .prepare(
        `SELECT deployments.*
          FROM deployments
          WHERE deployments.site_id = ?
            ${environment ? 'AND deployments.environment = ?' : ''}
          ORDER BY deployments.created_at DESC
          LIMIT 100`
      )
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .all();
    return (result.results || []).map(mapDeployment);
  },

  async listSiteMembers(siteId) {
    const result = await this.db.prepare('SELECT * FROM site_members WHERE site_id = ?').bind(siteId).all();
    return (result.results || []).map(mapSiteMember);
  },

  async listSiteAclEntries(siteId) {
    const result = await this.db
      .prepare('SELECT * FROM site_acl_entries WHERE site_id = ? ORDER BY created_at ASC, id ASC')
      .bind(siteId)
      .all();
    return (result.results || []).map(mapSiteAclEntry);
  },

  async getRouteBySiteId(siteId, environment) {
    const row = await this.db
      .prepare('SELECT * FROM site_routes WHERE site_id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .first();
    return row ? mapSiteRoute(row) : null;
  },
};
