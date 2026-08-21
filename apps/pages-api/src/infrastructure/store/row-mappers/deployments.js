import { parseJsonColumn } from '../support/common.js';
import { normalizeRequiredString } from '../support/normalizers.js';

export function mapDeployment(row) {
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
    traceId: row.trace_id || null,
    terminalResponseJson: row.terminal_response_json,
    previousVersionId: row.previous_version_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failureStage: row.failure_stage || null,
    failureDiagnostics: parseJsonColumn(row.failure_diagnostics_json),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function deploymentEventRecord(input, now) {
  const record = {
    id: normalizeRequiredString(input.id),
    environment: normalizeRequiredString(input.environment),
    traceId: normalizeRequiredString(input.traceId),
    inboundRayId: input.inboundRayId || null,
    deploymentId: input.deploymentId || null,
    siteId: input.siteId || null,
    attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
    stage: normalizeRequiredString(input.stage),
    operation: input.operation || null,
    status: normalizeRequiredString(input.status),
    startedAt: normalizeRequiredString(input.startedAt),
    completedAt: input.completedAt || null,
    durationMs: Number.isInteger(input.durationMs) && input.durationMs >= 0 ? input.durationMs : null,
    errorCode: input.errorCode || null,
    errorMessage: input.errorMessage || null,
    diagnostics: input.diagnostics || null,
    createdAt: input.createdAt || now(),
  };
  if (!record.id || !record.environment || !record.traceId || !record.stage || !record.status || !record.startedAt) {
    throw new Error('DEPLOYMENT_EVENT_INVALID');
  }
  return record;
}

export function mapDeploymentEvent(row) {
  return {
    id: row.id,
    environment: row.environment,
    traceId: row.trace_id,
    inboundRayId: row.inbound_ray_id || null,
    deploymentId: row.deployment_id || null,
    siteId: row.site_id || null,
    attempt: Number(row.attempt || 1),
    stage: row.stage,
    operation: row.operation || null,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    diagnostics: parseJsonColumn(row.diagnostics_json),
    createdAt: row.created_at,
  };
}

export function mapDeploymentResourceCleanupTask(row) {
  return {
    id: row.id,
    environment: row.environment,
    resourceType: row.resource_type,
    resourceRef: row.resource_ref,
    siteId: row.site_id || null,
    versionId: row.version_id || null,
    deploymentId: row.deployment_id || null,
    cleanupReason: row.cleanup_reason,
    status: row.status,
    cleanupAfter: row.cleanup_after,
    attemptCount: Number(row.attempt_count || 0),
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    lockedUntil: row.locked_until || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
