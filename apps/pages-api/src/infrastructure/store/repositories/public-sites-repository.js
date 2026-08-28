import { mapPublicSite } from '../store-support.js';

const PUBLIC_SITES_CTE = `WITH public_sites AS (
  SELECT
    sites.id,
    sites.title,
    sites.slug,
    sites.slug_revision,
    sites.slug_routing_synced_revision,
    sites.environment,
    COALESCE(sites.owner_type, 'user') AS owner_type,
    route.hostname AS route_hostname,
    route.visibility AS route_visibility,
    sites.created_at,
    CASE WHEN route.updated_at > sites.updated_at
      THEN route.updated_at ELSE sites.updated_at
    END AS effective_updated_at
  FROM sites
  JOIN users AS viewer_users
    ON viewer_users.user_id = ?
   AND viewer_users.employee_status = 'active'
  JOIN site_routes AS route ON route.id = (
    SELECT latest.id FROM site_routes AS latest INDEXED BY idx_site_routes_site_id
    WHERE latest.site_id = sites.id AND latest.environment = sites.environment
    ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1
  )
  JOIN site_versions AS active_version
    ON active_version.id = route.active_version_id
   AND active_version.site_id = sites.id
  WHERE sites.environment = ?
    AND sites.deleted_at IS NULL
    AND route.route_status = 'active'
    AND route.visibility IN ('internal', 'org', 'acl', 'owner')
    AND COALESCE(sites.owner_type, 'user') IN ('user', 'team')
    AND (
      COALESCE(sites.owner_type, 'user') = 'user'
      OR EXISTS (
        SELECT 1 FROM teams AS owner_team
        WHERE owner_team.id = sites.owner_id
          AND owner_team.environment = sites.environment
          AND owner_team.status = 'active'
          AND owner_team.deleted_at IS NULL
      )
    )
    AND (
      (
        COALESCE(sites.owner_type, 'user') = 'user'
        AND COALESCE(sites.owner_id, sites.owner_user_id) = viewer_users.user_id
      )
      OR route.visibility IN ('internal', 'org')
      OR (
        sites.owner_type = 'team'
        AND route.visibility IN ('internal', 'org', 'acl')
        AND EXISTS (
          SELECT 1 FROM team_members AS viewer_team_member
          WHERE viewer_team_member.team_id = sites.owner_id
            AND viewer_team_member.user_id = viewer_users.user_id
            AND viewer_team_member.role IN ('viewer', 'publisher', 'admin')
            AND viewer_team_member.removed_at IS NULL
        )
      )
      OR (
        route.visibility = 'acl'
        AND EXISTS (
          SELECT 1 FROM site_acl_entries AS acl_entry
          WHERE acl_entry.site_id = sites.id
            AND acl_entry.effect = 'allow'
            AND acl_entry.access_role = 'viewer'
            AND (
              (
                acl_entry.subject_type = 'email'
                AND trim(acl_entry.subject_value) <> ''
                AND trim(COALESCE(viewer_users.email, '')) <> ''
                AND lower(trim(acl_entry.subject_value)) = lower(trim(viewer_users.email))
              )
              OR (
                ? = 1
                AND acl_entry.subject_type = 'department'
                AND trim(acl_entry.subject_value) <> ''
                AND trim(COALESCE(viewer_users.department_path, '')) <> ''
                AND (
                  viewer_users.department_path = acl_entry.subject_value
                  OR substr(viewer_users.department_path, 1, length(acl_entry.subject_value) + 1) =
                    acl_entry.subject_value || '/'
                )
              )
            )
        )
      )
    )
)`;

const PUBLIC_SITE_COLUMNS = `id, title, slug, slug_revision, slug_routing_synced_revision,
  environment, owner_type, route_hostname, route_visibility, created_at, effective_updated_at`;

const LIST_PUBLIC_SITES_SQL = `${PUBLIC_SITES_CTE}
SELECT ${PUBLIC_SITE_COLUMNS}
FROM public_sites
ORDER BY effective_updated_at DESC, id DESC
LIMIT ?`;

const LIST_PUBLIC_SITES_AFTER_CURSOR_SQL = `${PUBLIC_SITES_CTE}
SELECT ${PUBLIC_SITE_COLUMNS}
FROM public_sites
WHERE effective_updated_at < ?
   OR (effective_updated_at = ? AND id < ?)
ORDER BY effective_updated_at DESC, id DESC
LIMIT ?`;

export const publicSitesRepositoryMethods = {
  async listPublicSitesForUser({ environment, viewerUserId, limit = 50, cursor = null, departmentAclEnabled = false }) {
    const normalizedLimit = normalizePublicSitesLimit(limit);
    const baseBinds = [viewerUserId, environment, departmentAclEnabled === true ? 1 : 0];
    const sql = cursor ? LIST_PUBLIC_SITES_AFTER_CURSOR_SQL : LIST_PUBLIC_SITES_SQL;
    const cursorBinds = cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : [];
    const result = await this.db
      .prepare(sql)
      .bind(...baseBinds, ...cursorBinds, normalizedLimit + 1)
      .all();
    return (result.results || []).map(mapPublicSite);
  },
};

function normalizePublicSitesLimit(limit) {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit)) return 50;
  return Math.max(1, Math.min(Math.trunc(numericLimit), 100));
}
