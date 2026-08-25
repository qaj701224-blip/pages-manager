export const SITE_MUTATION_AUTHORIZATION_FAILED = 'SITE_MUTATION_AUTHORIZATION_FAILED';
export const SITE_MUTATION_STATE_CHANGED = 'SITE_MUTATION_STATE_CHANGED';
export const SITE_TRANSFER_INVARIANT_FAILED = 'SITE_TRANSFER_INVARIANT_FAILED';

export function siteMutationAuthorizationStatements(store, { siteId, environment, authorization, now, target = null }) {
  if (!authorization) return [];
  const source = sourceAuthorizationClause(authorization, { environment, siteId, now });
  const targetRole = targetTeamRoleClause(authorization, target);
  const clauses = ['id = ?', 'environment = ?', 'deleted_at IS NULL', source.sql];
  const binds = [siteId, environment, ...source.binds];
  if (targetRole) {
    clauses.push(targetRole.sql);
    binds.push(...targetRole.binds);
  }
  return guardedMatchStatements(store, clauses, binds, SITE_MUTATION_AUTHORIZATION_FAILED);
}

export function siteMutationExpectedStateStatements(store, { siteId, environment, expected }) {
  const clauses = [
    'id = ?',
    'environment = ?',
    'deleted_at IS NULL',
    "COALESCE(owner_type, 'user') = ?",
    'COALESCE(owner_id, owner_user_id) = ?',
    'slug_revision = ?',
  ];
  const binds = [
    siteId,
    environment,
    expected.ownerType || 'user',
    expected.ownerId || expected.ownerUserId,
    expected.slugRevision,
  ];
  return guardedMatchStatements(store, clauses, binds, SITE_MUTATION_STATE_CHANGED);
}

export function siteTransferInvariantStatements(store, { siteId, environment, target, expectedRoute, targetVisibility }) {
  const clauses = ['id = ?', 'environment = ?', 'deleted_at IS NULL'];
  const binds = [siteId, environment];
  if (target.ownerType === 'user') {
    clauses.push(`EXISTS (
      SELECT 1 FROM users
      WHERE users.user_id = ? AND users.employee_status = 'active'
    )`);
    binds.push(target.ownerId);
  } else {
    clauses.push(`EXISTS (
      SELECT 1 FROM teams
      WHERE teams.id = ? AND teams.environment = ?
        AND teams.deleted_at IS NULL AND teams.status = 'active'
    )`);
    binds.push(target.ownerId, environment);
  }
  clauses.push(`EXISTS (
    SELECT 1 FROM site_routes
    WHERE site_routes.id = ? AND site_routes.site_id = sites.id
      AND site_routes.environment = ? AND site_routes.route_generation = ?
      AND site_routes.policy_version = ? AND site_routes.active_version_id IS ?
      AND site_routes.runtime_config_generation = ? AND site_routes.visibility = ?
      ${target.ownerType === 'team' && targetVisibility === undefined ? "AND site_routes.visibility != 'owner'" : ''}
  )`);
  binds.push(
    expectedRoute.id,
    environment,
    expectedRoute.routeGeneration,
    expectedRoute.policyVersion,
    expectedRoute.activeVersionId,
    expectedRoute.runtimeConfigGeneration,
    expectedRoute.visibility
  );
  if (target.ownerType === 'team' && targetVisibility === 'owner') clauses.push('0');
  return guardedMatchStatements(store, clauses, binds, SITE_TRANSFER_INVARIANT_FAILED);
}

