import { mapPlatformAdmin, normalizeNullableString, normalizeRequiredString, platformAdminAuditEvent } from '../store-support.js';

export const identityRepositoryMethods = {
  async grantPlatformAdmin({ environment, userId, grantedByUserId, grantReason }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedUserId = normalizeRequiredString(userId);
    const normalizedGrantedBy = normalizeRequiredString(grantedByUserId);
    if (!normalizedEnvironment || !normalizedUserId || !normalizedGrantedBy) throw new Error('PLATFORM_ADMIN_INVALID');

    const now = this.now();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO platform_admins (
                environment, user_id, granted_by_user_id, grant_reason,
                revoked_at, revoked_by_user_id, revoke_reason, created_at, updated_at
              ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
              ON CONFLICT(environment, user_id) DO UPDATE SET
                granted_by_user_id = excluded.granted_by_user_id,
                grant_reason = excluded.grant_reason,
                revoked_at = NULL,
                revoked_by_user_id = NULL,
                revoke_reason = NULL,
                updated_at = excluded.updated_at`
        )
        .bind(normalizedEnvironment, normalizedUserId, normalizedGrantedBy, normalizeNullableString(grantReason), now, now),
      this.auditEventStatement(
        platformAdminAuditEvent(
          {
            environment: normalizedEnvironment,
            targetUserId: normalizedUserId,
            actorUserId: normalizedGrantedBy,
          },
          'admin.platform_admin.grant',
          now
        )
      ),
    ]);
    return this.getPlatformAdmin({ environment: normalizedEnvironment, userId: normalizedUserId, includeRevoked: true });
  },

  async revokePlatformAdmin({ environment, userId, revokedByUserId, revokeReason }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedUserId = normalizeRequiredString(userId);
    const normalizedRevokedBy = normalizeRequiredString(revokedByUserId);
    if (!normalizedEnvironment || !normalizedUserId || !normalizedRevokedBy) throw new Error('PLATFORM_ADMIN_INVALID');

    const now = this.now();
    const existing = await this.getPlatformAdmin({
      environment: normalizedEnvironment,
      userId: normalizedUserId,
      includeRevoked: true,
    });
    if (!existing) return null;
    if (!existing.revokedAt) {
      const user = typeof this.getUser === 'function' ? await this.getUser(normalizedUserId) : null;
      const targetIsActive = user?.employeeStatus === 'active';
      const activeCount = await this.db
        .prepare(
          `SELECT COUNT(*) AS count
              FROM platform_admins
              JOIN users ON users.user_id = platform_admins.user_id
              WHERE platform_admins.environment = ?
                AND platform_admins.revoked_at IS NULL
                AND users.employee_status = 'active'`
        )
        .bind(normalizedEnvironment)
        .first();
      if (targetIsActive && Number(activeCount?.count || 0) <= 1) throw new Error('PLATFORM_ADMIN_LAST_ACTIVE');
    }
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE platform_admins
              SET revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?, updated_at = ?
              WHERE environment = ? AND user_id = ?`
        )
        .bind(now, normalizedRevokedBy, normalizeNullableString(revokeReason), now, normalizedEnvironment, normalizedUserId),
      this.auditEventStatement(
        platformAdminAuditEvent(
          {
            environment: normalizedEnvironment,
            targetUserId: normalizedUserId,
            actorUserId: normalizedRevokedBy,
          },
          'admin.platform_admin.revoke',
          now
        )
      ),
    ]);
    return this.getPlatformAdmin({ environment: normalizedEnvironment, userId: normalizedUserId, includeRevoked: true });
  },

  async isPlatformAdmin({ environment, userId }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedUserId = normalizeRequiredString(userId);
    if (!normalizedEnvironment || !normalizedUserId) return false;
    const row = await this.db
      .prepare('SELECT user_id FROM platform_admins WHERE environment = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1')
      .bind(normalizedEnvironment, normalizedUserId)
      .first();
    return Boolean(row);
  },

  async listPlatformAdmins({ environment }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    if (!normalizedEnvironment) return [];
    const result = await this.db
      .prepare(
        `SELECT * FROM platform_admins
            WHERE environment = ? AND revoked_at IS NULL
            ORDER BY user_id ASC`
      )
      .bind(normalizedEnvironment)
      .all();
    return (result.results || []).map(mapPlatformAdmin);
  },

  async getPlatformAdmin({ environment, userId, includeRevoked = false }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedUserId = normalizeRequiredString(userId);
    if (!normalizedEnvironment || !normalizedUserId) return null;
    const row = await this.db
      .prepare(
        `SELECT * FROM platform_admins
            WHERE environment = ? AND user_id = ?${includeRevoked ? '' : ' AND revoked_at IS NULL'}
            LIMIT 1`
      )
      .bind(normalizedEnvironment, normalizedUserId)
      .first();
    return row ? mapPlatformAdmin(row) : null;
  },
};
