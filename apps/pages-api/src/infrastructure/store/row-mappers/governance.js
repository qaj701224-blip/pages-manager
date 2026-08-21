import { departmentTeamDisplayName } from '../../../department-path.js';
import { mapDeployment } from './deployments.js';
import { parseJsonColumn } from '../support/common.js';

export function mapAdminDeploymentWithOwner(row) {
  const deployment = mapDeployment(row);
  const actor = {
    type: deployment.actorType || null,
    id: deployment.actorId || null,
    userId: deployment.actorUserId || null,
    email: row.actor_user_email || null,
    displayName: row.actor_user_realname || null,
  };
  if (!row.joined_site_id) {
    return {
      ...deployment,
      siteSlug: null,
      ownerState: 'not_created',
      ownerType: null,
      ownerId: null,
      ownerUserId: null,
      ownerEmail: null,
      ownerDisplayName: null,
      ownerDepartmentPath: null,
      ownerTeamType: null,
      actor,
    };
  }

  if (row.site_owner_type === 'team') {
    return {
      ...deployment,
      siteSlug: row.site_slug || null,
      ownerState: 'persisted',
      ownerType: 'team',
      ownerId: row.site_owner_id || null,
      ownerDisplayName:
        departmentTeamDisplayName({
          teamType: row.owner_team_type,
          name: row.owner_team_name,
          departmentPath: row.owner_team_department_path,
        }) || null,
      ownerTeamType: row.owner_team_type || null,
      ownerDepartmentPath: row.owner_team_department_path || null,
      actor,
    };
  }

  return {
    ...deployment,
    siteSlug: row.site_slug || null,
    ownerState: 'persisted',
    ownerType: row.site_owner_type || 'user',
    ownerId: row.site_owner_id || row.site_owner_user_id || null,
    ownerUserId: row.site_owner_user_id || row.site_owner_id || null,
    ownerEmail: row.owner_user_email || null,
    ownerDisplayName: row.owner_user_realname || null,
    ownerDepartmentPath: null,
    ownerTeamType: null,
    actor,
  };
}

export function mapPlatformAdmin(row) {
  return {
    environment: row.environment,
    userId: row.user_id,
    grantedByUserId: row.granted_by_user_id,
    grantReason: row.grant_reason || null,
    revokedAt: row.revoked_at || null,
    revokedByUserId: row.revoked_by_user_id || null,
    revokeReason: row.revoke_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAuditEvent(row) {
  return {
    id: row.id,
    environment: row.environment || null,
    traceId: row.trace_id || null,
    eventType: row.event_type,
    actorUserId: row.actor_user_id || null,
    actorType: row.actor_type,
    siteId: row.site_id || null,
    routeId: row.route_id || null,
    versionId: row.version_id || null,
    decision: row.decision,
    statusCode: row.status_code ?? null,
    ipHash: row.ip_hash || null,
    userAgentHash: row.user_agent_hash || null,
    metadata: parseJsonColumn(row.metadata_json),
    createdAt: row.created_at,
    actor: {
      type: row.actor_type,
      userId: row.actor_user_id || null,
      displayName: row.actor_realname || null,
      email: row.actor_email || null,
    },
  };
}