function sourceAuthorizationClause(authorization, { environment, siteId, now }) {
  if (authorization.kind === 'platform_admin') {
    return {
      sql: `EXISTS (
        SELECT 1 FROM platform_admins
        JOIN users ON users.user_id = platform_admins.user_id
        WHERE platform_admins.environment = ? AND platform_admins.user_id = ?
          AND platform_admins.revoked_at IS NULL AND users.employee_status = 'active'
      )`,
      binds: [environment, authorization.actorUserId],
    };
  }

  const actorUserId = authorization.actorUserId;
  const siteAccess = userSiteAccessClause(actorUserId, environment);
  if (authorization.kind === 'user') return siteAccess;

  if (authorization.kind === 'cli_login') {
    return combineClauses(
      {
        sql: `EXISTS (
          SELECT 1 FROM access_keys
          JOIN users ON users.user_id = COALESCE(access_keys.owner_id, access_keys.owner_user_id)
          WHERE access_keys.id = ?
            AND (access_keys.environment = ? OR (access_keys.environment IS NULL AND access_keys.site_id = ?))
            AND access_keys.revoked_at IS NULL
            AND (access_keys.expires_at IS NULL OR access_keys.expires_at > ?)
            AND access_keys.issued_source = 'cli_login'
            AND COALESCE(access_keys.owner_type, 'user') = 'user'
            AND COALESCE(access_keys.owner_id, access_keys.owner_user_id) = ?
            AND users.employee_status = 'active'
            AND (
              access_keys.issued_session_version IS NULL
              OR access_keys.issued_session_version <= 0
              OR access_keys.issued_session_version = users.session_version
            )
        )`,
        binds: [authorization.accessKeyId, environment, siteId, now, actorUserId],
      },
      siteAccess
    );
  }

  if (authorization.kind === 'access_key') {
    const keyIsCurrent = {
      sql: `EXISTS (
        SELECT 1 FROM access_keys
        WHERE access_keys.id = ?
          AND (access_keys.environment = ? OR (access_keys.environment IS NULL AND access_keys.site_id = ?))
          AND access_keys.revoked_at IS NULL
          AND (access_keys.expires_at IS NULL OR access_keys.expires_at > ?)
          AND COALESCE(access_keys.owner_type, 'user') = ?
          AND COALESCE(access_keys.owner_id, access_keys.owner_user_id) = ?
          AND (access_keys.site_id IS NULL OR access_keys.site_id = ?)
          AND EXISTS (
            SELECT 1 FROM json_each(access_keys.scopes_json)
            WHERE json_each.value IN ('deploy:site', '*')
          )
      )`,
      binds: [authorization.accessKeyId, environment, siteId, now, authorization.ownerType, authorization.ownerId, siteId],
    };
    if (authorization.ownerType === 'team') {
      return combineClauses(keyIsCurrent, {
        sql: `sites.owner_type = 'team' AND sites.owner_id = ? AND EXISTS (
          SELECT 1 FROM teams
          WHERE teams.id = ? AND teams.environment = ?
            AND teams.deleted_at IS NULL AND teams.status = 'active'
        )`,
        binds: [authorization.ownerId, authorization.ownerId, environment],
      });
    }
    return combineClauses(
      keyIsCurrent,
      {
        sql: `EXISTS (
          SELECT 1 FROM users
          WHERE users.user_id = ? AND users.employee_status = 'active'
        )`,
        binds: [authorization.ownerId],
      },
      userSiteAccessClause(authorization.ownerId, environment)
    );
  }

  return { sql: '0', binds: [] };
}

function userSiteAccessClause(userId, environment) {
  return {
    sql: `EXISTS (
      SELECT 1 FROM users
      WHERE users.user_id = ? AND users.employee_status = 'active'
    ) AND (
      (COALESCE(sites.owner_type, 'user') = 'user' AND COALESCE(sites.owner_id, sites.owner_user_id) = ?)
      OR (
        sites.owner_type = 'team'
        AND EXISTS (
          SELECT 1 FROM teams
          WHERE teams.id = sites.owner_id AND teams.environment = ?
            AND teams.status = 'active' AND teams.deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM team_members
          WHERE team_members.team_id = sites.owner_id AND team_members.user_id = ?
            AND team_members.removed_at IS NULL AND team_members.role IN ('publisher', 'admin')
        )
      )
    )`,
    binds: [userId, userId, environment, userId],
  };
}

function targetTeamRoleClause(authorization, target) {
  if (target?.ownerType !== 'team' || authorization.kind === 'platform_admin') return null;
  if (authorization.kind === 'access_key' && authorization.ownerType === 'team') {
    return authorization.ownerId === target.ownerId ? null : { sql: '0', binds: [] };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.team_id = ? AND team_members.user_id = ?
        AND team_members.removed_at IS NULL AND team_members.role IN ('publisher', 'admin')
    )`,
    binds: [target.ownerId, authorization.actorUserId],
  };
}

function combineClauses(...clauses) {
  return {
    sql: clauses.map((clause) => `(${clause.sql})`).join(' AND '),
    binds: clauses.flatMap((clause) => clause.binds),
  };
}

function guardedMatchStatements(store, clauses, binds, errorCode) {
  return [
    store.db
      .prepare(`UPDATE sites SET updated_at = updated_at WHERE ${clauses.map((clause) => `(${clause})`).join(' AND ')}`)
      .bind(...binds),
    store.db.prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`).bind(errorCode),
  ];
}
