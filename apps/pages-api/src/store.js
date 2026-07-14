import { departmentTeamDisplayName, deriveDepartmentTeamIdentity, normalizeDepartmentPath } from './department-path.js';

export function createPagesStore(env = {}) {
  if (env.PAGES_STORE) return env.PAGES_STORE;
  if (!env.PAGES_METADATA) throw new Error('PAGES_METADATA binding is required');
  return new D1PagesStore(env.PAGES_METADATA, {
    secretEncryptionKey: env.SITE_SECRET_ENCRYPTION_KEY || env.PAGES_SECRET_ENCRYPTION_KEY,
  });
}

export class D1PagesStore {
  constructor(db, { now = () => new Date().toISOString(), secretEncryptionKey = null } = {}) {
    this.db = db;
    this.now = now;
    this.secretEncryptionKey = secretEncryptionKey;
  }

  async createUser(input) {
    const now = this.now();
    const userId = input.userId || input.id;
    const record = {
      id: userId,
      email: input.email,
      realname: input.realname || null,
      account: input.account || null,
      accountId: input.accountId || null,
      employeenum: input.employeenum || null,
      employeeStatus: input.employeeStatus || 'unknown',
      feishuOpenId: input.feishuOpenId || null,
      createdSource: input.createdSource || 'xd_sso',
      departmentPath: input.departmentPath || null,
      departmentCheckedAt: input.departmentCheckedAt || null,
      sessionVersion: input.sessionVersion || 1,
      lastLoginAt: input.lastLoginAt || null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO users (
          user_id, account, account_id, email, realname, employeenum, employee_status,
          feishu_open_id, created_source, department_path, department_checked_at,
          session_version, last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.account,
        record.accountId,
        record.email,
        record.realname,
        record.employeenum,
        record.employeeStatus,
        record.feishuOpenId,
        record.createdSource,
        record.departmentPath,
        record.departmentCheckedAt,
        record.sessionVersion,
        record.lastLoginAt,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(record);
  }

  async upsertUserFromSso(input) {
    const incomingUserId = input.userId || input.id;
    const byId = await this.getUser(incomingUserId);
    const byEmail = await this.getUserByEmail(input.email);
    if (byId && byEmail && byId.id !== byEmail.id) {
      const error = new Error('USER_IDENTITY_CONFLICT');
      error.code = 'USER_IDENTITY_CONFLICT';
      throw error;
    }
    const existing = byId || byEmail;
    const userId = byId?.id || byEmail?.id || incomingUserId;
    const now = input.updatedAt || this.now();
    const incomingSessionVersion = input.sessionVersion || 1;
    const record = {
      id: userId,
      email: input.email,
      realname: input.realname || null,
      account: input.account || null,
      accountId: input.accountId || null,
      employeenum: input.employeenum || null,
      employeeStatus: input.employeeStatus || 'unknown',
      feishuOpenId: existing?.feishuOpenId || null,
      createdSource: existing?.createdSource || 'xd_sso',
      departmentPath: input.departmentPath || null,
      departmentCheckedAt: input.departmentCheckedAt || null,
      sessionVersion: incomingSessionVersion,
      lastLoginAt: input.lastLoginAt || now,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO users (
          user_id, account, account_id, email, realname, employeenum, employee_status,
          feishu_open_id, created_source, department_path, department_checked_at,
          session_version, last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          account = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.account
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.account
            ELSE COALESCE(excluded.account, users.account)
          END,
          account_id = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.account_id
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.account_id
            ELSE COALESCE(excluded.account_id, users.account_id)
          END,
          email = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.email
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.email
            ELSE excluded.email
          END,
          realname = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.realname
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.realname
            ELSE COALESCE(excluded.realname, users.realname)
          END,
          employeenum = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.employeenum
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.employeenum
            ELSE COALESCE(excluded.employeenum, users.employeenum)
          END,
          employee_status = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.employee_status
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.employee_status
            ELSE excluded.employee_status
          END,
          department_path = COALESCE(excluded.department_path, users.department_path),
          department_checked_at = COALESCE(excluded.department_checked_at, users.department_checked_at),
          session_version = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.session_version
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.session_version
            WHEN users.employee_status = CASE
              WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.employee_status
              WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
                THEN users.employee_status
              ELSE excluded.employee_status
            END
              THEN MAX(users.session_version, excluded.session_version)
            ELSE MAX(users.session_version + 1, excluded.session_version)
          END,
          last_login_at = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.last_login_at
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.last_login_at
            ELSE excluded.last_login_at
          END,
          updated_at = CASE
            WHEN users.employee_status = 'left' AND excluded.employee_status != 'left' THEN users.updated_at
            WHEN users.employee_status = 'disabled' AND excluded.employee_status IN ('active', 'unknown')
              THEN users.updated_at
            ELSE excluded.updated_at
          END`
      )
      .bind(
        record.id,
        record.account,
        record.accountId,
        record.email,
        record.realname,
        record.employeenum,
        record.employeeStatus,
        record.feishuOpenId,
        record.createdSource,
        record.departmentPath,
        record.departmentCheckedAt,
        record.sessionVersion,
        record.lastLoginAt,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return this.getUser(userId);
  }

  async getUser(id) {
    const row = await this.db.prepare('SELECT * FROM users WHERE user_id = ?').bind(id).first();
    return row ? mapUser(row) : null;
  }

  async getUserByEmail(email) {
    const normalizedEmail = normalizeUserEmail(email);
    if (!normalizedEmail) return null;
    const row = await this.db.prepare('SELECT * FROM users WHERE lower(email) = ?').bind(normalizedEmail).first();
    return row ? mapUser(row) : null;
  }

  async getUserByFeishuOpenId(feishuOpenId) {
    if (!feishuOpenId) return null;
    const row = await this.db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').bind(feishuOpenId).first();
    return row ? mapUser(row) : null;
  }

  async bindUserFeishuOpenId(userId, feishuOpenId) {
    if (!feishuOpenId) return false;
    const result = await this.db
      .prepare(
        `UPDATE users
        SET feishu_open_id = ?, updated_at = ?
        WHERE user_id = ?
          AND (feishu_open_id IS NULL OR feishu_open_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM users AS bound_users
            WHERE bound_users.feishu_open_id = ?
              AND bound_users.user_id != users.user_id
          )`
      )
      .bind(feishuOpenId, this.now(), userId, feishuOpenId, feishuOpenId)
      .run();
    return result?.meta?.changes === 1;
  }

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
  }

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
  }

  async isPlatformAdmin({ environment, userId }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedUserId = normalizeRequiredString(userId);
    if (!normalizedEnvironment || !normalizedUserId) return false;
    const row = await this.db
      .prepare('SELECT user_id FROM platform_admins WHERE environment = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1')
      .bind(normalizedEnvironment, normalizedUserId)
      .first();
    return Boolean(row);
  }

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
  }

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
  }

  async createWebhookSubscription(input) {
    const now = this.now();
    const record = {
      id: input.id || randomStoreId('wh'),
      environment: normalizeRequiredString(input.environment),
      name: normalizeRequiredString(input.name),
      events: normalizeWebhookEvents(input.events),
      payloadMode: normalizeWebhookPayloadMode(input.payloadMode),
      restrictedTemplate: input.restrictedTemplate ?? null,
      encryptedUrlCiphertext: normalizeRequiredString(input.encryptedUrlCiphertext),
      urlSecretRef: null,
      urlHost: normalizeRequiredString(input.urlHost),
      urlMasked: normalizeRequiredString(input.urlMasked),
      urlFingerprint: normalizeRequiredString(input.urlFingerprint),
      enabled: input.enabled !== false,
      lastDeliveryStatus: input.lastDeliveryStatus || null,
      createdByUserId: normalizeRequiredString(input.createdByUserId),
      disabledAt: input.disabledAt || null,
      disabledByUserId: input.disabledByUserId || null,
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    };
    if (
      !record.environment ||
      !record.name ||
      record.events.length === 0 ||
      !record.payloadMode ||
      !record.encryptedUrlCiphertext ||
      !record.urlHost ||
      !record.urlMasked ||
      !record.urlFingerprint ||
      !record.createdByUserId
    ) {
      throw new Error('WEBHOOK_SUBSCRIPTION_INVALID');
    }
    await this.ensureWebhookUrlFingerprintAvailable(record.environment, record.urlFingerprint);

    await this.db
      .prepare(
        `INSERT INTO webhook_subscriptions (
          id, environment, name, events_json, payload_mode, restricted_template_json,
          encrypted_url_ciphertext, url_host, url_masked, url_fingerprint,
          enabled, last_delivery_status, created_by_user_id,
          disabled_at, disabled_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.name,
        stringifyJsonColumn(record.events),
        record.payloadMode,
        stringifyJsonColumn(record.restrictedTemplate),
        record.encryptedUrlCiphertext,
        record.urlHost,
        record.urlMasked,
        record.urlFingerprint,
        record.enabled ? 1 : 0,
        record.lastDeliveryStatus,
        record.createdByUserId,
        record.disabledAt,
        record.disabledByUserId,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(withoutWebhookSecret(record));
  }

  async getWebhookSubscription({ environment, id, includeSecret = false }) {
    const normalizedId = normalizeRequiredString(id);
    if (!normalizedId) return null;
    const normalizedEnvironment = normalizeRequiredString(environment);
    const row = await this.db
      .prepare(
        `SELECT * FROM webhook_subscriptions
        WHERE id = ?${normalizedEnvironment ? ' AND environment = ?' : ''}
        LIMIT 1`
      )
      .bind(...(normalizedEnvironment ? [normalizedId, normalizedEnvironment] : [normalizedId]))
      .first();
    return row ? mapWebhookSubscription(row, { includeSecret }) : null;
  }

  async listWebhookSubscriptions({ environment }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    if (!normalizedEnvironment) return [];
    const result = await this.db
      .prepare(
        `SELECT * FROM webhook_subscriptions
        WHERE environment = ?
        ORDER BY updated_at DESC, name ASC`
      )
      .bind(normalizedEnvironment)
      .all();
    return (result.results || []).map((row) => mapWebhookSubscription(row));
  }

  async updateWebhookSubscription({ environment, id, patch }) {
    const existing = await this.getWebhookSubscription({ environment, id, includeSecret: true });
    if (!existing) return null;
    const now = this.now();
    const next = {
      ...existing,
      ...normalizeWebhookSubscriptionPatch(patch),
      updatedAt: now,
    };
    if (patch?.enabled === false && existing.enabled) {
      next.disabledAt = now;
      next.disabledByUserId = patch.disabledByUserId || existing.disabledByUserId || null;
    }
    if (patch?.enabled === true) {
      next.disabledAt = null;
      next.disabledByUserId = null;
    }
    await this.ensureWebhookUrlFingerprintAvailable(environment, next.urlFingerprint, id);

    await this.db
      .prepare(
        `UPDATE webhook_subscriptions
        SET name = ?, events_json = ?, payload_mode = ?, restricted_template_json = ?,
          encrypted_url_ciphertext = ?, url_host = ?, url_masked = ?, url_fingerprint = ?,
          enabled = ?, last_delivery_status = ?, disabled_at = ?, disabled_by_user_id = ?, updated_at = ?
        WHERE id = ? AND environment = ?`
      )
      .bind(
        next.name,
        stringifyJsonColumn(next.events),
        next.payloadMode,
        stringifyJsonColumn(next.restrictedTemplate),
        next.encryptedUrlCiphertext,
        next.urlHost,
        next.urlMasked,
        next.urlFingerprint,
        next.enabled ? 1 : 0,
        next.lastDeliveryStatus,
        next.disabledAt,
        next.disabledByUserId,
        next.updatedAt,
        next.id,
        next.environment
      )
      .run();
    return this.getWebhookSubscription({ environment, id });
  }

  async ensureWebhookUrlFingerprintAvailable(environment, urlFingerprint, currentId = null) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedFingerprint = normalizeRequiredString(urlFingerprint);
    if (!normalizedEnvironment || !normalizedFingerprint) return;
    const row = await this.db
      .prepare(
        `SELECT id FROM webhook_subscriptions
        WHERE environment = ? AND url_fingerprint = ? ${currentId ? 'AND id != ?' : ''}
        LIMIT 1`
      )
      .bind(...(currentId ? [normalizedEnvironment, normalizedFingerprint, currentId] : [normalizedEnvironment, normalizedFingerprint]))
      .first();
    if (row) throw new Error('WEBHOOK_URL_CONFLICT');
  }

  async recordWebhookDelivery(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id || randomStoreId('whd'),
      environment: normalizeRequiredString(input.environment),
      subscriptionId: normalizeRequiredString(input.subscriptionId),
      eventType: normalizeRequiredString(input.eventType),
      deliveryStatus: input.deliveryStatus || 'pending',
      renderStatus: input.renderStatus || 'pending',
      payloadMode: normalizeWebhookPayloadMode(input.payloadMode || 'standard'),
      templateRevision: input.templateRevision ?? null,
      payloadHash: input.payloadHash || null,
      targetHost: normalizeRequiredString(input.targetHost),
      httpStatus: input.httpStatus ?? null,
      attemptCount: Number(input.attemptCount || 0),
      nextRetryAt: input.nextRetryAt || null,
      errorCode: input.errorCode || null,
      createdAt: now,
      updatedAt: input.updatedAt || now,
    };
    if (!record.environment || !record.subscriptionId || !record.eventType || !record.payloadMode || !record.targetHost) {
      throw new Error('WEBHOOK_DELIVERY_INVALID');
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries (
            id, environment, subscription_id, event_type, delivery_status, render_status,
            payload_mode, template_revision, payload_hash, target_host, http_status,
            attempt_count, next_retry_at, error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          record.id,
          record.environment,
          record.subscriptionId,
          record.eventType,
          record.deliveryStatus,
          record.renderStatus,
          record.payloadMode,
          record.templateRevision,
          record.payloadHash,
          record.targetHost,
          record.httpStatus,
          record.attemptCount,
          record.nextRetryAt,
          record.errorCode,
          record.createdAt,
          record.updatedAt
        ),
      this.db
        .prepare('UPDATE webhook_subscriptions SET last_delivery_status = ?, updated_at = ? WHERE id = ? AND environment = ?')
        .bind(record.deliveryStatus, record.updatedAt, record.subscriptionId, record.environment),
    ]);
    return cloneRecord(record);
  }

  async updateWebhookDelivery(id, patch) {
    const existing = await this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ? LIMIT 1').bind(id).first();
    if (!existing) return null;
    const current = mapWebhookDelivery(existing);
    const now = this.now();
    const next = {
      ...current,
      deliveryStatus: patch.deliveryStatus || current.deliveryStatus,
      renderStatus: patch.renderStatus || current.renderStatus,
      payloadHash: patch.payloadHash ?? current.payloadHash,
      httpStatus: patch.httpStatus ?? current.httpStatus,
      attemptCount: patch.attemptCount ?? current.attemptCount,
      nextRetryAt: patch.nextRetryAt ?? current.nextRetryAt,
      errorCode: patch.errorCode ?? current.errorCode,
      updatedAt: patch.updatedAt || now,
    };
    await this.db
      .prepare(
        `UPDATE webhook_deliveries
        SET delivery_status = ?, render_status = ?, payload_hash = ?, http_status = ?,
          attempt_count = ?, next_retry_at = ?, error_code = ?, updated_at = ?
        WHERE id = ?`
      )
      .bind(
        next.deliveryStatus,
        next.renderStatus,
        next.payloadHash,
        next.httpStatus,
        next.attemptCount,
        next.nextRetryAt,
        next.errorCode,
        next.updatedAt,
        id
      )
      .run();
    await this.db
      .prepare('UPDATE webhook_subscriptions SET last_delivery_status = ?, updated_at = ? WHERE id = ? AND environment = ?')
      .bind(next.deliveryStatus, next.updatedAt, next.subscriptionId, next.environment)
      .run();
    return cloneRecord(next);
  }

  async listWebhookDeliveries({ environment, subscriptionId }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedSubscriptionId = normalizeRequiredString(subscriptionId);
    if (!normalizedEnvironment) return [];
    const result = await this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
        WHERE environment = ?${normalizedSubscriptionId ? ' AND subscription_id = ?' : ''}
        ORDER BY created_at DESC
        LIMIT 100`
      )
      .bind(...(normalizedSubscriptionId ? [normalizedEnvironment, normalizedSubscriptionId] : [normalizedEnvironment]))
      .all();
    return (result.results || []).map(mapWebhookDelivery);
  }

  async getAdminDashboard({ environment }) {
    const [siteRow, userRow, teamRow, deploymentRow, failedDeploymentCountRow, failedDeploymentsResult] = await Promise.all([
      this.db
        .prepare('SELECT COUNT(*) AS count FROM sites WHERE environment = ? AND deleted_at IS NULL')
        .bind(environment)
        .first(),
      this.db.prepare('SELECT COUNT(*) AS count FROM users').first(),
      this.db
        .prepare("SELECT COUNT(*) AS count FROM teams WHERE environment = ? AND status = 'active' AND deleted_at IS NULL")
        .bind(environment)
        .first(),
      this.db.prepare('SELECT COUNT(*) AS count FROM deployments WHERE environment = ?').bind(environment).first(),
      this.db
        .prepare("SELECT COUNT(*) AS count FROM deployments WHERE environment = ? AND status = 'failed'")
        .bind(environment)
        .first(),
      this.db
        .prepare(
          `SELECT deployments.*,
            sites.slug AS site_slug,
            sites.owner_type AS site_owner_type,
            sites.owner_id AS site_owner_id,
            sites.owner_user_id AS site_owner_user_id,
            owner_users.email AS owner_user_email,
            owner_users.realname AS owner_user_realname,
            owner_teams.name AS owner_team_name,
            owner_teams.team_type AS owner_team_type,
            owner_teams.department_path AS owner_team_department_path
          FROM deployments
          LEFT JOIN sites
            ON sites.id = deployments.site_id
            AND sites.environment = deployments.environment
          LEFT JOIN users AS owner_users
            ON COALESCE(sites.owner_type, 'user') = 'user'
            AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
          LEFT JOIN teams AS owner_teams
            ON sites.owner_type = 'team'
            AND owner_teams.id = sites.owner_id
            AND owner_teams.environment = deployments.environment
            AND owner_teams.deleted_at IS NULL
          WHERE deployments.environment = ? AND deployments.status = 'failed'
          ORDER BY deployments.created_at DESC
          LIMIT 10`
        )
        .bind(environment)
        .all(),
    ]);

    return {
      environment,
      counts: {
        sites: Number(siteRow?.count || 0),
        users: Number(userRow?.count || 0),
        teams: Number(teamRow?.count || 0),
        deployments: Number(deploymentRow?.count || 0),
        failedDeployments: Number(failedDeploymentCountRow?.count || 0),
      },
      failedDeployments: (failedDeploymentsResult.results || []).map(mapAdminDeploymentWithOwner),
    };
  }

  async listAdminUsers({ environment, query, limit = 50 }) {
    const normalizedQuery = normalizeNullableString(query);
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const queryCondition = normalizedQuery
      ? `AND (LOWER(COALESCE(users.realname, '')) LIKE ?
          OR LOWER(COALESCE(users.email, '')) LIKE ?
          OR LOWER(COALESCE(users.account, '')) LIKE ?
          OR LOWER(users.user_id) LIKE ?)`
      : '';
    const binds = [environment];
    if (normalizedQuery) {
      const like = `%${normalizedQuery.toLowerCase()}%`;
      binds.push(like, like, like, like);
    }
    binds.push(normalizedLimit);
    const sql = `SELECT users.*, platform_admins.user_id AS platform_admin_user_id
        FROM users
        LEFT JOIN platform_admins
          ON platform_admins.user_id = users.user_id
          AND platform_admins.environment = ?
          AND platform_admins.revoked_at IS NULL
        WHERE 1 = 1 ${queryCondition}
        ORDER BY users.email ASC
        LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(...binds)
      .all();
    return (result.results || []).map((row) => ({
      ...mapUser(row),
      isPlatformAdmin: Boolean(row.platform_admin_user_id),
    }));
  }

  async listConsoleUsers({ query, limit = 20 } = {}) {
    const normalizedQuery = normalizeNullableString(query);
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const conditions = ["COALESCE(employee_status, 'unknown') IN ('active', 'unknown')"];
    const binds = [];
    if (normalizedQuery) {
      const like = `%${normalizedQuery.toLowerCase()}%`;
      conditions.push(
        `(LOWER(COALESCE(realname, '')) LIKE ?
          OR LOWER(COALESCE(email, '')) LIKE ?
          OR LOWER(COALESCE(account, '')) LIKE ?
          OR LOWER(user_id) LIKE ?)`
      );
      binds.push(like, like, like, like);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM users
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(realname, email, user_id) ASC
        LIMIT ?`
      )
      .bind(...binds, normalizedLimit)
      .all();
    return (result.results || []).map(mapUser);
  }

  async listAdminSites({ environment, limit = 200 }) {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    const result = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
          owner_users.email AS owner_user_email, owner_users.realname AS owner_user_realname,
          owner_teams.name AS owner_team_name, owner_teams.team_type AS owner_team_type,
          owner_teams.department_path AS owner_team_department_path
        FROM sites
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        LEFT JOIN users AS owner_users
          ON COALESCE(sites.owner_type, 'user') = 'user'
          AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
        LEFT JOIN teams AS owner_teams
          ON sites.owner_type = 'team'
          AND owner_teams.id = sites.owner_id
          AND owner_teams.deleted_at IS NULL
        WHERE sites.environment = ? AND sites.deleted_at IS NULL
        ORDER BY sites.updated_at DESC
        LIMIT ?`
      )
      .bind(environment, normalizedLimit)
      .all();
    return (result.results || []).map(mapAdminSiteWithOwner);
  }

  async getAdminSiteById(siteId, environment) {
    const row = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
          owner_users.email AS owner_user_email, owner_users.realname AS owner_user_realname,
          owner_teams.name AS owner_team_name, owner_teams.team_type AS owner_team_type,
          owner_teams.department_path AS owner_team_department_path
        FROM sites
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        LEFT JOIN users AS owner_users
          ON COALESCE(sites.owner_type, 'user') = 'user'
          AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
        LEFT JOIN teams AS owner_teams
          ON sites.owner_type = 'team'
          AND owner_teams.id = sites.owner_id
          AND owner_teams.deleted_at IS NULL
        WHERE sites.id = ? AND sites.environment = ? AND sites.deleted_at IS NULL`
      )
      .bind(siteId, environment)
      .first();
    return row ? mapAdminSiteWithOwner(row) : null;
  }

  async listAdminSiteDeployments({ environment, siteId, limit = 100 }) {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const result = await this.db
      .prepare(
        `SELECT deployments.*,
          sites.slug AS site_slug,
          sites.owner_type AS site_owner_type,
          sites.owner_id AS site_owner_id,
          sites.owner_user_id AS site_owner_user_id,
          owner_users.email AS owner_user_email,
          owner_users.realname AS owner_user_realname,
          owner_teams.name AS owner_team_name,
          owner_teams.team_type AS owner_team_type,
          owner_teams.department_path AS owner_team_department_path
        FROM deployments
        LEFT JOIN sites
          ON sites.id = deployments.site_id
          AND sites.environment = deployments.environment
        LEFT JOIN users AS owner_users
          ON COALESCE(sites.owner_type, 'user') = 'user'
          AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
        LEFT JOIN teams AS owner_teams
          ON sites.owner_type = 'team'
          AND owner_teams.id = sites.owner_id
          AND owner_teams.environment = deployments.environment
          AND owner_teams.deleted_at IS NULL
        WHERE deployments.environment = ? AND deployments.site_id = ?
        ORDER BY deployments.created_at DESC
        LIMIT ?`
      )
      .bind(environment, siteId, normalizedLimit)
      .all();
    return (result.results || []).map(mapAdminDeploymentWithOwner);
  }

  async listAdminTeams({ environment, teamType, status, limit = 200 } = {}) {
    const conditions = ['environment = ?', 'deleted_at IS NULL'];
    const binds = [environment];
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    if (teamType) {
      conditions.push('team_type = ?');
      binds.push(teamType);
    }
    if (status) {
      conditions.push('status = ?');
      binds.push(status);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM teams
        WHERE ${conditions.join(' AND ')}
        ORDER BY name ASC
        LIMIT ?`
      )
      .bind(...binds, normalizedLimit)
      .all();
    return (result.results || []).map(mapTeam);
  }

  async previewDepartmentTeamMerge({ sourceTeamId, targetTeamId, environment }) {
    const source = await this.getTeamForDepartmentMerge(sourceTeamId, environment);
    const target = await this.getTeamForDepartmentMerge(targetTeamId, environment);
    assertDepartmentMergeTeams(source, target);
    return {
      sourceTeam: source,
      targetTeam: target,
      counts: await this.countDepartmentTeamMergeAssets(source.id),
    };
  }

  async mergeDepartmentTeams({ sourceTeamId, targetTeamId, actorUserId, reason, environment }) {
    const source = await this.getTeamForDepartmentMerge(sourceTeamId, environment);
    const target = await this.getTeamForDepartmentMerge(targetTeamId, environment);
    assertDepartmentMergeTeams(source, target);

    const now = this.now();
    const counts = await this.countDepartmentTeamMergeAssets(source.id);
    const sourceMembers = await this.db
      .prepare(
        `SELECT * FROM team_members
        WHERE team_id = ? AND membership_source = 'department_auto' AND removed_at IS NULL
        ORDER BY user_id ASC`
      )
      .bind(source.id)
      .all();

    const statements = [
      this.db
        .prepare(
          "UPDATE sites SET owner_id = ?, updated_at = ? WHERE owner_type = 'team' AND owner_id = ? AND deleted_at IS NULL"
        )
        .bind(target.id, now, source.id),
      this.db
        .prepare(
          `UPDATE access_keys
          SET owner_id = ?
          WHERE owner_type = 'team' AND owner_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`
        )
        .bind(target.id, source.id, now),
    ];

    for (const member of sourceMembers.results || []) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO team_members (
              team_id, user_id, role, membership_source, department_path, role_overridden_at,
              removed_at, removed_by_user_id, restored_at, restored_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, 'department_auto', ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
          )
          .bind(
            target.id,
            member.user_id,
            member.role,
            member.department_path || target.departmentPath,
            member.role_overridden_at || null,
            member.created_at,
            now
          ),
        this.db
          .prepare(
            `UPDATE team_members
            SET role = ?, department_path = ?, role_overridden_at = ?,
              restored_at = CASE WHEN removed_at IS NOT NULL THEN ? ELSE restored_at END,
              restored_by_user_id = CASE WHEN removed_at IS NOT NULL THEN ? ELSE restored_by_user_id END,
              removed_at = NULL, removed_by_user_id = NULL, updated_at = ?
            WHERE team_id = ? AND user_id = ? AND membership_source = 'department_auto'`
          )
          .bind(
            member.role,
            member.department_path || target.departmentPath,
            member.role_overridden_at || null,
            now,
            actorUserId,
            now,
            target.id,
            member.user_id
          ),
        this.db
          .prepare(
            `UPDATE team_members
            SET removed_at = ?, removed_by_user_id = ?, updated_at = ?
            WHERE team_id = ? AND user_id = ? AND membership_source = 'department_auto' AND removed_at IS NULL`
          )
          .bind(now, actorUserId, now, source.id, member.user_id)
      );
    }

