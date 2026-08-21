import { cloneRecord, mapTeam, mapTeamMember, stringifyJsonColumn } from '../support/index.js';

export const metadataFoundationMethods = {
  async getTeam(teamId) {
    const row = await this.db
      .prepare("SELECT * FROM teams WHERE id = ? AND status = 'active' AND deleted_at IS NULL")
      .bind(teamId)
      .first();
    return row ? mapTeam(row) : null;
  },

  async getTeamMember({ teamId, userId, includeRemoved = false }) {
    const removedFilter = includeRemoved ? '' : ' AND team_members.removed_at IS NULL';
    const row = await this.db
      .prepare(
        `SELECT team_members.*,
            users.user_id AS joined_user_id, users.email AS user_email, users.realname AS user_realname,
            users.account AS user_account, users.employee_status AS user_employee_status,
            users.department_path AS user_department_path
          FROM team_members
          LEFT JOIN users ON users.user_id = team_members.user_id
          WHERE team_members.team_id = ? AND team_members.user_id = ?${removedFilter}`
      )
      .bind(teamId, userId)
      .first();
    return row ? mapTeamMember(row) : null;
  },

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
