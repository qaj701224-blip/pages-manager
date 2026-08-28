import { deriveDepartmentTeamIdentity } from '../../../department-path.js';

export function mapPublicSite(row) {
  const ownerType = row.owner_type;
  return {
    id: row.id,
    title: row.title || null,
    slug: row.slug,
    slugRevision: Number(row.slug_revision),
    slugRoutingSyncedRevision: Number(row.slug_routing_synced_revision),
    environment: row.environment,
    ownerType,
    ownerId: row.owner_id || row.owner_user_id,
    ownerUserId: row.owner_user_id,
    ownerDisplayName: ownerDisplayName(row, ownerType),
    managementRole: row.management_role || null,
    hostname: row.route_hostname,
    visibility: row.route_visibility,
    createdAt: row.created_at,
    updatedAt: row.effective_updated_at,
  };
}

function ownerDisplayName(row, ownerType) {
  if (ownerType === 'team') {
    if (row.owner_team_type === 'department') {
      return nonBlankString(deriveDepartmentTeamIdentity(row.owner_team_department_path || row.owner_team_name).displayName);
    }
    return nonBlankString(row.owner_team_name);
  }
  return nonBlankString(row.owner_user_realname);
}

function nonBlankString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}
