import { deriveDepartmentTeamIdentity, normalizeDepartmentPath } from '../department-path.js';

export { deriveDepartmentTeamIdentity, normalizeDepartmentPath };

export function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
}

export function stringifyJsonColumn(value) {
  return value == null ? null : JSON.stringify(value);
}

export function normalizeNullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 500) : null;
}

export function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function normalizeUserEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function randomStoreId(prefix) {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) throw new Error('STORE_ID_CRYPTO_UNAVAILABLE');
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function mapUser(row) {
  return {
    id: row.user_id,
    email: row.email,
    realname: row.realname,
    account: row.account,
    accountId: row.account_id,
    employeenum: row.employeenum,
    employeeStatus: row.employee_status,
    feishuOpenId: row.feishu_open_id || null,
    cindyMembershipId: row.cindy_membership_id || null,
    createdSource: row.created_source || 'xd_sso',
    departmentPath: row.department_path || null,
    departmentCheckedAt: row.department_checked_at || null,
    sessionVersion: row.session_version,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

export function assertDepartmentMergeTeams(source, target) {
  if (!source || !target) throw new Error('TEAM_NOT_FOUND');
  if (source.id === target.id) throw new Error('TEAM_MERGE_TARGET_INVALID');
  if (source.environment !== target.environment) throw new Error('TEAM_MERGE_ENVIRONMENT_MISMATCH');
  if (source.teamType !== 'department' || target.teamType !== 'department') {
    throw new Error('TEAM_MERGE_DEPARTMENT_REQUIRED');
  }
  if (source.status !== 'active' || source.deletedAt || source.mergedIntoTeamId) {
    throw new Error('TEAM_MERGE_SOURCE_INACTIVE');
  }
  if (target.status !== 'active' || target.deletedAt) throw new Error('TEAM_MERGE_TARGET_INACTIVE');
}

export function departmentTeamId(environment, departmentPath) {
  const normalizedPath = normalizeDepartmentPath(departmentPath);
  const normalizedEnvironment = normalizeRequiredString(environment).replaceAll(/[^A-Za-z0-9]+/g, '_') || 'unknown';
  if (!normalizedPath) return 'team_department_unknown';
  return `team_department_${normalizedEnvironment}_${fnv1a64Hex(normalizedPath)}`;
}

export function departmentTeamAuditEvent(team, eventType, createdAt) {
  return departmentAuditEvent({
    environment: team.environment,
    eventType,
    metadata: {
      environment: team.environment,
      teamId: team.id,
      departmentPath: team.departmentPath,
    },
    createdAt,
  });
}

export function departmentMembershipAuditEvent(input, eventType, createdAt) {
  return departmentAuditEvent({
    environment: input.environment,
    eventType,
    metadata: {
      environment: input.environment,
      userId: input.userId,
      teamId: input.teamId,
      departmentPath: input.departmentPath,
    },
    createdAt,
  });
}

export function departmentMembershipMigrationAuditEvent(input, createdAt) {
  return departmentAuditEvent({
    environment: input.environment,
    eventType: 'system.department_membership.migrate',
    metadata: {
      environment: input.environment,
      userId: input.userId,
      oldTeamId: input.oldTeamId,
      newTeamId: input.newTeamId,
      oldDepartmentPath: input.oldDepartmentPath,
      newDepartmentPath: input.newDepartmentPath,
    },
    createdAt,
  });
}

function departmentAuditEvent({ environment, eventType, metadata, createdAt }) {
  return {
    id: randomStoreId('audit'),
    environment,
    traceId: null,
    eventType,
    actorUserId: 'system:xds',
    actorType: 'system',
    siteId: null,
    routeId: null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata,
    createdAt,
  };
}

function fnv1a64Hex(value) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new globalThis.TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
