import {
  cloneRecord,
  deploymentEventRecord,
  deploymentIdempotencyScope,
  mapDeployment,
  mapDeploymentEvent,
  mapDeploymentResourceCleanupTask,
  mapSiteRoute,
  normalizeNullableString,
  normalizeRequiredString,
  stringifyJsonColumn,
} from '../store-support.js';

export const deploymentsRepositoryMethods = {
  async getDeployment(id, environment) {
    const row = await this.db
      .prepare('SELECT * FROM deployments WHERE id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapDeployment(row) : null;
  },

  async createDeploymentEvent(input) {
    const record = deploymentEventRecord(input, this.now);
    await this.db
      .prepare(
        `INSERT INTO deployment_events (
            id, environment, trace_id, inbound_ray_id, deployment_id, site_id,
            attempt, stage, operation, status, started_at, completed_at,
            duration_ms, error_code, error_message, diagnostics_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.traceId,
        record.inboundRayId,
        record.deploymentId,
        record.siteId,
        record.attempt,
        record.stage,
        record.operation,
        record.status,
        record.startedAt,
        record.completedAt,
        record.durationMs,
        record.errorCode,
        record.errorMessage,
        stringifyJsonColumn(record.diagnostics),
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  },

  async listDeploymentEvents({ environment, deploymentId, traceId } = {}) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedDeploymentId = normalizeRequiredString(deploymentId);
    const normalizedTraceId = normalizeRequiredString(traceId);
    if (!normalizedEnvironment || (!normalizedDeploymentId && !normalizedTraceId)) return [];
    const filters = ['environment = ?'];
    const values = [normalizedEnvironment];
    if (normalizedDeploymentId) {
      filters.push('deployment_id = ?');
      values.push(normalizedDeploymentId);
    }
    if (normalizedTraceId) {
      filters.push('trace_id = ?');
      values.push(normalizedTraceId);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM deployment_events
          WHERE ${filters.join(' AND ')}
          ORDER BY started_at ASC, created_at ASC, id ASC`
      )
      .bind(...values)
      .all();
    return (result.results || []).map(mapDeploymentEvent);
  },

  async updateDeployment(id, patch) {
    const existing = await this.getDeployment(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    await this.db
      .prepare(
        `UPDATE deployments SET
            version_id = ?, status = ?, terminal_response_json = ?, previous_version_id = ?,
            error_code = ?, error_message = ?, failure_stage = ?, failure_diagnostics_json = ?, completed_at = ?
          WHERE id = ?`
      )
      .bind(
        next.versionId,
        next.status,
        next.terminalResponseJson,
        next.previousVersionId,
        next.errorCode,
        next.errorMessage,
        next.failureStage,
        stringifyJsonColumn(next.failureDiagnostics),
        next.completedAt,
        id
      )
      .run();
    return this.getDeployment(id);
  },

  async claimDeploymentTrace({ id, environment, traceId }) {
    await this.db
      .prepare(
        `UPDATE deployments
          SET trace_id = ?
          WHERE id = ? AND environment = ? AND trace_id IS NULL`
      )
      .bind(traceId, id, environment)
      .run();
    return this.getDeployment(id, environment);
  },

  async createDeploymentForIdempotency(input) {
    const idempotencyScope = deploymentIdempotencyScope(input);
    const existing = await this.db
      .prepare('SELECT * FROM deployments WHERE idempotency_scope = ? AND idempotency_key = ?')
      .bind(idempotencyScope, input.idempotencyKey)
      .first();
    if (existing) {
      const deployment = mapDeployment(existing);
      if (deployment.requestHash !== input.requestHash) return { kind: 'conflict', deployment };
      return { kind: 'existing', deployment };
    }

    const now = this.now();
    const record = {
      id: input.id,
      environment: input.environment,
      siteId: input.siteId,
      versionId: input.versionId || null,
      actorId: input.actorId,
      actorUserId: input.actorUserId || null,
      actorType: input.actorType,
      source: input.source,
      operation: input.operation,
      visibility: input.visibility || null,
      status: input.status,
      idempotencyKey: input.idempotencyKey,
      idempotencyScope,
      requestHash: input.requestHash,
      traceId: input.traceId || null,
      terminalResponseJson: input.terminalResponseJson || null,
      previousVersionId: input.previousVersionId || null,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      failureStage: input.failureStage || null,
      failureDiagnostics: input.failureDiagnostics || null,
      createdAt: now,
      completedAt: input.completedAt || null,
    };
    await this.db
      .prepare(
        `INSERT INTO deployments (
            id, environment, site_id, version_id, actor_id, actor_user_id,
            actor_type, source, operation, visibility, status, idempotency_key,
            idempotency_scope, request_hash, trace_id, terminal_response_json,
            previous_version_id, error_code, error_message, failure_stage,
            failure_diagnostics_json, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.siteId,
        record.versionId,
        record.actorId,
        record.actorUserId,
        record.actorType,
        record.source,
        record.operation,
        record.visibility,
        record.status,
        record.idempotencyKey,
        record.idempotencyScope,
        record.requestHash,
        record.traceId,
        record.terminalResponseJson,
        record.previousVersionId,
        record.errorCode,
        record.errorMessage,
        record.failureStage,
        stringifyJsonColumn(record.failureDiagnostics),
        record.createdAt,
        record.completedAt
      )
      .run();
    return { kind: 'created', deployment: cloneRecord(record) };
  },

  async createDeploymentResourceCleanupTask(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id,
      environment: normalizeRequiredString(input.environment),
      resourceType: normalizeRequiredString(input.resourceType),
      resourceRef: normalizeRequiredString(input.resourceRef),
      siteId: input.siteId || null,
      versionId: input.versionId || null,
      deploymentId: input.deploymentId || null,
      cleanupReason: normalizeRequiredString(input.cleanupReason),
      status: input.status || 'pending',
      cleanupAfter: input.cleanupAfter || now,
      attemptCount: Number(input.attemptCount || 0),
      lastErrorCode: input.lastErrorCode || null,
      lastErrorMessage: input.lastErrorMessage || null,
      lockedUntil: input.lockedUntil || null,
      createdAt: now,
      updatedAt: input.updatedAt || now,
    };
    if (!record.id || !record.environment || !record.resourceType || !record.resourceRef || !record.cleanupReason) {
      throw new Error('CLEANUP_TASK_INVALID');
    }
    await this.db
      .prepare(
        `INSERT INTO deployment_resource_cleanup_tasks (
            id, environment, resource_type, resource_ref, site_id, version_id,
            deployment_id, cleanup_reason, status, cleanup_after, attempt_count,
            last_error_code, last_error_message, locked_until, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.resourceType,
        record.resourceRef,
        record.siteId,
        record.versionId,
        record.deploymentId,
        record.cleanupReason,
        record.status,
        record.cleanupAfter,
        record.attemptCount,
        record.lastErrorCode,
        record.lastErrorMessage,
        record.lockedUntil,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(record);
  },

  async listDeploymentResourceCleanupTasks({ environment, status, limit = 100 } = {}) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    if (!normalizedEnvironment) return [];
    const normalizedStatus = normalizeNullableString(status);
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const result = await this.db
      .prepare(
        `SELECT *
          FROM deployment_resource_cleanup_tasks
          WHERE environment = ?${normalizedStatus ? ' AND status = ?' : ''}
          ORDER BY cleanup_after ASC, created_at ASC
          LIMIT ?`
      )
      .bind(
        ...(normalizedStatus
          ? [normalizedEnvironment, normalizedStatus, normalizedLimit]
          : [normalizedEnvironment, normalizedLimit])
      )
      .all();
    return (result.results || []).map(mapDeploymentResourceCleanupTask);
  },

  async getDeploymentResourceCleanupTask(id, environment) {
    const row = await this.db
      .prepare('SELECT * FROM deployment_resource_cleanup_tasks WHERE id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapDeploymentResourceCleanupTask(row) : null;
  },

  async markDeploymentResourceCleanupRunning({ id, environment, lockedUntil, updatedAt }) {
    const now = updatedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE deployment_resource_cleanup_tasks
          SET status = 'running', attempt_count = attempt_count + 1,
            locked_until = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
          WHERE id = ? AND environment = ?
            AND (status IN ('pending', 'failed') OR (status = 'running' AND locked_until <= ?))`
      )
      .bind(lockedUntil || null, now, id, environment, now)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getDeploymentResourceCleanupTask(id, environment);
  },

  async finishDeploymentResourceCleanupTask({ id, environment, status, errorCode = null, errorMessage = null, updatedAt }) {
    const now = updatedAt || this.now();
    await this.db
      .prepare(
        `UPDATE deployment_resource_cleanup_tasks
          SET status = ?, last_error_code = ?, last_error_message = ?, locked_until = NULL, updated_at = ?
          WHERE id = ? AND environment = ?`
      )
      .bind(status, errorCode, errorMessage, now, id, environment)
      .run();
    return this.getDeploymentResourceCleanupTask(id, environment);
  },

  async markSiteVersionArtifactAvailability({ id, environment, artifactAvailability }) {
    await this.db
      .prepare(
        `UPDATE site_versions
          SET artifact_availability = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM sites
              WHERE sites.id = site_versions.site_id
                ${environment ? 'AND sites.environment = ?' : ''}
            )`
      )
      .bind(...(environment ? [artifactAvailability, id, environment] : [artifactAvailability, id]))
      .run();
    return this.getSiteVersion(id, environment);
  },

  async findActiveRouteByWorkerResource({ environment, workerName, versionId }) {
    const conditions = ["route_status = 'active'", 'environment = ?'];
    const binds = [environment];
    if (workerName && versionId) {
      conditions.push('(worker_name = ? OR active_version_id = ?)');
      binds.push(workerName, versionId);
    } else if (workerName) {
      conditions.push('worker_name = ?');
      binds.push(workerName);
    } else if (versionId) {
      conditions.push('active_version_id = ?');
      binds.push(versionId);
    } else {
      return null;
    }
    const row = await this.db
      .prepare(`SELECT * FROM site_routes WHERE ${conditions.join(' AND ')} LIMIT 1`)
      .bind(...binds)
      .first();
    return row ? mapSiteRoute(row) : null;
  },
};
