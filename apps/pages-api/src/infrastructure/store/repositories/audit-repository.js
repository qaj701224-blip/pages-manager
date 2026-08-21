import { cloneRecord, stringifyJsonColumn } from '../store-support.js';

export const auditRepositoryMethods = {
  async recordAuditEvent(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id,
      environment: input.environment || input.metadata?.environment || null,
      traceId: input.traceId || null,
      eventType: input.eventType,
      actorUserId: input.actorUserId || null,
      actorType: input.actorType,
      siteId: input.siteId || null,
      routeId: input.routeId || null,
      versionId: input.versionId || null,
      decision: input.decision,
      statusCode: input.statusCode ?? null,
      ipHash: input.ipHash || null,
      userAgentHash: input.userAgentHash || null,
      metadata: input.metadata || null,
      createdAt: now,
    };
    await this.auditEventStatement(record).run();
    return cloneRecord(record);
  },

  auditEventStatement(record) {
    const environment = record.environment || record.metadata?.environment || null;
    return this.db
      .prepare(
        `INSERT INTO audit_events (
            id, environment, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
            decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        environment,
        record.traceId ?? null,
        record.eventType,
        record.actorUserId ?? null,
        record.actorType,
        record.siteId ?? null,
        record.routeId ?? null,
        record.versionId ?? null,
        record.decision,
        record.statusCode ?? null,
        record.ipHash ?? null,
        record.userAgentHash ?? null,
        stringifyJsonColumn(record.metadata ?? null),
        record.createdAt
      );
  },
};
