import { departmentTeamDisplayName } from '../../../department-path.js';
import { mapSiteWithJoinedRoute } from './sites.js';

export function mapTeam(row) {
  return {
    id: row.id,
    environment: row.environment,
    name: row.name,
    description: row.description || null,
    teamType: row.team_type,
    departmentPath: row.department_path || null,
    status: row.status,
    createdByType: row.created_by_type,
    createdByUserId: row.created_by_user_id || null,
    mergedIntoTeamId: row.merged_into_team_id || null,
    mergedAt: row.merged_at || null,
    mergedByUserId: row.merged_by_user_id || null,
    mergeReason: row.merge_reason || null,
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTeamWithCurrentMember(row) {
  return {
    ...mapTeam(row),
    currentUserRole: row.current_user_role,
    currentUserMembershipSource: row.current_user_membership_source,
    siteCount: Number(row.site_count || 0),
    memberCount: Number(row.member_count || 0),
  };
}

export function mapTeamMember(row) {
  const user =
    row.joined_user_id || row.user_email || row.user_realname || row.user_account
      ? {
          id: row.joined_user_id || row.user_id,
          email: row.user_email || null,
          realname: row.user_realname || null,
          account: row.user_account || null,
          employeeStatus: row.user_employee_status || null,
          departmentPath: row.user_department_path || null,
        }
      : null;
  return {
    teamId: row.team_id,
    userId: row.user_id,
    user,
    role: row.role,
    membershipSource: row.membership_source,
    departmentPath: row.department_path || null,
    roleOverriddenAt: row.role_overridden_at || null,
    removedAt: row.removed_at || null,
    removedByUserId: row.removed_by_user_id || null,
    restoredAt: row.restored_at || null,
    restoredByUserId: row.restored_by_user_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapConsoleTeamSite(row) {
  return {
    ...mapSiteWithJoinedRoute(row),
    ownerType: 'team',
    ownerDisplayName: departmentTeamDisplayName({
      teamType: row.owner_team_type,
      name: row.owner_team_name,
      departmentPath: row.owner_team_department_path,
    }),
    ownerTeamType: row.owner_team_type,
    ownerTeamId: row.owner_team_id,
    managementRole: row.management_role,
  };
}