    statements.push(
      this.db
        .prepare(
          `UPDATE teams
          SET status = 'merged', merged_into_team_id = ?, merged_at = ?,
            merged_by_user_id = ?, merge_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND deleted_at IS NULL`
        )
        .bind(target.id, now, actorUserId, normalizeNullableString(reason), now, source.id),
      this.auditEventStatement({
        id: randomStoreId('audit'),
        environment: source.environment,
        traceId: null,
        eventType: 'admin.department_team.merge',
        actorUserId,
        actorType: String(actorUserId || '').startsWith('system:') ? 'system' : 'user',
        siteId: null,
        routeId: null,
        versionId: null,
        decision: 'allow',
        statusCode: 200,
        ipHash: null,
        userAgentHash: null,
        metadata: {
          sourceTeamId: source.id,
          targetTeamId: target.id,
          counts,
        },
        createdAt: now,
      })
    );

    await this.db.batch(statements);
    return {
      sourceTeam: await this.getTeamForDepartmentMerge(source.id, environment),
      targetTeam: target,
      counts,
    };
  }

  async getTeamForDepartmentMerge(teamId, environment) {
    const row = environment
      ? await this.db
          .prepare('SELECT * FROM teams WHERE id = ? AND environment = ? AND deleted_at IS NULL')
          .bind(teamId, environment)
          .first()
      : await this.db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').bind(teamId).first();
    return row ? mapTeam(row) : null;
  }

  async countDepartmentTeamMergeAssets(sourceTeamId) {
    const now = this.now();
    const [siteRow, accessKeyRow, memberRow] = await Promise.all([
      this.db
        .prepare("SELECT COUNT(*) AS count FROM sites WHERE owner_type = 'team' AND owner_id = ? AND deleted_at IS NULL")
        .bind(sourceTeamId)
        .first(),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM access_keys
          WHERE owner_type = 'team' AND owner_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`
        )
        .bind(sourceTeamId, now)
        .first(),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM team_members
          WHERE team_id = ? AND membership_source = 'department_auto' AND removed_at IS NULL`
        )
        .bind(sourceTeamId)
        .first(),
    ]);
    return {
      sites: Number(siteRow?.count || 0),
      accessKeys: Number(accessKeyRow?.count || 0),
      departmentMembers: Number(memberRow?.count || 0),
    };
  }

  async listAuditEvents({ environment } = {}) {
    const result = environment
      ? await this.db
          .prepare(
            `SELECT audit_events.*, actor_users.email AS actor_email, actor_users.realname AS actor_realname
            FROM audit_events
            LEFT JOIN users actor_users ON actor_users.user_id = audit_events.actor_user_id
            WHERE audit_events.environment = ?
            ORDER BY audit_events.created_at DESC
            LIMIT 100`
          )
          .bind(environment)
          .all()
      : await this.db
          .prepare(
            `SELECT audit_events.*, actor_users.email AS actor_email, actor_users.realname AS actor_realname
            FROM audit_events
            LEFT JOIN users actor_users ON actor_users.user_id = audit_events.actor_user_id
            ORDER BY audit_events.created_at DESC
            LIMIT 100`
          )
          .all();
    return (result.results || []).map(mapAuditEvent);
  }

  async updateUserDepartmentFromDirectory({ userId, departmentPath, departmentCheckedAt }) {
    const normalizedPath = normalizeDepartmentPath(departmentPath) || null;
    const checkedAt = departmentCheckedAt || this.now();
    await this.db
      .prepare(
        `UPDATE users
        SET department_path = ?, department_checked_at = ?, updated_at = ?
        WHERE user_id = ?`
      )
      .bind(normalizedPath, checkedAt, checkedAt, userId)
      .run();
    return this.getUser(userId);
  }

  async findOrCreateDepartmentTeam({ environment, departmentPath, createdAt }) {
    const identity = deriveDepartmentTeamIdentity(departmentPath);
    const normalizedPath = identity.teamPath;
    if (!normalizedPath) throw new Error('DEPARTMENT_PATH_REQUIRED');
    let target = await this.findDepartmentTeam(environment, normalizedPath);
    if (target) {
      await this.mergeLegacyDepartmentTeamIfNeeded({ environment, fullPath: identity.fullPath, target });
      return this.getTeam(target.id);
    }
    const deterministicId = departmentTeamId(environment, normalizedPath);
    const existingById = await this.getTeam(deterministicId);
    if (existingById?.mergedIntoTeamId) {
      target = await this.getTeam(existingById.mergedIntoTeamId);
      if (target && target.environment === environment && target.status === 'active' && !target.deletedAt) {
        await this.mergeLegacyDepartmentTeamIfNeeded({ environment, fullPath: identity.fullPath, target });
        return target;
      }
    }

    const now = createdAt || this.now();
    const team = {
      id: deterministicId,
      environment,
      name: identity.teamPath !== identity.fullPath && identity.displayName ? identity.displayName : normalizedPath,
      description: null,
      teamType: 'department',
      departmentPath: normalizedPath,
      status: 'active',
      createdByType: 'system',
      createdByUserId: null,
      mergedIntoTeamId: null,
      mergedAt: null,
      mergedByUserId: null,
      mergeReason: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO teams (
            id, environment, name, description, team_type, department_path, status,
            created_by_type, created_by_user_id, merged_into_team_id, merged_at, merged_by_user_id,
            merge_reason, deleted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          team.id,
          team.environment,
          team.name,
          team.description,
          team.teamType,
          team.departmentPath,
          team.status,
          team.createdByType,
          team.createdByUserId,
          team.mergedIntoTeamId,
          team.mergedAt,
          team.mergedByUserId,
          team.mergeReason,
          team.deletedAt,
          team.createdAt,
          team.updatedAt
      ),
      this.auditEventStatement(departmentTeamAuditEvent(team, 'system.department_team.create', now)),
    ]);
    const inserted = await this.getTeam(team.id);
    if (inserted?.mergedIntoTeamId) {
      const target = await this.getTeam(inserted.mergedIntoTeamId);
      if (target && target.environment === environment && target.status === 'active' && !target.deletedAt) return target;
    }
    target = inserted || (await this.findDepartmentTeam(environment, normalizedPath));
    if (!target) return target;
    await this.mergeLegacyDepartmentTeamIfNeeded({ environment, fullPath: identity.fullPath, target });
    return this.getTeam(target.id);
  }

  async findDepartmentTeam(environment, departmentPath) {
    const row = await this.db
      .prepare(
        `SELECT * FROM teams
        WHERE environment = ? AND team_type = 'department' AND department_path = ?
          AND status = 'active' AND deleted_at IS NULL
        LIMIT 1`
      )
      .bind(environment, departmentPath)
      .first();
    return row ? mapTeam(row) : null;
  }

  async mergeLegacyDepartmentTeamIfNeeded({ environment, fullPath, target }) {
    const legacyPath = normalizeDepartmentPath(fullPath);
    if (!legacyPath || legacyPath === target.departmentPath) return;
    const legacy = await this.findDepartmentTeam(environment, legacyPath);
    if (!legacy || legacy.id === target.id) return;
    await this.mergeDepartmentTeams({
      sourceTeamId: legacy.id,
      targetTeamId: target.id,
      actorUserId: 'system:xds',
      reason: 'department canonicalized',
      environment,
    });
  }

  async hydrateDepartmentMembership({ environment, userId, departmentPath }) {
    const membershipDepartmentPath = normalizeDepartmentPath(departmentPath);
    if (!membershipDepartmentPath) return { team: null, member: null, restored: false };
    const now = this.now();
    const team = await this.findOrCreateDepartmentTeam({ environment, departmentPath: membershipDepartmentPath, createdAt: now });
    const migratedFrom = await this.db
      .prepare(
        `SELECT team_id, department_path FROM team_members
        WHERE user_id = ? AND membership_source = 'department_auto'
          AND removed_at IS NULL
          AND team_id != ?
          AND team_id IN (
            SELECT id FROM teams
            WHERE environment = ? AND team_type = 'department' AND status = 'active' AND deleted_at IS NULL
          )
        ORDER BY team_id ASC`
      )
      .bind(userId, team.id, environment)
      .all();
    await this.db
      .prepare(
        `UPDATE team_members
        SET removed_at = ?, removed_by_user_id = 'system:xds', updated_at = ?
        WHERE user_id = ? AND membership_source = 'department_auto'
          AND removed_at IS NULL
          AND team_id != ?
          AND team_id IN (
            SELECT id FROM teams
            WHERE environment = ? AND team_type = 'department' AND status = 'active' AND deleted_at IS NULL
          )`
      )
      .bind(now, now, userId, team.id, environment)
      .run();

    const existing = await this.getTeamMember({ teamId: team.id, userId, includeRemoved: true });
    if (existing) {
      const shouldRestore = Boolean(existing.removedAt && existing.removedByUserId === 'system:xds');
      if (shouldRestore) {
        await this.db
          .prepare(
            `UPDATE team_members
            SET department_path = ?, removed_at = NULL, removed_by_user_id = NULL,
              restored_at = ?, restored_by_user_id = 'system:xds', updated_at = ?
            WHERE team_id = ? AND user_id = ?`
          )
          .bind(membershipDepartmentPath, now, now, team.id, userId)
          .run();
      } else {
        await this.db
          .prepare('UPDATE team_members SET department_path = ?, updated_at = ? WHERE team_id = ? AND user_id = ?')
          .bind(membershipDepartmentPath, now, team.id, userId)
          .run();
      }
      await this.recordDepartmentMigrations({
        environment,
        userId,
        migratedFrom: migratedFrom.results || [],
        targetTeam: team,
        departmentPath: membershipDepartmentPath,
        now,
      });
      return {
        team,
        member: await this.getTeamMember({ teamId: team.id, userId, includeRemoved: true }),
        restored: shouldRestore,
      };
    }

    await this.db
      .prepare(
        `INSERT INTO team_members (
          team_id, user_id, role, membership_source, department_path, role_overridden_at,
          removed_at, removed_by_user_id, restored_at, restored_by_user_id, created_at, updated_at
        ) VALUES (?, ?, 'admin', 'department_auto', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      )
      .bind(team.id, userId, membershipDepartmentPath, now, now)
      .run();
    await this.recordAuditEvent(
      departmentMembershipAuditEvent(
        { environment, userId, teamId: team.id, departmentPath: membershipDepartmentPath },
        'system.department_membership.join',
        now
      )
    );
    await this.recordDepartmentMigrations({
      environment,
      userId,
      migratedFrom: migratedFrom.results || [],
      targetTeam: team,
      departmentPath: membershipDepartmentPath,
      now,
    });
    return {
      team,
      member: await this.getTeamMember({ teamId: team.id, userId }),
      restored: true,
    };
  }

  async recordDepartmentMigrations({ environment, userId, migratedFrom, targetTeam, departmentPath, now }) {
    for (const source of migratedFrom) {
      await this.recordAuditEvent(
        departmentMembershipMigrationAuditEvent(
          {
            environment,
            userId,
            oldTeamId: source.team_id || source.teamId,
            newTeamId: targetTeam.id,
            oldDepartmentPath: source.department_path || source.departmentPath,
            newDepartmentPath: departmentPath,
          },
          now
        )
      );
    }
  }

  async createTeam(input) {
    const now = input.createdAt || this.now();
    const teamType = input.teamType || 'custom';
    if (teamType === 'department') {
      return this.findOrCreateDepartmentTeam({
        environment: input.environment,
        departmentPath: input.departmentPath || input.name,
        createdAt: now,
      });
    }
    const team = {
      id: input.id || randomStoreId('team'),
      environment: input.environment,
      name: normalizeTeamName(input.name),
      description: normalizeNullableString(input.description),
      teamType,
      departmentPath: null,
      status: 'active',
      createdByType: input.createdByType || (input.createdByUserId ? 'user' : 'system'),
      createdByUserId: input.createdByUserId || null,
      mergedIntoTeamId: null,
      mergedAt: null,
      mergedByUserId: null,
      mergeReason: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (!team.name) throw new Error('TEAM_NAME_REQUIRED');
    const statements = [
      this.db
        .prepare(
          `INSERT INTO teams (
            id, environment, name, description, team_type, department_path, status,
            created_by_type, created_by_user_id, merged_into_team_id, merged_at, merged_by_user_id,
            merge_reason, deleted_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          team.id,
          team.environment,
          team.name,
          team.description,
          team.teamType,
          team.departmentPath,
          team.status,
          team.createdByType,
          team.createdByUserId,
          team.mergedIntoTeamId,
          team.mergedAt,
          team.mergedByUserId,
          team.mergeReason,
          team.deletedAt,
          team.createdAt,
          team.updatedAt
        ),
    ];
    if (input.createdByUserId) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO team_members (
              team_id, user_id, role, membership_source, department_path, role_overridden_at,
              removed_at, removed_by_user_id, restored_at, restored_by_user_id, created_at, updated_at
            ) VALUES (?, ?, 'admin', 'manual', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
          )
          .bind(team.id, input.createdByUserId, now, now)
      );
    }
    await this.db.batch(statements);
    return this.getTeam(team.id);
  }

  async getTeam(teamId) {
    const row = await this.db
      .prepare("SELECT * FROM teams WHERE id = ? AND status = 'active' AND deleted_at IS NULL")
      .bind(teamId)
      .first();
    return row ? mapTeam(row) : null;
  }

  async addTeamMember(input) {
    const team = await this.getTeam(input.teamId);
    if (!team) throw new Error('TEAM_NOT_FOUND');
    const now = input.createdAt || this.now();
    const role = normalizeTeamRole(input.role);
    const existing = await this.getTeamMember({ teamId: input.teamId, userId: input.userId, includeRemoved: true });
    const membershipSource =
      existing?.membershipSource === 'department_auto' && input.membershipSource === 'manual'
        ? existing.membershipSource
        : input.membershipSource || existing?.membershipSource || 'manual';
    const departmentPath = input.departmentPath || existing?.departmentPath || null;
    const roleOverriddenAt =
      existing?.membershipSource === 'department_auto' && existing.role !== role
        ? input.roleOverriddenAt || now
        : existing?.roleOverriddenAt || null;
    const restoredAt = existing?.removedAt ? now : existing?.restoredAt || null;
    const restoredByUserId = existing?.removedAt ? input.actorUserId || null : existing?.restoredByUserId || null;
    await this.db
      .prepare(
        `INSERT INTO team_members (
          team_id, user_id, role, membership_source, department_path, role_overridden_at,
          removed_at, removed_by_user_id, restored_at, restored_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(team_id, user_id) DO UPDATE SET
          role = excluded.role,
          membership_source = excluded.membership_source,
          department_path = excluded.department_path,
          role_overridden_at = excluded.role_overridden_at,
          removed_at = NULL,
          removed_by_user_id = NULL,
          restored_at = excluded.restored_at,
          restored_by_user_id = excluded.restored_by_user_id,
          updated_at = excluded.updated_at`
      )
      .bind(
        input.teamId,
        input.userId,
        role,
        membershipSource,
        departmentPath,
        roleOverriddenAt,
        restoredAt,
        restoredByUserId,
        existing?.createdAt || now,
        now
      )
      .run();
    return this.getTeamMember({ teamId: input.teamId, userId: input.userId });
  }

  async removeTeamMember({ teamId, userId, actorUserId }) {
    const now = this.now();
    const result = await this.db
      .prepare('UPDATE team_members SET removed_at = ?, removed_by_user_id = ?, updated_at = ? WHERE team_id = ? AND user_id = ?')
      .bind(now, actorUserId || null, now, teamId, userId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getTeamMember({ teamId, userId, includeRemoved: true });
  }

  async restoreTeamMember({ teamId, userId, actorUserId }) {
    const now = this.now();
    const result = await this.db
      .prepare(
        `UPDATE team_members
        SET removed_at = NULL, removed_by_user_id = NULL, restored_at = ?, restored_by_user_id = ?, updated_at = ?
        WHERE team_id = ? AND user_id = ?`
      )
      .bind(now, actorUserId || null, now, teamId, userId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getTeamMember({ teamId, userId });
  }

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
  }

  async listTeamMembers({ teamId, includeRemoved = false } = {}) {
    const result = await this.db
      .prepare(
        `SELECT team_members.*,
          users.user_id AS joined_user_id, users.email AS user_email, users.realname AS user_realname,
          users.account AS user_account, users.employee_status AS user_employee_status,
          users.department_path AS user_department_path
        FROM team_members
        LEFT JOIN users ON users.user_id = team_members.user_id
        WHERE team_members.team_id = ?${includeRemoved ? '' : ' AND team_members.removed_at IS NULL'}
        ORDER BY COALESCE(users.realname, users.email, team_members.user_id) ASC`
      )
      .bind(teamId)
      .all();
    return (result.results || []).map(mapTeamMember);
  }

  async listTeamsForUser({ environment, userId } = {}) {
    const result = await this.db
      .prepare(
        `SELECT teams.*, team_members.role AS current_user_role,
          team_members.membership_source AS current_user_membership_source,
          COALESCE(site_counts.site_count, 0) AS site_count,
          COALESCE(member_counts.member_count, 0) AS member_count
        FROM teams
        JOIN team_members ON team_members.team_id = teams.id
        LEFT JOIN (
          SELECT environment, owner_id AS team_id, COUNT(*) AS site_count
          FROM sites
          WHERE owner_type = 'team' AND deleted_at IS NULL
          GROUP BY environment, owner_id
        ) AS site_counts
          ON site_counts.team_id = teams.id
          AND site_counts.environment = teams.environment
        LEFT JOIN (
          SELECT team_id, COUNT(*) AS member_count
          FROM team_members
          WHERE removed_at IS NULL
          GROUP BY team_id
        ) AS member_counts ON member_counts.team_id = teams.id
        WHERE team_members.user_id = ? AND team_members.removed_at IS NULL
          AND teams.status = 'active' AND teams.deleted_at IS NULL
          ${environment ? 'AND teams.environment = ?' : ''}
        ORDER BY teams.name ASC`
      )
      .bind(...(environment ? [userId, environment] : [userId]))
      .all();
    return (result.results || []).map(mapTeamWithCurrentMember);
  }

  async updateTeamSettings({ teamId, name, description }) {
    const team = await this.getTeam(teamId);
    if (!team || team.teamType !== 'custom') return null;
    const now = this.now();
    const normalizedName = normalizeTeamName(name);
    await this.db
      .prepare('UPDATE teams SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .bind(normalizedName || team.name, normalizeNullableString(description), now, teamId)
      .run();
    return this.getTeam(teamId);
  }

  async countTeamBlockingAssets({ teamId }) {
    const now = this.now();
    const siteRow = await this.db
      .prepare("SELECT COUNT(*) AS count FROM sites WHERE owner_type = 'team' AND owner_id = ? AND deleted_at IS NULL")
      .bind(teamId)
      .first();
    const accessKeyRow = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM access_keys
        WHERE owner_type = 'team' AND owner_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`
      )
      .bind(teamId, now)
      .first();
    return {
      sites: Number(siteRow?.count || 0),
      accessKeys: Number(accessKeyRow?.count || 0),
    };
  }

  async deleteCustomTeam({ teamId, actorUserId }) {
    const team = await this.getTeam(teamId);
    if (!team) return null;
    if (team.teamType !== 'custom') throw new Error('DEPARTMENT_TEAM_DELETE_FORBIDDEN');
    const blocking = await this.countTeamBlockingAssets({ teamId });
    if (blocking.sites > 0 || blocking.accessKeys > 0) throw new Error('TEAM_HAS_BLOCKING_ASSETS');
    await this.db.batch([
      this.db.prepare('DELETE FROM team_members WHERE team_id = ?').bind(teamId),
      this.db.prepare('DELETE FROM teams WHERE id = ?').bind(teamId),
      this.auditEventStatement(teamDeleteAuditEvent(team, blocking, actorUserId, this.now())),
    ]);
    return team;
  }

  async createSite(input) {
    const now = this.now();
    if (await this.findSiteBySlug(input.environment, input.slug)) throw new Error('SITE_SLUG_CONFLICT');

    const site = {
      id: input.id,
      slug: input.slug,
      environment: input.environment,
      ownerType: input.ownerType || 'user',
      ownerId: input.ownerId || input.ownerUserId,
      ownerUserId: input.ownerUserId,
      defaultVisibility: input.defaultVisibility,
      executionModeOverride: input.executionModeOverride || null,
      siteUuid: input.siteUuid,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const route = createInitialRoute(input, now);
    const member = createOwnerMember(input.id, input.ownerUserId, now);
    const hostnameClaim = createHostnameClaim(
      {
        environment: input.environment,
        hostname: input.hostname,
        normalizedSlug: input.slug,
        hostnameFamily: hostnameFamilyForHostname(input.hostname),
        ownerSystem: 'v2',
        ownerId: input.id,
        ownerRef: input.routeId,
        source: 'v2_create',
      },
      now
    );
    const existingHostnameClaim = await this.getHostnameClaim(hostnameClaim.hostname);
    let hostnameClaimStatement;
    const hostnameClaimGuardStatement = this.createHostnameClaimGuardStatement(hostnameClaim);
    if (existingHostnameClaim) {
      if (!['released', 'held'].includes(existingHostnameClaim.status)) throw new Error('HOSTNAME_CLAIM_CONFLICT');
      if (existingHostnameClaim.reuseHoldUntil && existingHostnameClaim.reuseHoldUntil > now) {
        throw new Error('HOSTNAME_CLAIM_CONFLICT');
      }
      if (await this.findConflictingHostnameClaim({ ...hostnameClaim, excludeHostname: hostnameClaim.hostname })) {
        throw new Error('HOSTNAME_CLAIM_CONFLICT');
      }
      hostnameClaimStatement = this.db
        .prepare(
          `UPDATE hostname_claims
          SET environment = ?, normalized_slug = ?, hostname_family = ?, owner_system = ?, owner_id = ?,
            owner_ref = ?, status = ?, source = ?, acquired_at = ?, lease_expires_at = ?,
            released_at = NULL, reuse_hold_until = ?, release_reason = NULL, updated_at = ?
          WHERE hostname = ?
            AND status IN ('released', 'held')
            AND (reuse_hold_until IS NULL OR reuse_hold_until <= ?)
            AND NOT EXISTS (
              SELECT 1 FROM hostname_claims
              WHERE environment = ?
                AND normalized_slug = ?
                AND (
                  status IN ('pending', 'active', 'conflicted')
                  OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                )
                AND hostname != ?
            )`
        )
        .bind(
          hostnameClaim.environment,
          hostnameClaim.normalizedSlug,
          hostnameClaim.hostnameFamily,
          hostnameClaim.ownerSystem,
          hostnameClaim.ownerId,
          hostnameClaim.ownerRef,
          hostnameClaim.status,
          hostnameClaim.source,
          hostnameClaim.acquiredAt,
          hostnameClaim.leaseExpiresAt,
          hostnameClaim.reuseHoldUntil,
          hostnameClaim.updatedAt,
          hostnameClaim.hostname,
          now,
          hostnameClaim.environment,
          hostnameClaim.normalizedSlug,
          now,
          hostnameClaim.hostname
        );
    } else {
      if (await this.findConflictingHostnameClaim(hostnameClaim)) throw new Error('HOSTNAME_CLAIM_CONFLICT');
      hostnameClaimStatement = this.db
        .prepare(
          `INSERT INTO hostname_claims (
              id, environment, hostname, normalized_slug, hostname_family, owner_system, owner_id,
              owner_ref, status, source, acquired_at, lease_expires_at, released_at, reuse_hold_until,
              release_reason, created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM hostname_claims
              WHERE environment = ?
                AND normalized_slug = ?
                AND (
                  status IN ('pending', 'active', 'conflicted')
                  OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                )
                AND hostname != ?
            )`
        )
        .bind(
          hostnameClaim.id,
          hostnameClaim.environment,
          hostnameClaim.hostname,
          hostnameClaim.normalizedSlug,
          hostnameClaim.hostnameFamily,
          hostnameClaim.ownerSystem,
          hostnameClaim.ownerId,
          hostnameClaim.ownerRef,
          hostnameClaim.status,
          hostnameClaim.source,
          hostnameClaim.acquiredAt,
          hostnameClaim.leaseExpiresAt,
          hostnameClaim.releasedAt,
          hostnameClaim.reuseHoldUntil,
          hostnameClaim.releaseReason,
          hostnameClaim.createdAt,
          hostnameClaim.updatedAt,
          hostnameClaim.environment,
          hostnameClaim.normalizedSlug,
          now,
          hostnameClaim.hostname
        );
    }

    try {
      await this.db.batch([
        hostnameClaimStatement,
        hostnameClaimGuardStatement,
        this.db
          .prepare(
            `INSERT INTO sites (
              id, slug, environment, owner_type, owner_id, owner_user_id, default_visibility, execution_mode_override, site_uuid,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            site.id,
            site.slug,
            site.environment,
            site.ownerType,
            site.ownerId,
            site.ownerUserId,
            site.defaultVisibility,
            site.executionModeOverride,
            site.siteUuid,
            site.createdAt,
            site.updatedAt,
            site.deletedAt
          ),
        this.db
          .prepare(
            `INSERT INTO site_routes (
              id, hostname, site_id, environment, runtime, execution_provider, worker_name,
              dispatch_type, dispatch_binding_name, slot_id,
              active_version_id, visibility, policy_version, route_generation,
              runtime_config_generation, runtime_config_lock_id, route_status, cache_tier, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            route.id,
            route.hostname,
            route.siteId,
            route.environment,
            route.runtime,
            route.executionProvider,
            route.workerName,
            route.dispatchType,
            route.dispatchBindingName,
            route.slotId,
            route.activeVersionId,
            route.visibility,
            route.policyVersion,
            route.routeGeneration,
            route.runtimeConfigGeneration,
            null,
            route.routeStatus,
            route.cacheTier,
            route.createdAt,
            route.updatedAt
          ),
        this.db
          .prepare(
            `INSERT INTO site_members (
              site_id, user_id, role, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?)`
          )
          .bind(member.siteId, member.userId, member.role, member.createdBy, member.createdAt),
      ]);
    } catch (error) {
      if (!isSqliteConstraintError(error)) throw error;
      if (await this.findSiteBySlug(input.environment, input.slug)) throw new Error('SITE_SLUG_CONFLICT');
      throw new Error('HOSTNAME_CLAIM_CONFLICT');
    }

    return cloneRecord(site);
  }

  createHostnameClaimGuardStatement(claim) {
    return this.db
      .prepare(
        `INSERT INTO hostname_claims (id, environment)
        SELECT ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM hostname_claims
          WHERE hostname = ? AND owner_system = ? AND owner_id = ? AND status = ?
        )`
      )
      .bind(`claim_guard_${claim.id}`, claim.hostname, claim.ownerSystem, claim.ownerId, claim.status);
  }

  async getHostnameClaim(hostname) {
    const row = await this.db.prepare('SELECT * FROM hostname_claims WHERE hostname = ?').bind(hostname).first();
    return row ? mapHostnameClaim(row) : null;
  }

  async findConflictingHostnameClaim(input) {
    const now = input.now || this.now();
    const row = await this.db
      .prepare(
        `SELECT * FROM hostname_claims
        WHERE environment = ?
          AND normalized_slug = ?
          AND (
            status IN ('pending', 'active', 'conflicted')
            OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
          )
          AND hostname != ?
        LIMIT 1`
      )
      .bind(input.environment, input.normalizedSlug, now, input.excludeHostname || '')
      .first();
    return row ? mapHostnameClaim(row) : null;
  }

  async getHostnameClaimForOwner(input) {
    const now = input.now || this.now();
    const row = await this.db
      .prepare(
        `SELECT * FROM hostname_claims
        WHERE environment = ? AND normalized_slug = ? AND owner_system = ? AND owner_id = ?
          AND (
            status IN ('pending', 'active', 'conflicted')
            OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
          )
        LIMIT 1`
      )
      .bind(input.environment, input.normalizedSlug, input.ownerSystem, input.ownerId, now)
      .first();
    return row ? mapHostnameClaim(row) : null;
  }

  async acquireHostnameClaim(input) {
    const now = input.acquiredAt || this.now();
    const existing = await this.getHostnameClaim(input.hostname);
    if (existing) {
      if (existing.status === 'released' || existing.status === 'held') {
        const revived = await this.reacquireReleasedHostnameClaim(input, now);
        if (revived) return { ok: true, claim: revived };
        return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: existing };
      }
      if (hostnameClaimOwnerMatches(existing, input) && existing.status !== 'conflicted') return { ok: true, claim: existing };
      return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: existing };
    }
    const existingOwnerClaim = await this.getHostnameClaimForOwner(input);
    if (existingOwnerClaim) {
      if (existingOwnerClaim.hostname === String(input.hostname || '').toLowerCase()) {
        return { ok: true, claim: existingOwnerClaim };
      }
      return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: existingOwnerClaim };
    }
    const conflicting = await this.findConflictingHostnameClaim(input);
    if (conflicting) return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: conflicting };

    const claim = createHostnameClaim(input, now);
    try {
      const result = await this.insertHostnameClaim(claim, now);
      if (result?.meta?.changes === 0) {
        return {
          ok: false,
          code: 'HOSTNAME_CLAIM_CONFLICT',
          claim: await this.findConflictingHostnameClaim(claim),
        };
      }
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        return {
          ok: false,
          code: 'HOSTNAME_CLAIM_CONFLICT',
          claim: (await this.getHostnameClaim(claim.hostname)) || (await this.findConflictingHostnameClaim(claim)),
        };
      }
      throw error;
    }
    return { ok: true, claim };
  }

  async reacquireReleasedHostnameClaim(input, now) {
    const claim = createHostnameClaim(input, now);
    const conflicting = await this.findConflictingHostnameClaim({
      ...claim,
      ownerSystem: '__reacquire__',
      ownerId: claim.id,
      excludeHostname: claim.hostname,
    });
    if (conflicting) return null;
    try {
      const result = await this.db
        .prepare(
          `UPDATE hostname_claims
          SET environment = ?, normalized_slug = ?, hostname_family = ?, owner_system = ?, owner_id = ?,
            owner_ref = ?, status = ?, source = ?, acquired_at = ?, lease_expires_at = ?,
            released_at = NULL, reuse_hold_until = ?, release_reason = NULL, updated_at = ?
          WHERE hostname = ?
            AND status IN ('released', 'held')
            AND (reuse_hold_until IS NULL OR reuse_hold_until <= ?)
            AND NOT EXISTS (
              SELECT 1 FROM hostname_claims
              WHERE environment = ?
                AND normalized_slug = ?
                AND (
                  status IN ('pending', 'active', 'conflicted')
                  OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
                )
                AND hostname != ?
            )`
        )
        .bind(
          claim.environment,
          claim.normalizedSlug,
          claim.hostnameFamily,
          claim.ownerSystem,
          claim.ownerId,
          claim.ownerRef,
          claim.status,
          claim.source,
          claim.acquiredAt,
          claim.leaseExpiresAt,
          claim.reuseHoldUntil,
          claim.updatedAt,
          claim.hostname,
          now,
          claim.environment,
          claim.normalizedSlug,
          now,
          claim.hostname
        )
        .run();
      if (result?.meta?.changes === 0) return null;
      return this.getHostnameClaim(claim.hostname);
    } catch (error) {
      if (isSqliteConstraintError(error)) return null;
      throw error;
    }
  }

  async confirmHostnameClaim(input) {
    const now = input.confirmedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE hostname_claims
        SET status = 'active', lease_expires_at = NULL, updated_at = ?
        WHERE hostname = ? AND owner_system = ? AND owner_id = ?
          AND status IN ('pending', 'active')`
      )
      .bind(now, String(input.hostname || '').toLowerCase(), input.ownerSystem, input.ownerId)
      .run();
    if (result?.meta?.changes === 0) return { ok: false, code: 'HOSTNAME_CLAIM_NOT_FOUND' };
    return { ok: true, claim: await this.getHostnameClaim(input.hostname) };
  }

  async releaseHostnameClaim(input) {
    const now = input.releasedAt || this.now();
    const targetStatus = input.reuseHoldUntil ? 'held' : 'released';
    const allowedStatuses = input.reuseHoldUntil ? ['pending', 'active', 'held'] : ['pending'];
    const result = await this.db
      .prepare(
        `UPDATE hostname_claims
        SET status = ?, released_at = ?, reuse_hold_until = ?, release_reason = ?, updated_at = ?
        WHERE hostname = ? AND owner_system = ? AND owner_id = ?
          AND status IN (${allowedStatuses.map(() => '?').join(', ')})`
      )
      .bind(
        targetStatus,
        now,
        input.reuseHoldUntil || null,
        input.releaseReason || null,
        now,
        String(input.hostname || '').toLowerCase(),
        input.ownerSystem,
        input.ownerId,
        ...allowedStatuses
      )
      .run();
    if (result?.meta?.changes === 0) return { ok: false, code: 'HOSTNAME_CLAIM_NOT_FOUND' };
    return { ok: true, claim: await this.getHostnameClaim(input.hostname) };
  }

  async deleteSite(siteId, { deletedAt, reuseHoldUntil, releaseReason = 'site_deleted' } = {}, environment) {
    const site = await this.getSite(siteId);
    const route = await this.getRouteBySiteId(siteId, environment);
    if (!site || site.deletedAt || !route) return null;
    if (environment && site.environment !== environment) return null;
    const now = deletedAt || this.now();
    await this.db.batch([
      this.db
        .prepare(`UPDATE sites SET deleted_at = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, now, siteId, environment] : [now, now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET route_status = 'deleted', runtime = 'disabled', active_version_id = NULL,
            worker_name = NULL, dispatch_type = NULL, dispatch_binding_name = NULL, slot_id = NULL,
            route_generation = route_generation + 1, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE hostname_claims
          SET status = 'held', released_at = ?, reuse_hold_until = ?, release_reason = ?, updated_at = ?
          WHERE hostname = ? AND owner_system = 'v2' AND owner_id = ?
            AND status IN ('pending', 'active', 'held')`
        )
        .bind(now, reuseHoldUntil || null, releaseReason, now, route.hostname, siteId),
    ]);
    return this.getSite(siteId);
  }

  async transferSiteOwner(siteId, { ownerType, ownerId, ownerUserId, defaultVisibility, updatedAt, auditEvent }, environment) {
    const site = await this.getSite(siteId);
    if (!site || site.deletedAt) return null;
    if (environment && site.environment !== environment) return null;

    const nextOwnerType = ownerType || 'user';
    const now = updatedAt || this.now();
    const nextDefaultVisibility = defaultVisibility || site.defaultVisibility;
    const statements = [
      this.db
        .prepare(
          `UPDATE sites
          SET owner_type = ?, owner_id = ?, owner_user_id = ?, default_visibility = ?, updated_at = ?
          WHERE id = ?${environment ? ' AND environment = ?' : ''} AND deleted_at IS NULL`
        )
        .bind(
          ...(environment
            ? [nextOwnerType, ownerId, ownerUserId, nextDefaultVisibility, now, siteId, environment]
            : [nextOwnerType, ownerId, ownerUserId, nextDefaultVisibility, now, siteId])
        ),
    ];

    if (nextOwnerType === 'user') {
      statements.push(
        this.db.prepare('DELETE FROM site_members WHERE site_id = ? AND user_id != ?').bind(siteId, ownerUserId),
        this.db
          .prepare(
            `INSERT INTO site_members (site_id, user_id, role, created_by, created_at)
            VALUES (?, ?, 'owner', ?, ?)
            ON CONFLICT(site_id, user_id) DO UPDATE SET role = 'owner'`
          )
          .bind(siteId, ownerUserId, ownerUserId, now)
      );
    }
    if (auditEvent) statements.push(this.auditEventStatement(auditEvent));

    await this.db.batch(statements);
    return this.getSite(siteId);
  }

  async insertHostnameClaim(claim, now = claim.acquiredAt || this.now()) {
    return this.db
      .prepare(
        `INSERT INTO hostname_claims (
          id, environment, hostname, normalized_slug, hostname_family, owner_system, owner_id,
          owner_ref, status, source, acquired_at, lease_expires_at, released_at, reuse_hold_until,
          release_reason, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM hostname_claims
          WHERE environment = ?
            AND normalized_slug = ?
            AND (
              status IN ('pending', 'active', 'conflicted')
              OR (status = 'held' AND (reuse_hold_until IS NULL OR reuse_hold_until > ?))
            )
            AND hostname != ?
        )`
      )
      .bind(
        claim.id,
        claim.environment,
        claim.hostname,
        claim.normalizedSlug,
        claim.hostnameFamily,
        claim.ownerSystem,
        claim.ownerId,
        claim.ownerRef,
        claim.status,
        claim.source,
        claim.acquiredAt,
        claim.leaseExpiresAt,
        claim.releasedAt,
        claim.reuseHoldUntil,
        claim.releaseReason,
        claim.createdAt,
        claim.updatedAt,
        claim.environment,
        claim.normalizedSlug,
        now,
        claim.hostname
      )
      .run();
  }

  async findSiteBySlug(environment, slug) {
    const row = await this.db
      .prepare('SELECT * FROM sites WHERE environment = ? AND slug = ? AND deleted_at IS NULL')
      .bind(environment, slug)
      .first();
    return row ? mapSite(row) : null;
  }

  async getSite(id) {
    const row = await this.db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
    return row ? mapSite(row) : null;
  }

  async getSiteWithRoute(siteId, environment) {
    const row = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
        FROM sites
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE sites.id = ? AND sites.deleted_at IS NULL
          ${environment ? 'AND sites.environment = ?' : ''}`
      )
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .first();
    return row ? mapSiteWithJoinedRoute(row) : null;
  }

  async listSitesForUser(userId, actor = {}, environment) {
    if (actor.type === 'access_key') {
      const ownerType = actor.ownerType || 'user';
      const binds = [];
      const legacySiteScopedActor = actor.siteId && !actor.ownerType && !actor.ownerId && !actor.userId;
      const ownerWhere = legacySiteScopedActor
        ? '1 = 1'
        : ownerType === 'team'
          ? `(sites.owner_type = 'team' AND sites.owner_id = ?)`
          : `(
              (COALESCE(sites.owner_type, 'user') = 'user' AND COALESCE(sites.owner_id, sites.owner_user_id) = ?)
              OR EXISTS (
                SELECT 1 FROM team_members
                WHERE team_members.team_id = sites.owner_id
                  AND team_members.user_id = ?
                  AND team_members.removed_at IS NULL
              )
            )`;
      if (legacySiteScopedActor) {
        // Site-scoped access key actors created by older tests/callers carry only siteId.
      } else if (ownerType === 'team') {
        binds.push(actor.ownerId);
      } else {
        const ownerUserId = actor.ownerId || actor.userId;
        binds.push(ownerUserId, ownerUserId);
      }
      if (environment) binds.push(environment);
      if (actor.siteId) binds.push(actor.siteId);

      const result = await this.db
        .prepare(
          `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
            site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
            site_routes.execution_provider AS route_execution_provider,
            site_routes.dispatch_type AS route_dispatch_type,
            site_routes.dispatch_binding_name AS route_dispatch_binding_name,
            site_routes.slot_id AS route_slot_id,
            site_routes.active_version_id AS route_active_version_id,
            site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
            site_routes.route_generation AS route_route_generation,
            site_routes.runtime_config_generation AS route_runtime_config_generation,
            site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at
          FROM sites
          LEFT JOIN site_routes ON site_routes.site_id = sites.id
          WHERE ${ownerWhere}
            AND sites.deleted_at IS NULL
            ${environment ? 'AND sites.environment = ?' : ''}
            ${actor.siteId ? 'AND sites.id = ?' : ''}
          ORDER BY sites.created_at DESC`
        )
        .bind(...binds)
        .all();
      return (result.results || []).map(mapSiteWithJoinedRoute);
    }

    const query = `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
          team_members.role AS management_role
        FROM sites
        LEFT JOIN site_members ON site_members.site_id = sites.id
          AND site_members.user_id = ?
        LEFT JOIN team_members ON team_members.team_id = sites.owner_id
          AND team_members.user_id = ? AND team_members.removed_at IS NULL
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE sites.deleted_at IS NULL
          AND (
            (COALESCE(sites.owner_type, 'user') = 'user' AND site_members.user_id IS NOT NULL)
            OR (sites.owner_type = 'team' AND team_members.user_id IS NOT NULL)
          )
          ${environment ? 'AND sites.environment = ?' : ''}
        ORDER BY sites.created_at DESC`;
    const binds = [userId, userId];
    if (environment) binds.push(environment);
    const result = await this.db
      .prepare(query)
      .bind(...binds)
      .all();
    return (result.results || []).map(mapSiteWithJoinedRoute);
  }

  async getSiteForUser(siteId, userId, actor = {}, environment) {
    if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return null;
    const accessKeyActor = actor.type === 'access_key';
    if (accessKeyActor) {
      const site = await this.getSiteWithRoute(siteId, environment);
      if (!site || site.deletedAt) return null;
      if (!(await this.accessKeyCanSeeSite(actor, site))) return null;
      return this.decorateAccessKeySite(actor, site);
    }

    const row = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
          team_members.role AS management_role
        FROM sites
        LEFT JOIN site_members ON site_members.site_id = sites.id AND site_members.user_id = ?
        LEFT JOIN team_members ON team_members.team_id = sites.owner_id
          AND team_members.user_id = ? AND team_members.removed_at IS NULL
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE sites.id = ? AND sites.deleted_at IS NULL
          AND (
            (site_members.user_id IS NOT NULL AND COALESCE(sites.owner_type, 'user') = 'user')
            OR (sites.owner_type = 'team' AND team_members.user_id IS NOT NULL)
          )` +
          (environment ? ' AND sites.environment = ?' : '')
      )
      .bind(...(environment ? [userId, userId, siteId, environment] : [userId, userId, siteId]))
      .first();
    return row ? mapSiteWithJoinedRoute(row) : null;
  }

  async accessKeyCanSeeSite(actor, site) {
    if (actor.siteId && !actor.ownerType && !actor.ownerId && !actor.userId) return actor.siteId === site.id;
    const ownerType = actor.ownerType || 'user';
    if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === actor.ownerId;
    const ownerUserId = actor.ownerId || actor.userId;
    if ((site.ownerType || 'user') === 'user') return (site.ownerId || site.ownerUserId) === ownerUserId;
    if (site.ownerType === 'team') {
      const member = await this.getTeamMember({ teamId: site.ownerId, userId: ownerUserId });
      return Boolean(member);
    }
    return false;
  }

  async decorateAccessKeySite(actor, site) {
    if ((actor.ownerType || 'user') !== 'user' || site.ownerType !== 'team') return site;
    const member = await this.getTeamMember({ teamId: site.ownerId, userId: actor.ownerId || actor.userId });
    return {
      ...site,
      managementRole: member?.role || null,
    };
  }

  async listConsoleDirectorySites({ environment, viewerUserId } = {}) {
    const result = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
          owner_users.realname AS owner_user_realname, owner_users.email AS owner_user_email,
          teams.id AS owner_team_id, teams.name AS owner_team_name, teams.team_type AS owner_team_type,
          teams.department_path AS owner_team_department_path
        FROM sites
        JOIN site_routes ON site_routes.id = (
          SELECT route.id
          FROM site_routes AS route
          WHERE route.site_id = sites.id
            AND route.environment = sites.environment
            AND route.route_status = 'active'
          ORDER BY route.updated_at DESC, route.id DESC
          LIMIT 1
        )
        LEFT JOIN users AS owner_users
          ON COALESCE(sites.owner_type, 'user') = 'user'
          AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
        LEFT JOIN teams
          ON sites.owner_type = 'team'
          AND teams.id = sites.owner_id
          AND teams.deleted_at IS NULL
        WHERE sites.deleted_at IS NULL
          ${environment ? 'AND sites.environment = ?' : ''}
          AND COALESCE(site_routes.visibility, sites.default_visibility) = 'internal'
        ORDER BY sites.slug ASC`
      )
      .bind(...(environment ? [environment] : []))
      .all();
    const sitesById = new Map(
      (result.results || []).map((row) => {
        const site = mapConsoleDirectorySite(row);
        return [site.id, site];
      })
    );
    if (viewerUserId) {
      const accessibleResult = await this.db
        .prepare(
          `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
            site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
            site_routes.execution_provider AS route_execution_provider,
            site_routes.dispatch_type AS route_dispatch_type,
            site_routes.dispatch_binding_name AS route_dispatch_binding_name,
            site_routes.slot_id AS route_slot_id,
            site_routes.active_version_id AS route_active_version_id,
            site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
            site_routes.route_generation AS route_route_generation,
            site_routes.runtime_config_generation AS route_runtime_config_generation,
            site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
            site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
            owner_users.realname AS owner_user_realname, owner_users.email AS owner_user_email,
            teams.id AS owner_team_id, teams.name AS owner_team_name, teams.team_type AS owner_team_type,
            teams.department_path AS owner_team_department_path
          FROM sites
          JOIN users AS viewer_users
            ON viewer_users.user_id = ?
            AND viewer_users.employee_status = 'active'
          JOIN site_routes ON site_routes.id = (
            SELECT route.id
            FROM site_routes AS route
            WHERE route.site_id = sites.id
              AND route.environment = sites.environment
              AND route.route_status = 'active'
            ORDER BY route.updated_at DESC, route.id DESC
            LIMIT 1
          )
          LEFT JOIN users AS owner_users
            ON COALESCE(sites.owner_type, 'user') = 'user'
            AND owner_users.user_id = COALESCE(sites.owner_id, sites.owner_user_id)
          LEFT JOIN teams
            ON sites.owner_type = 'team'
            AND teams.id = sites.owner_id
            AND teams.deleted_at IS NULL
          WHERE sites.deleted_at IS NULL
            ${environment ? 'AND sites.environment = ?' : ''}
            AND (
              COALESCE(site_routes.visibility, sites.default_visibility) = 'org'
              OR (
                COALESCE(site_routes.visibility, sites.default_visibility) = 'acl'
                AND EXISTS (
                  SELECT 1 FROM site_acl_entries
                  WHERE site_acl_entries.site_id = sites.id
                    AND site_acl_entries.effect = 'allow'
                    AND (
                      (
                        site_acl_entries.subject_type = 'email'
                        AND trim(site_acl_entries.subject_value) <> ''
                        AND trim(COALESCE(viewer_users.email, '')) <> ''
                        AND lower(trim(site_acl_entries.subject_value)) = lower(trim(COALESCE(viewer_users.email, '')))
                      )
                      OR (
                        site_acl_entries.subject_type = 'department'
                        AND viewer_users.department_path IS NOT NULL
                        AND (
                          viewer_users.department_path = site_acl_entries.subject_value
                          OR substr(viewer_users.department_path, 1, length(site_acl_entries.subject_value) + 1) =
                            site_acl_entries.subject_value || '/'
                        )
                      )
                    )
                )
              )
            )
          ORDER BY sites.slug ASC`
        )
        .bind(...(environment ? [viewerUserId, environment] : [viewerUserId]))
        .all();
      for (const row of accessibleResult.results || []) {
        const site = mapConsoleDirectorySite(row);
        sitesById.set(site.id, site);
      }
      for (const site of await this.listSitesForUser(viewerUserId, { type: 'user', userId: viewerUserId }, environment)) {
        if ((site.ownerType || 'user') !== 'user') continue;
        sitesById.set(site.id, await this.decorateConsoleSiteOwner(site));
      }
      for (const site of await this.listTeamOwnedSitesForUser({ environment, userId: viewerUserId })) {
        sitesById.set(site.id, site);
      }
    }
    return [...sitesById.values()].sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async listWorkspaceSites({ environment, userId, ownerFilter, teamId } = {}) {
    if (ownerFilter === 'team') return this.listTeamOwnedSitesForUser({ environment, userId, teamId });
    const sites = await this.listSitesForUser(userId, { type: 'user', userId }, environment);
    const personalSites = sites.filter((site) => {
      return (site.ownerType || 'user') === 'user' && (site.ownerId || site.ownerUserId) === userId;
    });
    return Promise.all(personalSites.map((site) => this.decorateConsoleSiteOwner(site)));
  }

  async decorateConsoleSiteOwner(site) {
    if (!site) return site;
    if ((site.ownerType || 'user') === 'team') {
      const team = await this.getTeam(site.ownerId);
      return {
        ...site,
        ownerDisplayName: team ? departmentTeamDisplayName(team) : null,
        ownerTeamType: team?.teamType || null,
        ownerTeamId: team?.id || null,
      };
    }
    const user = await this.getUser(site.ownerId || site.ownerUserId);
    return {
      ...site,
      ownerDisplayName: user?.realname || user?.email || null,
    };
  }

  async listTeamOwnedSitesForUser({ environment, userId, teamId } = {}) {
    const result = await this.db
      .prepare(
        `SELECT sites.*, site_routes.id AS route_id, site_routes.hostname AS route_hostname,
          site_routes.runtime AS route_runtime, site_routes.worker_name AS route_worker_name,
          site_routes.execution_provider AS route_execution_provider,
          site_routes.dispatch_type AS route_dispatch_type,
          site_routes.dispatch_binding_name AS route_dispatch_binding_name,
          site_routes.slot_id AS route_slot_id,
          site_routes.active_version_id AS route_active_version_id,
          site_routes.visibility AS route_visibility, site_routes.policy_version AS route_policy_version,
          site_routes.route_generation AS route_route_generation,
          site_routes.runtime_config_generation AS route_runtime_config_generation,
          site_routes.route_status AS route_route_status, site_routes.cache_tier AS route_cache_tier,
          site_routes.created_at AS route_created_at, site_routes.updated_at AS route_updated_at,
          teams.id AS owner_team_id, teams.name AS owner_team_name, teams.team_type AS owner_team_type,
          teams.department_path AS owner_team_department_path,
          team_members.role AS management_role
        FROM sites
        JOIN teams ON teams.id = sites.owner_id AND sites.owner_type = 'team'
        JOIN team_members ON team_members.team_id = teams.id AND team_members.user_id = ? AND team_members.removed_at IS NULL
        LEFT JOIN site_routes ON site_routes.site_id = sites.id
        WHERE sites.deleted_at IS NULL
          AND teams.status = 'active' AND teams.deleted_at IS NULL
          ${environment ? 'AND sites.environment = ? AND teams.environment = ?' : ''}
          ${teamId ? 'AND teams.id = ?' : ''}
        ORDER BY sites.created_at DESC`
      )
      .bind(...[userId, ...(environment ? [environment, environment] : []), ...(teamId ? [teamId] : [])])
      .all();
    return (result.results || []).map(mapConsoleTeamSite);
  }

  async getConsoleSiteDetail({ environment, userId, siteId } = {}) {
    const site = await this.getSiteWithRoute(siteId, environment);
    if (!site) return null;
    if ((site.ownerType || 'user') === 'team') {
      const team = await this.getTeam(site.ownerId);
      if (!team || (environment && team.environment !== environment)) return null;
      const member = await this.getTeamMember({ teamId: team.id, userId });
      if (!member) return null;
      return {
        ...site,
        ownerType: 'team',
        ownerDisplayName: departmentTeamDisplayName(team),
        ownerTeamType: team.teamType,
        ownerTeamId: team.id,
        currentUserId: userId,
        managementRole: member.role,
      };
    }
    if ((site.ownerId || site.ownerUserId) !== userId) return null;
    const ownerUser = await this.getUser(site.ownerId || site.ownerUserId);
    return {
      ...site,
      ownerType: 'user',
      ownerDisplayName: ownerUser?.realname || ownerUser?.email || null,
      currentUserId: userId,
      managementRole: 'admin',
    };
  }

  async listConsoleSiteDeployments({ environment, userId, siteId } = {}) {
    const site = await this.getConsoleSiteDetail({ environment, userId, siteId });
    if (!site) return [];

    const result = await this.db
      .prepare(
        `SELECT deployments.*
        FROM deployments
        WHERE deployments.site_id = ?
          ${environment ? 'AND deployments.environment = ?' : ''}
        ORDER BY deployments.created_at DESC
        LIMIT 100`
      )
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .all();
    return (result.results || []).map(mapDeployment);
  }

  async listSiteMembers(siteId) {
    const result = await this.db.prepare('SELECT * FROM site_members WHERE site_id = ?').bind(siteId).all();
    return (result.results || []).map(mapSiteMember);
  }

  async listSiteAclEntries(siteId) {
    const result = await this.db
      .prepare('SELECT * FROM site_acl_entries WHERE site_id = ? ORDER BY created_at ASC, id ASC')
      .bind(siteId)
      .all();
    return (result.results || []).map(mapSiteAclEntry);
  }

  async getRouteBySiteId(siteId, environment) {
    const row = await this.db
      .prepare('SELECT * FROM site_routes WHERE site_id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [siteId, environment] : [siteId]))
      .first();
    return row ? mapSiteRoute(row) : null;
  }

  async updateSiteVisibility(siteId, { visibility, updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return null;
    const now = updatedAt || this.now();
    const cacheTier = cacheTierForVisibility(visibility);
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE sites SET default_visibility = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [visibility, now, siteId, environment] : [visibility, now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET visibility = ?, policy_version = policy_version + 1,
            cache_tier = ?, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [visibility, cacheTier, now, siteId, environment] : [visibility, cacheTier, now, siteId])),
    ]);
    return this.getRouteBySiteId(siteId, environment);
  }

  async restoreSiteVisibility(siteId, previousSite, previousRoute, environment) {
    return this.restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, null, environment);
  }

  async restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, expectedRoute, environment) {
    if (!previousRoute) return null;
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (expectedRoute && !routesMatchIgnoringRuntimeConfigGeneration(currentRoute, expectedRoute)) {
      return currentRoute;
    }
    await this.db
      .prepare(`UPDATE sites SET default_visibility = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
      .bind(
        ...(environment
          ? [previousSite.defaultVisibility, previousSite.updatedAt, siteId, environment]
          : [previousSite.defaultVisibility, previousSite.updatedAt, siteId])
      )
      .run();
    return this.restoreSiteRoute(siteId, routeWithLatestRuntimeConfig(previousRoute, currentRoute), environment);
  }

  async replaceSiteAclEntries(siteId, entries, { createdBy, updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return [];
    const now = updatedAt || this.now();
    const statements = [
      this.db.prepare('DELETE FROM site_acl_entries WHERE site_id = ?').bind(siteId),
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET policy_version = policy_version + 1, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
    ];
    for (const entry of entries) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO site_acl_entries (
              id, site_id, subject_type, subject_value, access_role,
              effect, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(entry.id, siteId, entry.subjectType, entry.subjectValue, entry.accessRole, entry.effect, createdBy, now)
      );
    }
    await this.db.batch(statements);
    return this.listSiteAclEntries(siteId);
  }

  async addSiteAclEntries(siteId, entries, { createdBy, updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return [];
    const existing = await this.listSiteAclEntries(siteId);
    const existingKeys = new Set(existing.map(siteAclEntryKey));
    const entriesToInsert = entries.filter((entry) => !existingKeys.has(siteAclEntryKey(entry)));
    if (entriesToInsert.length === 0) return existing;

    const now = updatedAt || this.now();
    const statements = [
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET policy_version = policy_version + 1, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
    ];
    for (const entry of entriesToInsert) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO site_acl_entries (
              id, site_id, subject_type, subject_value, access_role,
              effect, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(entry.id, siteId, entry.subjectType, entry.subjectValue, entry.accessRole, entry.effect, createdBy, now)
      );
    }
    await this.db.batch(statements);
    return this.listSiteAclEntries(siteId);
  }

  async removeSiteAclEntries(siteId, entries, { updatedAt }, environment) {
    if (!(await this.getRouteBySiteId(siteId, environment))) return [];
    const existing = await this.listSiteAclEntries(siteId);
    const removedKeys = new Set(entries.map(siteAclEntryKey));
    if (existing.every((entry) => !removedKeys.has(siteAclEntryKey(entry)))) return existing;

    const now = updatedAt || this.now();
    const conditions = entries
      .map(() => '(subject_type = ? AND subject_value = ? AND access_role = ? AND effect = ?)')
      .join(' OR ');
    const deleteBinds = entries.flatMap((entry) => [entry.subjectType, entry.subjectValue, entry.accessRole, entry.effect]);
    await this.db.batch([
      this.db.prepare(`DELETE FROM site_acl_entries WHERE site_id = ? AND (${conditions})`).bind(siteId, ...deleteBinds),
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
      this.db
        .prepare(
          `UPDATE site_routes
          SET policy_version = policy_version + 1, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(...(environment ? [now, siteId, environment] : [now, siteId])),
    ]);
    return this.listSiteAclEntries(siteId);
  }

  async restoreSiteAclEntries(siteId, previousEntries, previousRoute, previousSite, environment) {
    return this.restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, null, environment);
  }

  async restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, expectedRoute, environment) {
    if (!previousRoute) return [];
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (expectedRoute && !routesMatchIgnoringRuntimeConfigGeneration(currentRoute, expectedRoute)) {
      return this.listSiteAclEntries(siteId);
    }
    const statements = [
      this.db.prepare('DELETE FROM site_acl_entries WHERE site_id = ?').bind(siteId),
      this.db
        .prepare(`UPDATE sites SET updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(...(environment ? [previousSite.updatedAt, siteId, environment] : [previousSite.updatedAt, siteId])),
    ];
    for (const entry of previousEntries) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO site_acl_entries (
              id, site_id, subject_type, subject_value, access_role,
              effect, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            entry.id,
            siteId,
            entry.subjectType,
            entry.subjectValue,
            entry.accessRole,
            entry.effect,
            entry.createdBy,
            entry.createdAt
          )
      );
    }
    await this.db.batch(statements);
    await this.restoreSiteRoute(siteId, routeWithLatestRuntimeConfig(previousRoute, currentRoute), environment);
    return this.listSiteAclEntries(siteId);
  }

  async createSiteVersion(input) {
    const now = this.now();
    const record = {
      id: input.id,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      workerName: input.workerName,
      runtime: input.runtime,
      executionProvider: input.executionProvider || executionProviderFromRuntime(input.runtime),
      dispatchType: input.dispatchType || dispatchTypeFromExecutionProvider(input.executionProvider),
      dispatchBindingName: input.dispatchBindingName || null,
      slotId: input.slotId || null,
      artifactRef: input.artifactRef,
      contentHash: input.contentHash,
      deploymentShape: input.deploymentShape,
      requestedFallback: input.requestedFallback,
      resolvedFallback: input.resolvedFallback || null,
      routingMode: input.routingMode,
      workerEntry: input.workerEntry || null,
      assetsConfigJson: input.assetsConfigJson ?? null,
      workerModulesJson: input.workerModulesJson ?? null,
      assetManifestJson: input.assetManifestJson ?? null,
      canonicalContentHash: input.canonicalContentHash || input.contentHash,
      varNamesJson: input.varNamesJson ?? null,
      secretNamesJson: input.secretNamesJson ?? null,
      runtimeConfigSnapshotJson: input.runtimeConfigSnapshotJson ?? null,
      artifactAvailability: input.artifactAvailability || 'active',
      createdBy: input.createdBy,
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO site_versions (
          id, site_id, deployment_id, worker_name, runtime, execution_provider,
          dispatch_type, dispatch_binding_name, slot_id,
          artifact_ref, content_hash, deployment_shape, requested_fallback,
          resolved_fallback, routing_mode, worker_entry, assets_config_json,
          worker_modules_json, asset_manifest_json, canonical_content_hash,
          var_names_json, secret_names_json, runtime_config_snapshot_json,
          artifact_availability, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.siteId,
        record.deploymentId,
        record.workerName,
        record.runtime,
        record.executionProvider,
        record.dispatchType,
        record.dispatchBindingName,
        record.slotId,
        record.artifactRef,
        record.contentHash,
        record.deploymentShape,
        record.requestedFallback,
        record.resolvedFallback,
        record.routingMode,
        record.workerEntry,
        stringifyJsonColumn(record.assetsConfigJson),
        stringifyJsonColumn(record.workerModulesJson),
        stringifyJsonColumn(record.assetManifestJson),
        record.canonicalContentHash,
        stringifyJsonColumn(record.varNamesJson),
        stringifyJsonColumn(record.secretNamesJson),
        stringifyJsonColumn(record.runtimeConfigSnapshotJson),
        record.artifactAvailability,
        record.createdBy,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  }

  async putSiteSecret(input) {
    const now = input.updatedAt || this.now();
    const encryptedValue = await encryptSiteSecretValue(input.value, this.secretEncryptionKey);
    const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
    const revision = (await this.nextSiteSecretRevision(input.environment, input.siteId, input.name)) + 1;
    const id = existing?.id || input.id;
    if (existing) {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE site_secrets
            SET encrypted_value = ?, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ? AND deleted_at IS NULL`
          )
          .bind(encryptedValue, revision, now, existing.id, Number(existing.revision || 0)),
        this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
          secretId: id,
          revision,
          encryptedValue,
        }),
      ]);
      if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
        throw new Error('SITE_SECRET_REVISION_CONFLICT');
      }
    } else {
      const results = await this.db.batch([
        this.siteSecretInsertStatement({
          id,
          environment: input.environment,
          siteId: input.siteId,
          name: input.name,
          encryptedValue,
          revision,
          createdBy: input.actorId || input.createdBy,
          createdAt: now,
          updatedAt: now,
        }),
        this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
          secretId: id,
          revision,
          encryptedValue,
        }),
      ]);
      if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
        throw new Error('SITE_SECRET_REVISION_CONFLICT');
      }
    }
    return {
      id,
      environment: input.environment,
      siteId: input.siteId,
      name: input.name,
      value: input.value,
      revision,
      createdBy: input.actorId || input.createdBy,
      createdAt: existing?.created_at || now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  async putSiteSecretWithAudit(input) {
    const now = input.updatedAt || this.now();
    const encryptedValue = await encryptSiteSecretValue(input.value, this.secretEncryptionKey);
    const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
    const revision = (await this.nextSiteSecretRevision(input.environment, input.siteId, input.name)) + 1;
    const id = existing?.id || input.id;
    const secretStatement = existing
      ? this.db
          .prepare(
            `UPDATE site_secrets
            SET encrypted_value = ?, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ? AND deleted_at IS NULL`
          )
          .bind(encryptedValue, revision, now, existing.id, Number(existing.revision || 0))
      : this.siteSecretInsertStatement({
          id,
          environment: input.environment,
          siteId: input.siteId,
          name: input.name,
          encryptedValue,
          revision,
          createdBy: input.actorId || input.createdBy,
          createdAt: now,
          updatedAt: now,
        });
    const auditRecord = secretAuditEvent(input, 'site_secret.put', { name: input.name, revision }, now);
    const auditStatement = this.siteSecretPutAuditEventStatement(auditRecord, {
      secretId: id,
      revision,
      encryptedValue,
      updatedAt: now,
    });
    const results = await this.db.batch([
      secretStatement,
      this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
        secretId: id,
        revision,
        encryptedValue,
      }),
      auditStatement,
    ]);
    if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1 || results?.[2]?.meta?.changes !== 1) {
      throw new Error('SITE_SECRET_REVISION_CONFLICT');
    }
    return {
      id,
      environment: input.environment,
      siteId: input.siteId,
      name: input.name,
      value: input.value,
      revision,
      createdBy: input.actorId || input.createdBy,
      createdAt: existing?.created_at || now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  async getLiveSiteSecretRow(environment, siteId, name) {
    return this.db
      .prepare(
        `SELECT * FROM site_secrets
        WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL`
      )
      .bind(environment, siteId, name)
      .first();
  }

  async nextSiteSecretRevision(environment, siteId, name) {
    const row = await this.db
      .prepare(
        `SELECT MAX(revision) AS max_revision FROM site_secrets
        WHERE environment = ? AND site_id = ? AND name = ?`
      )
      .bind(environment, siteId, name)
      .first();
    return Number(row?.max_revision || 0);
  }

  siteSecretInsertStatement({ id, environment, siteId, name, encryptedValue, revision, createdBy, createdAt, updatedAt }) {
    return this.db
      .prepare(
        `INSERT INTO site_secrets (
          id, environment, site_id, name, encrypted_value, revision,
          created_by, created_at, updated_at, deleted_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM site_secrets
          WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL
        )`
      )
      .bind(id, environment, siteId, name, encryptedValue, revision, createdBy, createdAt, updatedAt, environment, siteId, name);
  }

  bumpRuntimeConfigGenerationForPutStatement(environment, siteId, updatedAt, { secretId, revision, encryptedValue }) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
        WHERE environment = ? AND site_id = ?
          AND EXISTS (
            SELECT 1 FROM site_secrets
            WHERE id = ? AND revision = ? AND encrypted_value = ? AND deleted_at IS NULL
          )`
      )
      .bind(updatedAt, environment, siteId, secretId, revision, encryptedValue);
  }

  bumpRuntimeConfigGenerationForDeleteStatement(environment, siteId, updatedAt, { secretId, revision, deletedAt }) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
        WHERE environment = ? AND site_id = ?
          AND EXISTS (
            SELECT 1 FROM site_secrets
            WHERE id = ? AND revision = ? AND deleted_at = ?
          )`
      )
      .bind(updatedAt, environment, siteId, secretId, revision, deletedAt);
  }

  async deleteSiteSecret(environment, siteId, name, { deletedAt } = {}) {
    const now = deletedAt || this.now();
    const existing = await this.db
      .prepare(
        `SELECT * FROM site_secrets
        WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL`
      )
      .bind(environment, siteId, name)
      .first();
    if (!existing) return null;
    const results = await this.db.batch([
      this.db
        .prepare('UPDATE site_secrets SET deleted_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
        .bind(now, now, existing.id, Number(existing.revision || 0)),
      this.bumpRuntimeConfigGenerationForDeleteStatement(environment, siteId, now, {
        secretId: existing.id,
        revision: Number(existing.revision || 0),
        deletedAt: now,
      }),
    ]);
    if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
      throw new Error('SITE_SECRET_REVISION_CONFLICT');
    }
    return mapSiteSecretMetadata({ ...existing, deleted_at: now, updated_at: now });
  }

  async deleteSiteSecretWithAudit(input) {
    const now = input.deletedAt || this.now();
    const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
    const secret = existing ? mapSiteSecretMetadata({ ...existing, deleted_at: now, updated_at: now }) : null;
    if (!existing) {
      await this.auditEventStatement(secretAuditEvent(input, 'site_secret.delete', { name: input.name }, now)).run();
      return null;
    }
    const auditRecord = secretAuditEvent(input, 'site_secret.delete', secret, now);
    const results = await this.db.batch([
      this.db
        .prepare('UPDATE site_secrets SET deleted_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
        .bind(now, now, existing.id, Number(existing.revision || 0)),
      this.bumpRuntimeConfigGenerationForDeleteStatement(input.environment, input.siteId, now, {
        secretId: existing.id,
        revision: Number(existing.revision || 0),
        deletedAt: now,
      }),
      this.siteSecretDeleteAuditEventStatement(auditRecord, {
        secretId: existing.id,
        revision: Number(existing.revision || 0),
        deletedAt: now,
      }),
    ]);
    if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1 || results?.[2]?.meta?.changes !== 1) {
      throw new Error('SITE_SECRET_REVISION_CONFLICT');
    }
    return secret;
  }

  async listEnabledSiteSecrets(environment, siteId) {
    const result = await this.db
      .prepare(
        `SELECT * FROM site_secrets
        WHERE environment = ? AND site_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`
      )
      .bind(environment, siteId)
      .all();
    const secrets = [];
    for (const row of result.results || []) {
      secrets.push(await mapSiteSecret(row, this.secretEncryptionKey));
    }
    return secrets;
  }

  async listEnabledSiteVars(environment, siteId) {
    const result = await this.db
      .prepare(
        `SELECT * FROM site_vars
        WHERE environment = ? AND site_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`
      )
      .bind(environment, siteId)
      .all();
    return (result.results || []).map(mapSiteVar);
  }

  async replaceSiteVars(input) {
    const now = input.updatedAt || this.now();
    const vars = input.vars || {};
    const lockId = input.lockId || randomStoreId('runtime_lock');
    const lock = await this.acquireRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
    if (lock?.meta?.changes !== 1) throw new Error('SITE_VAR_REVISION_CONFLICT');

    let released = false;
    try {
      const routeState = await this.getRuntimeConfigRouteState(input.environment, input.siteId);
      if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('SITE_VAR_REVISION_CONFLICT');
      const liveVars = await this.listEnabledSiteVars(input.environment, input.siteId);
      const liveByName = new Map(liveVars.map((record) => [record.name, record]));
      const desiredNames = Object.keys(vars).sort();
      const liveNames = [...liveByName.keys()].sort();
      const hasChanges =
        desiredNames.length !== liveNames.length ||
        desiredNames.some((name) => {
          const existing = liveByName.get(name);
          return !existing || existing.value !== vars[name];
        });
      if (!hasChanges) {
        const release = await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
        released = release?.meta?.changes === 1;
        if (!released) throw new Error('SITE_VAR_REVISION_CONFLICT');
        return liveVars;
      }

      const statements = [];
      for (const name of desiredNames) {
        const existing = liveByName.get(name);
        if (existing && existing.value === vars[name]) continue;
        const revision = (await this.nextSiteVarRevision(input.environment, input.siteId, name)) + 1;
        if (existing) {
          this.pushRuntimeChangeStatement(
            statements,
            this.db
              .prepare(
                `UPDATE site_vars
                SET value = ?, revision = ?, updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                  AND EXISTS (
                    SELECT 1 FROM site_routes
                    WHERE environment = ? AND site_id = ?
                      AND runtime_config_lock_id = ?
                  )`
              )
              .bind(vars[name], revision, now, existing.id, input.environment, input.siteId, lockId)
          );
        } else {
          const id = input.createId ? input.createId(name) : randomStoreId('var');
          this.pushRuntimeChangeStatement(
            statements,
            this.siteVarInsertStatement({
              id,
              environment: input.environment,
              siteId: input.siteId,
              name,
              value: vars[name],
              revision,
              createdBy: input.actorId || input.createdBy,
              createdAt: now,
              updatedAt: now,
              lockId,
            })
          );
        }
      }
      for (const name of liveNames) {
        if (desiredNames.includes(name)) continue;
        const existing = liveByName.get(name);
        this.pushRuntimeChangeStatement(
          statements,
          this.db
            .prepare(
              `UPDATE site_vars
              SET deleted_at = ?, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM site_routes
                  WHERE environment = ? AND site_id = ?
                    AND runtime_config_lock_id = ?
                )`
            )
            .bind(now, now, existing.id, input.environment, input.siteId, lockId)
        );
      }
      this.pushRuntimeChangeStatement(
        statements,
        this.bumpRuntimeConfigGenerationAndReleaseLockStatement(input.environment, input.siteId, now, lockId)
      );

      await this.db.batch(statements);
      released = true;
      return this.listEnabledSiteVars(input.environment, input.siteId);
    } catch (error) {
      if (!released) {
        try {
          await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
        } catch {
          // Best effort: the next runtime config operation will fail closed if the lock remains.
        }
      }
      throw error;
    }
  }

  async getRuntimeConfigRouteState(environment, siteId) {
    const row = await this.db
      .prepare(
        `SELECT runtime_config_generation, runtime_config_lock_id
        FROM site_routes
        WHERE environment = ? AND site_id = ?`
      )
      .bind(environment, siteId)
      .first();
    return row
      ? {
          runtimeConfigGeneration: row.runtime_config_generation || 0,
          runtimeConfigLockId: row.runtime_config_lock_id || null,
        }
      : null;
  }

  async nextSiteVarRevision(environment, siteId, name) {
    const row = await this.db
      .prepare(
        `SELECT MAX(revision) AS max_revision FROM site_vars
        WHERE environment = ? AND site_id = ? AND name = ?`
      )
      .bind(environment, siteId, name)
      .first();
    return Number(row?.max_revision || 0);
  }

  siteVarInsertStatement({ id, environment, siteId, name, value, revision, createdBy, createdAt, updatedAt, lockId }) {
    return this.db
      .prepare(
        `INSERT INTO site_vars (
          id, environment, site_id, name, value, revision,
          created_by, created_at, updated_at, deleted_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
        WHERE EXISTS (
          SELECT 1 FROM site_routes
          WHERE environment = ? AND site_id = ?
            AND runtime_config_lock_id = ?
        )`
      )
      .bind(id, environment, siteId, name, value, revision, createdBy, createdAt, updatedAt, environment, siteId, lockId);
  }

  acquireRuntimeConfigLockStatement(environment, siteId, lockId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_lock_id = ?, updated_at = ?
        WHERE environment = ? AND site_id = ? AND runtime_config_lock_id IS NULL`
      )
      .bind(lockId, updatedAt, environment, siteId);
  }

  releaseRuntimeConfigLockStatement(environment, siteId, lockId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_lock_id = NULL, updated_at = ?
        WHERE environment = ? AND site_id = ? AND runtime_config_lock_id = ?`
      )
      .bind(updatedAt, environment, siteId, lockId);
  }

  bumpRuntimeConfigGenerationAndReleaseLockStatement(environment, siteId, updatedAt, lockId) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1,
          runtime_config_lock_id = NULL,
          updated_at = ?
        WHERE environment = ? AND site_id = ?
          AND runtime_config_lock_id = ?`
      )
      .bind(updatedAt, environment, siteId, lockId);
  }

  pushRuntimeChangeStatement(statements, statement) {
    statements.push(statement, this.runtimeChangeGuardStatement());
  }

  runtimeChangeGuardStatement(errorCode = 'SITE_VAR_REVISION_CONFLICT') {
    return this.db.prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`).bind(errorCode);
  }

  bumpRuntimeConfigGenerationStatement(environment, siteId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
        SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
        WHERE environment = ? AND site_id = ?`
      )
      .bind(updatedAt, environment, siteId);
  }

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
  }

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
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt
      );
  }

  siteSecretPutAuditEventStatement(record, { secretId, revision, encryptedValue, updatedAt }) {
    return this.db
      .prepare(
        `INSERT INTO audit_events (
          id, environment, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
          decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM site_secrets
        WHERE id = ? AND revision = ? AND encrypted_value = ? AND updated_at = ? AND deleted_at IS NULL`
      )
      .bind(
        record.id,
        record.environment || record.metadata?.environment || null,
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt,
        secretId,
        revision,
        encryptedValue,
        updatedAt
      );
  }

  siteSecretDeleteAuditEventStatement(record, { secretId, revision, deletedAt }) {
    return this.db
      .prepare(
        `INSERT INTO audit_events (
          id, environment, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
          decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM site_secrets
        WHERE id = ? AND revision = ? AND deleted_at = ?`
      )
      .bind(
        record.id,
        record.environment || record.metadata?.environment || null,
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt,
        secretId,
        revision,
        deletedAt
      );
  }

  async activateSiteVersion(
    siteId,
    {
      activeVersionId,
      workerName,
      runtime = 'worker',
      executionProvider,
      dispatchType,
      dispatchBindingName = null,
      slotId = null,
      visibility,
      requiredArtifactAvailability = null,
      updatedAt,
    },
    environment,
    expectedRoute = null
  ) {
    const expectedConditions = expectedRoute
      ? ' AND route_generation = ? AND policy_version = ? AND runtime_config_generation = ? AND active_version_id IS ?'
      : '';
    const artifactAvailabilityCondition = requiredArtifactAvailability
      ? ` AND EXISTS (
          SELECT 1 FROM site_versions
          WHERE site_versions.id = ?
            AND site_versions.site_id = site_routes.site_id
            AND site_versions.artifact_availability = ?
        )`
      : '';
    const conditionBinds = [
      ...(expectedRoute
        ? [
            expectedRoute.routeGeneration,
            expectedRoute.policyVersion,
            expectedRoute.runtimeConfigGeneration || 0,
            expectedRoute.activeVersionId,
          ]
        : []),
      ...(requiredArtifactAvailability ? [activeVersionId, requiredArtifactAvailability] : []),
    ];
    const result = await this.db
      .prepare(
        `UPDATE site_routes
        SET active_version_id = ?, worker_name = ?, runtime = ?,
          execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
          visibility = ?, route_status = 'active', route_generation = route_generation + 1,
          updated_at = ?
        WHERE site_id = ?${environment ? ' AND environment = ?' : ''}${expectedConditions}${artifactAvailabilityCondition}`
      )
      .bind(
        ...(environment
          ? [
              activeVersionId,
              workerName,
              runtime,
              executionProvider,
              dispatchType,
              dispatchBindingName,
              slotId,
              visibility,
              updatedAt,
              siteId,
              environment,
              ...conditionBinds,
            ]
          : [
              activeVersionId,
              workerName,
              runtime,
              executionProvider,
              dispatchType,
              dispatchBindingName,
              slotId,
              visibility,
              updatedAt,
              siteId,
              ...conditionBinds,
            ])
      )
      .run();
    if ((expectedRoute || requiredArtifactAvailability) && result?.meta?.changes === 0) return null;
    return this.getRouteBySiteId(siteId, environment);
  }

  async restoreSiteRoute(siteId, route, environment) {
    if (!route) return null;
    await this.db
      .prepare(
        `UPDATE site_routes
        SET active_version_id = ?, worker_name = ?, runtime = ?,
          execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
          visibility = ?, policy_version = ?, route_generation = ?,
          runtime_config_generation = ?, route_status = ?, cache_tier = ?, updated_at = ?
        WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
      )
      .bind(
        ...(environment
          ? [
              route.activeVersionId,
              route.workerName,
              route.runtime,
              route.executionProvider,
              route.dispatchType,
              route.dispatchBindingName,
              route.slotId,
              route.visibility,
              route.policyVersion,
              route.routeGeneration,
              route.runtimeConfigGeneration || 0,
              route.routeStatus,
              route.cacheTier,
              route.updatedAt,
              siteId,
              environment,
            ]
          : [
              route.activeVersionId,
              route.workerName,
              route.runtime,
              route.executionProvider,
              route.dispatchType,
              route.dispatchBindingName,
              route.slotId,
              route.visibility,
              route.policyVersion,
              route.routeGeneration,
              route.runtimeConfigGeneration || 0,
              route.routeStatus,
              route.cacheTier,
              route.updatedAt,
              siteId,
            ])
      )
      .run();
    return this.getRouteBySiteId(siteId, environment);
  }

  async restoreSiteRouteIfCurrent(siteId, previousRoute, expectedRoute, environment) {
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (!routesMatchExecutionState(currentRoute, expectedRoute)) {
      return currentRoute;
    }
    return this.restoreSiteRoute(siteId, routeRestoredAsNewCommit(previousRoute, currentRoute), environment);
  }

  async restoreSiteDeleteIfCurrent(siteId, previousSite, previousRoute, previousHostnameClaim, expectedRoute, environment) {
    if (!previousSite || !previousRoute) return null;
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (!routesMatchExecutionState(currentRoute, expectedRoute)) {
      return currentRoute;
    }

    const restoredRoute = routeRestoredAsNewCommit(previousRoute, currentRoute);
    const statements = [
      this.db
        .prepare(`UPDATE sites SET deleted_at = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(
          ...(environment
            ? [previousSite.deletedAt || null, previousSite.updatedAt, siteId, environment]
            : [previousSite.deletedAt || null, previousSite.updatedAt, siteId])
        ),
      this.db
        .prepare(
          `UPDATE site_routes
          SET active_version_id = ?, worker_name = ?, runtime = ?,
            execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
            visibility = ?, policy_version = ?, route_generation = ?,
            runtime_config_generation = ?, route_status = ?, cache_tier = ?, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(
          ...(environment
            ? [
                restoredRoute.activeVersionId,
                restoredRoute.workerName,
                restoredRoute.runtime,
                restoredRoute.executionProvider,
                restoredRoute.dispatchType,
                restoredRoute.dispatchBindingName,
                restoredRoute.slotId,
                restoredRoute.visibility,
                restoredRoute.policyVersion,
                restoredRoute.routeGeneration,
                restoredRoute.runtimeConfigGeneration || 0,
                restoredRoute.routeStatus,
                restoredRoute.cacheTier,
                restoredRoute.updatedAt,
                siteId,
                environment,
              ]
            : [
                restoredRoute.activeVersionId,
                restoredRoute.workerName,
                restoredRoute.runtime,
                restoredRoute.executionProvider,
                restoredRoute.dispatchType,
                restoredRoute.dispatchBindingName,
                restoredRoute.slotId,
                restoredRoute.visibility,
                restoredRoute.policyVersion,
                restoredRoute.routeGeneration,
                restoredRoute.runtimeConfigGeneration || 0,
                restoredRoute.routeStatus,
                restoredRoute.cacheTier,
                restoredRoute.updatedAt,
                siteId,
              ])
        ),
    ];

    if (previousHostnameClaim) {
      statements.push(
        this.db
          .prepare(
            `UPDATE hostname_claims
            SET environment = ?, normalized_slug = ?, hostname_family = ?, owner_system = ?, owner_id = ?,
              owner_ref = ?, status = ?, source = ?, acquired_at = ?, lease_expires_at = ?,
              released_at = ?, reuse_hold_until = ?, release_reason = ?, updated_at = ?
            WHERE hostname = ? AND owner_system = ? AND owner_id = ?`
          )
          .bind(
            previousHostnameClaim.environment,
            previousHostnameClaim.normalizedSlug,
            previousHostnameClaim.hostnameFamily,
            previousHostnameClaim.ownerSystem,
            previousHostnameClaim.ownerId,
            previousHostnameClaim.ownerRef,
            previousHostnameClaim.status,
            previousHostnameClaim.source,
            previousHostnameClaim.acquiredAt,
            previousHostnameClaim.leaseExpiresAt,
            previousHostnameClaim.releasedAt,
            previousHostnameClaim.reuseHoldUntil,
            previousHostnameClaim.releaseReason,
            previousHostnameClaim.updatedAt,
            previousHostnameClaim.hostname,
            previousHostnameClaim.ownerSystem,
            previousHostnameClaim.ownerId
          )
      );
    }

    await this.db.batch(statements);
    return this.getRouteBySiteId(siteId, environment);
  }

  async getSiteVersion(id, environment) {
    const row = await this.db
      .prepare(
        `SELECT site_versions.*
        FROM site_versions
        JOIN sites ON sites.id = site_versions.site_id
        WHERE site_versions.id = ?${environment ? ' AND sites.environment = ?' : ''}`
      )
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapSiteVersion(row) : null;
  }

  async createWorkerSlot(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id,
      environment: input.environment,
      slotNumber: input.slotNumber,
      workerName: input.workerName,
      bindingName: input.bindingName,
      status: input.status || 'provisioning',
      assignedSiteId: input.assignedSiteId || null,
      assignedRouteId: input.assignedRouteId || null,
      assignedVersionId: input.assignedVersionId || null,
      assignedAt: input.assignedAt || null,
      lastDeployedVersionId: input.lastDeployedVersionId || null,
      lastSeenAt: input.lastSeenAt || null,
      healthStatus: input.healthStatus || 'unknown',
      notes: input.notes || null,
      createdAt: now,
      updatedAt: input.updatedAt || now,
    };
    await this.db
      .prepare(
        `INSERT INTO worker_slots (
          id, environment, slot_number, worker_name, binding_name, status,
          assigned_site_id, assigned_route_id, assigned_version_id, assigned_at,
          last_deployed_version_id, last_seen_at, health_status, notes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.slotNumber,
        record.workerName,
        record.bindingName,
        record.status,
        record.assignedSiteId,
        record.assignedRouteId,
        record.assignedVersionId,
        record.assignedAt,
        record.lastDeployedVersionId,
        record.lastSeenAt,
        record.healthStatus,
        record.notes,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(record);
  }

  async getWorkerSlot(id) {
    const row = await this.db.prepare('SELECT * FROM worker_slots WHERE id = ?').bind(id).first();
    return row ? mapWorkerSlot(row) : null;
  }

  async listWorkerSlots(environment) {
    const result = await this.db
      .prepare(
        `SELECT * FROM worker_slots
        WHERE environment = ?
        ORDER BY slot_number ASC`
      )
      .bind(environment)
      .all();
    return (result.results || []).map(mapWorkerSlot);
  }

  async listAdminNormalWorkers({ environment }) {
    const result = await this.db
      .prepare(
        `WITH active_slot_routes AS (
          SELECT worker_slots.id AS worker_slot_id, MIN(site_routes.id) AS active_route_id
          FROM worker_slots
          JOIN site_routes
            ON site_routes.environment = worker_slots.environment
            AND site_routes.route_status = 'active'
            AND (
              site_routes.slot_id = worker_slots.id
              OR site_routes.active_version_id = worker_slots.assigned_version_id
            )
          WHERE worker_slots.environment = ?
          GROUP BY worker_slots.id
        )
        SELECT worker_slots.*,
          site_routes.site_id AS active_site_id,
          site_routes.id AS active_route_id,
          site_routes.active_version_id AS active_version_id,
          site_routes.hostname AS active_hostname
        FROM worker_slots
        LEFT JOIN active_slot_routes ON active_slot_routes.worker_slot_id = worker_slots.id
        LEFT JOIN site_routes ON site_routes.id = active_slot_routes.active_route_id
        WHERE worker_slots.environment = ?
        ORDER BY worker_slots.slot_number ASC`
      )
      .bind(environment, environment)
      .all();
    return (result.results || []).map(mapAdminNormalWorkerSlot);
  }

  async retireIdleNormalWorker({ id, environment, actorUserId, reason, updatedAt }) {
    const now = updatedAt || this.now();
    const note = `retired by ${actorUserId || 'unknown'}: ${reason || 'legacy normal worker retired'}`;
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = 'retired',
          assigned_site_id = NULL,
          assigned_route_id = NULL,
          assigned_version_id = NULL,
          assigned_at = NULL,
          notes = ?,
          updated_at = ?
        WHERE id = ?
          AND environment = ?
          AND status IN ('available', 'assigned', 'cleanup_pending', 'disabled', 'delete_pending')
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
          )`
      )
      .bind(note, now, id, environment)
      .run();
    if (result?.meta?.changes === 0) return null;
    const slot = await this.getWorkerSlot(id);
    return slot ? { ...slot, activeRoute: null } : null;
  }

  async markNormalWorkerDeletePending({ id, environment, actorUserId, reason, updatedAt }) {
    const now = updatedAt || this.now();
    const note = `delete pending by ${actorUserId || 'unknown'}: ${reason || 'legacy normal worker delete pending'}`;
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = 'delete_pending',
          notes = ?,
          updated_at = ?
        WHERE id = ?
          AND environment = ?
          AND status IN ('available', 'assigned', 'cleanup_pending', 'disabled', 'delete_pending')
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
          )`
      )
      .bind(note, now, id, environment)
      .run();
    if (result?.meta?.changes === 0) return null;
    const slot = await this.getWorkerSlot(id);
    return slot ? { ...slot, activeRoute: null } : null;
  }

  async assignAvailableWorkerSlot({ environment, siteId, routeId, versionId, assignedAt }) {
    const slotsResult = await this.db
      .prepare(
        `SELECT * FROM worker_slots
        WHERE environment = ? AND status = 'available'
        ORDER BY slot_number ASC
        LIMIT 20`
      )
      .bind(environment)
      .all();
    const slots = slotsResult?.results || [];
    if (slots.length === 0) return null;
    const now = assignedAt || this.now();
    for (const slot of slots) {
      const result = await this.db
        .prepare(
          `UPDATE worker_slots
          SET status = 'assigned', assigned_site_id = ?, assigned_route_id = ?,
            assigned_version_id = ?, assigned_at = ?, last_deployed_version_id = ?,
            updated_at = ?
          WHERE id = ? AND status = 'available'`
        )
        .bind(siteId, routeId, versionId, now, versionId, now, slot.id)
        .run();
      if (!result?.meta || result.meta.changes !== 0) return this.getWorkerSlot(slot.id);
    }
    return null;
  }

  async releaseWorkerSlot(id, { status = 'available', updatedAt } = {}) {
    const now = updatedAt || this.now();
    await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = ?, assigned_site_id = NULL, assigned_route_id = NULL,
          assigned_version_id = NULL, assigned_at = NULL, updated_at = ?
        WHERE id = ?`
      )
      .bind(status, now, id)
      .run();
    return this.getWorkerSlot(id);
  }

  async markWorkerSlotCleanupPending(id, { expectedVersionId, updatedAt } = {}) {
    if (!expectedVersionId) return null;
    const now = updatedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = 'cleanup_pending', updated_at = ?
        WHERE id = ?
          AND status = 'assigned'
          AND assigned_version_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
          )`
      )
      .bind(now, id, expectedVersionId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getWorkerSlot(id);
  }

  async releaseCleanupWorkerSlot(id, { expectedVersionId, updatedAt } = {}) {
    if (!expectedVersionId) return null;
    const now = updatedAt || this.now();
    const result = await this.db
      .prepare(
        `UPDATE worker_slots
        SET status = 'available',
          assigned_site_id = NULL,
          assigned_route_id = NULL,
          assigned_version_id = NULL,
          assigned_at = NULL,
          last_deployed_version_id = COALESCE(last_deployed_version_id, ?),
          updated_at = ?
        WHERE id = ?
          AND status = 'cleanup_pending'
          AND assigned_version_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM site_routes
            WHERE site_routes.environment = worker_slots.environment
              AND site_routes.route_status = 'active'
              AND (
                site_routes.slot_id = worker_slots.id
                OR site_routes.active_version_id = worker_slots.assigned_version_id
              )
          )`
      )
      .bind(expectedVersionId, now, id, expectedVersionId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getWorkerSlot(id);
  }

  async createAccessKey(input) {
    if ('plaintext' in input) throw new Error('ACCESS_KEY_PLAINTEXT_FORBIDDEN');
    const now = this.now();
    const ownerType = input.ownerType || 'user';
    const ownerId = input.ownerId || input.ownerUserId;
    const record = {
      id: input.id,
      environment: input.environment || null,
      ownerType,
      ownerId,
      ownerUserId: input.ownerUserId || (ownerType === 'user' ? ownerId : input.createdByUserId),
      createdByUserId: input.createdByUserId || input.ownerUserId || (ownerType === 'user' ? ownerId : null),
      keyHash: input.keyHash,
      pepperId: input.pepperId,
      name: input.name,
      scopes: [...input.scopes],
      siteId: input.siteId || null,
      expiresAt: input.expiresAt || null,
      lastUsedAt: null,
      revokedAt: null,
      revokedByUserId: null,
      revokedReason: null,
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO access_keys (
          id, environment, owner_user_id, key_hash, pepper_id, name, scopes_json, site_id,
          owner_type, owner_id, created_by_user_id, expires_at, last_used_at,
          revoked_at, revoked_by_user_id, revoked_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.ownerUserId,
        record.keyHash,
        record.pepperId,
        record.name,
        JSON.stringify(record.scopes),
        record.siteId,
        record.ownerType,
        record.ownerId,
        record.createdByUserId,
        record.expiresAt,
        record.lastUsedAt,
        record.revokedAt,
        record.revokedByUserId,
        record.revokedReason,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  }

  async reserveS2SNonce({ environment, clientId, nonce, endpoint, receivedAt, expiresAt }) {
    try {
      await this.db
        .prepare(
          `INSERT INTO s2s_nonces (
            environment, client_id, nonce, endpoint, received_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(environment, clientId, nonce, endpoint, receivedAt, expiresAt)
        .run();
      return true;
    } catch (error) {
      if (isS2SNonceUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async consumeS2SRateLimit({ environment, scope, subject, bucketStart, expiresAt, limit }) {
    const row = await this.db
      .prepare(
        `INSERT INTO s2s_rate_limits (
          environment, scope, subject, bucket_start, request_count, expires_at
        ) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(environment, scope, subject, bucket_start) DO UPDATE SET
          request_count = request_count + 1,
          expires_at = excluded.expires_at
        WHERE request_count < ?
        RETURNING request_count`
      )
      .bind(environment, scope, subject, bucketStart, expiresAt, limit)
      .first();
    if (!row) return { allowed: false, count: Number(limit) };
    return { allowed: true, count: Number(row.request_count) };
  }

  async cleanupExpiredS2SGuards(now) {
    await this.db.prepare('DELETE FROM s2s_nonces WHERE expires_at <= ?').bind(now).run();
    await this.db.prepare('DELETE FROM s2s_rate_limits WHERE expires_at <= ?').bind(now).run();
  }

  async getAccessKeyById(id, environment) {
    const row = await this.db
      .prepare(
        `SELECT access_keys.*
        FROM access_keys
        LEFT JOIN sites ON sites.id = access_keys.site_id
        WHERE access_keys.id = ?${
          environment
            ? ' AND (access_keys.environment = ? OR (access_keys.environment IS NULL AND access_keys.site_id IS NOT NULL AND sites.environment = ?))'
            : ''
        }`
      )
      .bind(...(environment ? [id, environment, environment] : [id]))
      .first();
    return row ? mapAccessKey(row) : null;
  }

  async listAccessKeysForOwner(ownerUserId, environment) {
    const result = await this.db
      .prepare(
        `SELECT access_keys.*
        FROM access_keys
        LEFT JOIN sites ON sites.id = access_keys.site_id
        WHERE access_keys.owner_user_id = ?
          AND COALESCE(access_keys.owner_type, 'user') = 'user'
          AND COALESCE(access_keys.owner_id, access_keys.owner_user_id) = ?
          ${
            environment
              ? 'AND (access_keys.environment = ? OR (access_keys.environment IS NULL AND access_keys.site_id IS NOT NULL AND sites.environment = ?))'
              : ''
          }
        ORDER BY access_keys.created_at DESC`
      )
      .bind(...(environment ? [ownerUserId, ownerUserId, environment, environment] : [ownerUserId, ownerUserId]))
      .all();
    return (result.results || []).map(mapAccessKey);
  }

  async listAccessKeys({ ownerType, ownerId, environment } = {}) {
    const where = [];
    const binds = [];
    if (ownerType) {
      where.push("COALESCE(access_keys.owner_type, 'user') = ?");
      binds.push(ownerType);
    }
    if (ownerId) {
      where.push('COALESCE(access_keys.owner_id, access_keys.owner_user_id) = ?');
      binds.push(ownerId);
    }
    if (environment) {
      where.push(
        '(access_keys.environment = ? OR (access_keys.environment IS NULL AND access_keys.site_id IS NOT NULL AND sites.environment = ?))'
      );
      binds.push(environment, environment);
    }
    const result = await this.db
      .prepare(
        `SELECT access_keys.*
        FROM access_keys
        LEFT JOIN sites ON sites.id = access_keys.site_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY access_keys.created_at DESC`
      )
      .bind(...binds)
      .all();
    return (result.results || []).map(mapAccessKey);
  }

  async updateAccessKeyLastUsed(id, lastUsedAt) {
    await this.db.prepare('UPDATE access_keys SET last_used_at = ? WHERE id = ?').bind(lastUsedAt, id).run();
    return this.getAccessKeyById(id);
  }

  async revokeAccessKey(id, revokedAt, { revokedByUserId = null, revokedReason = null } = {}) {
    await this.db
      .prepare('UPDATE access_keys SET revoked_at = ?, revoked_by_user_id = ?, revoked_reason = ? WHERE id = ?')
      .bind(revokedAt, revokedByUserId, revokedReason, id)
      .run();
    return this.getAccessKeyById(id);
  }

  async getDeployment(id, environment) {
    const row = await this.db
      .prepare('SELECT * FROM deployments WHERE id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapDeployment(row) : null;
  }

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
  }

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
          idempotency_scope, request_hash, terminal_response_json,
          previous_version_id, error_code, error_message, failure_stage,
          failure_diagnostics_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  }

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
  }

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
  }

  async getDeploymentResourceCleanupTask(id, environment) {
    const row = await this.db
      .prepare('SELECT * FROM deployment_resource_cleanup_tasks WHERE id = ?' + (environment ? ' AND environment = ?' : ''))
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapDeploymentResourceCleanupTask(row) : null;
  }

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
  }

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
  }

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
  }

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
  }
}

export function deploymentIdempotencyScope({ environment, actorId, siteId, operation }) {
  return `${environment}:${actorId}:${siteId}:${operation}`;
}

export function cacheTierForVisibility(visibility) {
  if (visibility === 'disabled') return 'strict';
  if (visibility === 'acl' || visibility === 'owner') return 'sensitive';
  return 'fast';
}

export function createInitialRoute(input, now) {
  return {
    id: input.routeId,
    hostname: input.hostname,
    siteId: input.id,
    environment: input.environment,
    runtime: 'disabled',
    executionProvider: null,
    workerName: null,
    dispatchType: null,
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: null,
    visibility: input.defaultVisibility,
    policyVersion: 1,
    routeGeneration: 0,
    runtimeConfigGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: cacheTierForVisibility(input.defaultVisibility),
    createdAt: now,
    updatedAt: now,
  };
}

export function createOwnerMember(siteId, ownerUserId, now) {
  return {
    siteId,
    userId: ownerUserId,
    role: 'owner',
    createdBy: ownerUserId,
    createdAt: now,
  };
}

export function createHostnameClaim(input, now) {
  return {
    id: input.id || `claim_${input.ownerRef || input.ownerId}`,
    environment: input.environment,
    hostname: String(input.hostname || '').toLowerCase(),
    normalizedSlug: input.normalizedSlug,
    hostnameFamily: input.hostnameFamily || hostnameFamilyForHostname(input.hostname),
    ownerSystem: input.ownerSystem,
    ownerId: input.ownerId,
    ownerRef: input.ownerRef || null,
    status: input.status || 'active',
    source: input.source,
    acquiredAt: input.acquiredAt || now,
    leaseExpiresAt: input.leaseExpiresAt || null,
    releasedAt: input.releasedAt || null,
    reuseHoldUntil: input.reuseHoldUntil || null,
    releaseReason: input.releaseReason || null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

export function hostnameFamilyForHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (value.endsWith('.workers.xd.team')) return 'workers';
  if (value.endsWith('.pages.xd.team')) return 'pages';
  return 'custom';
}

export function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
}

function stringifyJsonColumn(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJsonColumn(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function routesMatch(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.id === expected.id &&
    actual.activeVersionId === expected.activeVersionId &&
    actual.workerName === expected.workerName &&
    actual.runtime === expected.runtime &&
    actual.executionProvider === expected.executionProvider &&
    actual.dispatchType === expected.dispatchType &&
    actual.dispatchBindingName === expected.dispatchBindingName &&
    actual.slotId === expected.slotId &&
    actual.visibility === expected.visibility &&
    actual.policyVersion === expected.policyVersion &&
    actual.routeGeneration === expected.routeGeneration &&
    (actual.runtimeConfigGeneration || 0) === (expected.runtimeConfigGeneration || 0) &&
    actual.routeStatus === expected.routeStatus
  );
}

function routesMatchIgnoringRuntimeConfigGeneration(actual, expected) {
  if (!actual || !expected) return false;
  return routesMatch(
    {
      ...actual,
      runtimeConfigGeneration: expected.runtimeConfigGeneration || 0,
    },
    expected
  );
}

function routesMatchExecutionState(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.id === expected.id &&
    actual.activeVersionId === expected.activeVersionId &&
    actual.workerName === expected.workerName &&
    actual.runtime === expected.runtime &&
    actual.executionProvider === expected.executionProvider &&
    actual.dispatchType === expected.dispatchType &&
    actual.dispatchBindingName === expected.dispatchBindingName &&
    actual.slotId === expected.slotId &&
    actual.routeGeneration === expected.routeGeneration &&
    actual.routeStatus === expected.routeStatus
  );
}

function routeWithLatestRuntimeConfig(route, latestRoute) {
  if (!route || !latestRoute) return route;
  return {
    ...route,
    runtimeConfigGeneration: latestRoute.runtimeConfigGeneration || 0,
    updatedAt: latestRoute.updatedAt,
  };
}

function routeRestoredAsNewCommit(previousRoute, currentRoute) {
  return {
    ...previousRoute,
    visibility: currentRoute.visibility,
    policyVersion: currentRoute.policyVersion,
    cacheTier: currentRoute.cacheTier,
    routeGeneration: Math.max(previousRoute.routeGeneration || 0, currentRoute.routeGeneration || 0) + 1,
    runtimeConfigGeneration: currentRoute.runtimeConfigGeneration || 0,
    updatedAt: currentRoute.updatedAt,
  };
}

function siteAclEntryKey(entry) {
  return `${entry.effect}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole}`;
}

function mapUser(row) {
  return {
    id: row.user_id,
    email: row.email,
    realname: row.realname,
    account: row.account,
    accountId: row.account_id,
    employeenum: row.employeenum,
    employeeStatus: row.employee_status,
    feishuOpenId: row.feishu_open_id || null,
    createdSource: row.created_source || 'xd_sso',
    departmentPath: row.department_path || null,
    departmentCheckedAt: row.department_checked_at || null,
    sessionVersion: row.session_version,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSite(row) {
  return {
    id: row.id,
    slug: row.slug,
    environment: row.environment,
    ownerType: row.owner_type || 'user',
    ownerId: row.owner_id || row.owner_user_id,
    ownerUserId: row.owner_user_id,
    defaultVisibility: row.default_visibility,
    executionModeOverride: row.execution_mode_override || null,
    siteUuid: row.site_uuid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapTeam(row) {
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

function mapTeamWithCurrentMember(row) {
  return {
    ...mapTeam(row),
    currentUserRole: row.current_user_role,
    currentUserMembershipSource: row.current_user_membership_source,
    siteCount: Number(row.site_count || 0),
    memberCount: Number(row.member_count || 0),
  };
}

function mapTeamMember(row) {
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

function mapConsoleTeamSite(row) {
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

function mapConsoleDirectorySite(row) {
  const site = mapSiteWithJoinedRoute(row);
  if ((site.ownerType || 'user') === 'team') {
    return {
      ...site,
      ownerDisplayName:
        departmentTeamDisplayName({
          teamType: row.owner_team_type,
          name: row.owner_team_name,
          departmentPath: row.owner_team_department_path,
        }) || null,
      ownerTeamType: row.owner_team_type || null,
      ownerTeamId: row.owner_team_id || null,
    };
  }
  return {
    ...site,
    ownerDisplayName: row.owner_user_realname || row.owner_user_email || null,
  };
}

function mapAdminSiteWithOwner(row) {
  const site = mapSiteWithJoinedRoute(row);
  if ((site.ownerType || 'user') === 'team') {
    return {
      ...site,
      ownerDisplayName:
        departmentTeamDisplayName({
          teamType: row.owner_team_type,
          name: row.owner_team_name,
          departmentPath: row.owner_team_department_path,
        }) || null,
      ownerTeamType: row.owner_team_type || null,
      ownerDepartmentPath: row.owner_team_department_path || null,
    };
  }
  return {
    ...site,
    ownerEmail: row.owner_user_email || null,
    ownerDisplayName: row.owner_user_realname || null,
  };
}

function mapAdminDeploymentWithOwner(row) {
  const deployment = mapDeployment(row);
  if (row.site_owner_type === 'team') {
    return {
      ...deployment,
      siteSlug: row.site_slug || null,
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
    };
  }

  return {
    ...deployment,
    siteSlug: row.site_slug || null,
    ownerType: row.site_owner_type || 'user',
    ownerId: row.site_owner_id || row.site_owner_user_id || null,
    ownerUserId: row.site_owner_user_id || row.site_owner_id || null,
    ownerEmail: row.owner_user_email || null,
    ownerDisplayName: row.owner_user_realname || null,
  };
}

function mapSiteWithJoinedRoute(row) {
  const site = mapSite(row);
  if (row.management_role !== undefined) site.managementRole = row.management_role || null;
  site.route = row.route_id
    ? {
        id: row.route_id,
        hostname: row.route_hostname,
        siteId: site.id,
        environment: site.environment,
        runtime: row.route_runtime,
        executionProvider: row.route_execution_provider || executionProviderFromRuntime(row.route_runtime),
        workerName: row.route_worker_name,
        dispatchType:
          row.route_dispatch_type || dispatchTypeFromExecutionProvider(row.route_execution_provider || row.route_runtime),
        dispatchBindingName: row.route_dispatch_binding_name || null,
        slotId: row.route_slot_id || null,
        activeVersionId: row.route_active_version_id,
        visibility: row.route_visibility,
        policyVersion: row.route_policy_version,
        routeGeneration: row.route_route_generation,
        runtimeConfigGeneration: row.route_runtime_config_generation || 0,
        routeStatus: row.route_route_status,
        cacheTier: row.route_cache_tier,
        createdAt: row.route_created_at,
        updatedAt: row.route_updated_at,
      }
    : null;
  return site;
}

function mapSiteRoute(row) {
  return {
    id: row.id,
    hostname: row.hostname,
    siteId: row.site_id,
    environment: row.environment,
    runtime: row.runtime,
    executionProvider: row.execution_provider || executionProviderFromRuntime(row.runtime),
    workerName: row.worker_name,
    dispatchType: row.dispatch_type || dispatchTypeFromExecutionProvider(row.execution_provider || row.runtime),
    dispatchBindingName: row.dispatch_binding_name || null,
    slotId: row.slot_id || null,
    activeVersionId: row.active_version_id,
    visibility: row.visibility,
    policyVersion: row.policy_version,
    routeGeneration: row.route_generation,
    runtimeConfigGeneration: row.runtime_config_generation || 0,
    routeStatus: row.route_status,
    cacheTier: row.cache_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHostnameClaim(row) {
  return {
    id: row.id,
    environment: row.environment,
    hostname: row.hostname,
    normalizedSlug: row.normalized_slug,
    hostnameFamily: row.hostname_family,
    ownerSystem: row.owner_system,
    ownerId: row.owner_id,
    ownerRef: row.owner_ref,
    status: row.status,
    source: row.source,
    acquiredAt: row.acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    releasedAt: row.released_at,
    reuseHoldUntil: row.reuse_hold_until,
    releaseReason: row.release_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hostnameClaimOwnerMatches(existing, input) {
  return existing.ownerSystem === input.ownerSystem && existing.ownerId === input.ownerId;
}

function isSqliteConstraintError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /constraint|unique/i.test(message);
}

function mapSiteMember(row) {
  return {
    siteId: row.site_id,
    userId: row.user_id,
    role: row.role,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapSiteAclEntry(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    accessRole: row.access_role,
    effect: row.effect,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapPlatformAdmin(row) {
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

function mapAuditEvent(row) {
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

function mapWebhookSubscription(row, { includeSecret = false } = {}) {
  const record = {
    id: row.id,
    environment: row.environment,
    name: row.name,
    events: parseJsonColumn(row.events_json) || [],
    payloadMode: row.payload_mode,
    restrictedTemplate: parseJsonColumn(row.restricted_template_json),
    encryptedUrlCiphertext: row.encrypted_url_ciphertext,
    urlSecretRef: null,
    urlHost: row.url_host,
    urlMasked: row.url_masked,
    urlFingerprint: row.url_fingerprint,
    enabled: Boolean(row.enabled),
    lastDeliveryStatus: row.last_delivery_status || null,
    createdByUserId: row.created_by_user_id,
    disabledAt: row.disabled_at || null,
    disabledByUserId: row.disabled_by_user_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return includeSecret ? record : withoutWebhookSecret(record);
}

function mapWebhookDelivery(row) {
  return {
    id: row.id,
    environment: row.environment,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    deliveryStatus: row.delivery_status,
    renderStatus: row.render_status,
    payloadMode: row.payload_mode,
    templateRevision: row.template_revision ?? null,
    payloadHash: row.payload_hash || null,
    targetHost: row.target_host,
    httpStatus: row.http_status ?? null,
    attemptCount: Number(row.attempt_count || 0),
    nextRetryAt: row.next_retry_at || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function withoutWebhookSecret(record) {
  if (!record) return null;
  const safeRecord = { ...record };
  delete safeRecord.encryptedUrlCiphertext;
  safeRecord.urlSecretRef = null;
  return safeRecord;
}

function assertDepartmentMergeTeams(source, target) {
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

function mapSiteVersion(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    deploymentId: row.deployment_id,
    workerName: row.worker_name,
    runtime: row.runtime,
    executionProvider: row.execution_provider || executionProviderFromRuntime(row.runtime),
    dispatchType: row.dispatch_type || dispatchTypeFromExecutionProvider(row.execution_provider || row.runtime),
    dispatchBindingName: row.dispatch_binding_name || null,
    slotId: row.slot_id || null,
    artifactRef: row.artifact_ref,
    contentHash: row.content_hash,
    deploymentShape: row.deployment_shape || null,
    requestedFallback: row.requested_fallback || null,
    resolvedFallback: row.resolved_fallback || null,
    routingMode: row.routing_mode || null,
    workerEntry: row.worker_entry || null,
    assetsConfigJson: parseJsonColumn(row.assets_config_json),
    workerModulesJson: parseJsonColumn(row.worker_modules_json),
    assetManifestJson: parseJsonColumn(row.asset_manifest_json),
    canonicalContentHash: row.canonical_content_hash || row.content_hash,
    varNamesJson: parseJsonColumn(row.var_names_json),
    secretNamesJson: parseJsonColumn(row.secret_names_json),
    runtimeConfigSnapshotJson: parseJsonColumn(row.runtime_config_snapshot_json),
    artifactAvailability: row.artifact_availability || 'active',
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function mapSiteSecret(row, secretEncryptionKey) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    value: await decryptSiteSecretValue(row.encrypted_value, secretEncryptionKey),
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function mapSiteSecretMetadata(row) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function mapSiteVar(row) {
  return {
    id: row.id,
    environment: row.environment,
    siteId: row.site_id,
    name: row.name,
    value: row.value,
    revision: Number(row.revision || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function departmentTeamId(environment, departmentPath) {
  const normalizedPath = normalizeDepartmentPath(departmentPath);
  const normalizedEnvironment = normalizeRequiredString(environment).replaceAll(/[^A-Za-z0-9]+/g, '_') || 'unknown';
  if (!normalizedPath) return 'team_department_unknown';
  return `team_department_${normalizedEnvironment}_${fnv1a64Hex(normalizedPath)}`;
}

function normalizeTeamName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function normalizeNullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeUserEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeTeamRole(role) {
  if (role === 'viewer' || role === 'publisher' || role === 'admin') return role;
  throw new Error('TEAM_ROLE_INVALID');
}

function normalizeWebhookEvents(events) {
  if (!Array.isArray(events)) return [];
  return [...new Set(events.map((event) => (typeof event === 'string' ? event.trim() : '')).filter(Boolean))];
}

function normalizeWebhookPayloadMode(mode) {
  if (mode === 'standard' || mode === 'template') return mode;
  return '';
}

function normalizeWebhookSubscriptionPatch(patch = {}) {
  const normalized = {};
  if ('name' in patch) normalized.name = normalizeRequiredString(patch.name);
  if ('events' in patch) normalized.events = normalizeWebhookEvents(patch.events);
  if ('payloadMode' in patch) normalized.payloadMode = normalizeWebhookPayloadMode(patch.payloadMode);
  if ('restrictedTemplate' in patch) normalized.restrictedTemplate = patch.restrictedTemplate ?? null;
  if ('encryptedUrlCiphertext' in patch)
    normalized.encryptedUrlCiphertext = normalizeRequiredString(patch.encryptedUrlCiphertext);
  if ('urlHost' in patch) normalized.urlHost = normalizeRequiredString(patch.urlHost);
  if ('urlMasked' in patch) normalized.urlMasked = normalizeRequiredString(patch.urlMasked);
  if ('urlFingerprint' in patch) normalized.urlFingerprint = normalizeRequiredString(patch.urlFingerprint);
  if ('enabled' in patch) normalized.enabled = patch.enabled !== false;
  if ('lastDeliveryStatus' in patch) normalized.lastDeliveryStatus = patch.lastDeliveryStatus || null;
  if ('disabledAt' in patch) normalized.disabledAt = patch.disabledAt || null;
  if ('disabledByUserId' in patch) normalized.disabledByUserId = patch.disabledByUserId || null;
  return normalized;
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

function randomStoreId(prefix) {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) throw new Error('STORE_ID_CRYPTO_UNAVAILABLE');
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function encryptSiteSecretValue(value, secretEncryptionKey) {
  if (!secretEncryptionKey) throw new Error('SITE_SECRET_ENCRYPTION_KEY_REQUIRED');
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle || !cryptoImpl.getRandomValues) throw new Error('SITE_SECRET_CRYPTO_UNAVAILABLE');
  const iv = new Uint8Array(12);
  cryptoImpl.getRandomValues(iv);
  const key = await importSiteSecretKey(secretEncryptionKey);
  const bytes = new globalThis.TextEncoder().encode(value);
  const encrypted = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(encrypted)}`;
}

async function decryptSiteSecretValue(value, secretEncryptionKey) {
  if (!secretEncryptionKey) throw new Error('SITE_SECRET_ENCRYPTION_KEY_REQUIRED');
  const parts = String(value || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('SITE_SECRET_CIPHERTEXT_INVALID');
  const key = await importSiteSecretKey(secretEncryptionKey);
  const iv = base64UrlDecode(parts[1]);
  const encrypted = base64UrlDecode(parts[2]);
  const decrypted = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

async function importSiteSecretKey(secretEncryptionKey) {
  const material = new globalThis.TextEncoder().encode(String(secretEncryptionKey));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
  return globalThis.crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '')
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function secretAuditEvent(input, eventType, secret, createdAt) {
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

function platformAdminAuditEvent(input, eventType, createdAt) {
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

function departmentTeamAuditEvent(team, eventType, createdAt) {
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

function departmentMembershipAuditEvent(input, eventType, createdAt) {
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

function departmentMembershipMigrationAuditEvent(input, createdAt) {
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

function teamDeleteAuditEvent(team, blockingAssets, actorUserId, createdAt) {
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

function mapWorkerSlot(row) {
  return {
    id: row.id,
    environment: row.environment,
    slotNumber: row.slot_number,
    workerName: row.worker_name,
    bindingName: row.binding_name,
    status: row.status,
    assignedSiteId: row.assigned_site_id,
    assignedRouteId: row.assigned_route_id,
    assignedVersionId: row.assigned_version_id,
    assignedAt: row.assigned_at,
    lastDeployedVersionId: row.last_deployed_version_id,
    lastSeenAt: row.last_seen_at,
    healthStatus: row.health_status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAdminNormalWorkerSlot(row) {
  const slot = mapWorkerSlot(row);
  return {
    ...slot,
    activeRoute: row.active_route_id
      ? {
          siteId: row.active_site_id,
          routeId: row.active_route_id,
          activeVersionId: row.active_version_id,
          hostname: row.active_hostname,
        }
      : null,
  };
}

function executionProviderFromRuntime(runtime) {
  return runtime === 'wfp' ? 'wfp' : null;
}

function dispatchTypeFromExecutionProvider(value) {
  const executionProvider = executionProviderFromRuntime(value) || value;
  if (executionProvider === 'normal-worker-slot') return 'service-binding';
  if (executionProvider === 'wfp') return 'dispatch-namespace';
  return null;
}

function mapAccessKey(row) {
  return {
    id: row.id,
    environment: row.environment || null,
    ownerType: row.owner_type || 'user',
    ownerId: row.owner_id || row.owner_user_id,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id || row.owner_user_id,
    keyHash: row.key_hash,
    pepperId: row.pepper_id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json),
    siteId: row.site_id,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id || null,
    revokedReason: row.revoked_reason || null,
    createdAt: row.created_at,
  };
}

function mapDeployment(row) {
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

function mapDeploymentResourceCleanupTask(row) {
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

function isS2SNonceUniqueConstraintError(error) {
  const message = String(error?.message || error || '');
  return /UNIQUE constraint failed:\s*s2s_nonces\.environment,\s*s2s_nonces\.client_id,\s*s2s_nonces\.nonce/i.test(
    message,
  );
}
