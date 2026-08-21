import { randomStoreId } from './common.js';

export function secretAuditEvent(input, eventType, secret, createdAt) {
  return {
    id: input.auditId,
    environment: input.environment,
    traceId: null,
    eventType,
    actorUserId: input.actorId,
    actorType: input.actorType,
    siteId: input.siteId,
    routeId: input.routeId || null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      siteSlug: input.siteSlug,
      revision: secret.revision ?? null,
    },
    createdAt,
  };
}

export function platformAdminAuditEvent(input, eventType, createdAt) {
  return {
    id: randomStoreId('audit'),
    environment: input.environment,
    traceId: null,
    eventType,
    actorUserId: input.actorUserId,
    actorType: 'user',
    siteId: null,
    routeId: null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      environment: input.environment,
      targetUserId: input.targetUserId,
    },
    createdAt,
  };
}

export function departmentTeamAuditEvent(team, eventType, createdAt) {
  return {
    id: randomStoreId('audit'),
    environment: team.environment,
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
    metadata: {
      environment: team.environment,
      teamId: team.id,
      departmentPath: team.departmentPath,
    },
    createdAt,
  };
}

export function departmentMembershipAuditEvent(input, eventType, createdAt) {
  return {
    id: randomStoreId('audit'),
    environment: input.environment,
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
    metadata: {
      environment: input.environment,
      userId: input.userId,
      teamId: input.teamId,
      departmentPath: input.departmentPath,
    },
    createdAt,
  };
}

export function departmentMembershipMigrationAuditEvent(input, createdAt) {
  return {
    id: randomStoreId('audit'),
    environment: input.environment,
    traceId: null,
    eventType: 'system.department_membership.migrate',
    actorUserId: 'system:xds',
    actorType: 'system',
    siteId: null,
    routeId: null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      environment: input.environment,
      userId: input.userId,
      oldTeamId: input.oldTeamId,
      newTeamId: input.newTeamId,
      oldDepartmentPath: input.oldDepartmentPath,
      newDepartmentPath: input.newDepartmentPath,
    },
    createdAt,
  };
}

export function teamDeleteAuditEvent(team, blockingAssets, actorUserId, createdAt) {
  return {
    id: randomStoreId('audit'),
    environment: team.environment,
    traceId: null,
    eventType: 'team.delete',
    actorUserId: actorUserId || null,
    actorType: 'user',
    siteId: null,
    routeId: null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      environment: team.environment,
      teamId: team.id,
      teamName: team.name,
      teamType: team.teamType,
      blockingAssets,
    },
    createdAt,
  };
}
