import { cloneRecord, mapUser, normalizeUserEmail } from '../support/index.js';

export const identityMetadataMethods = {
  async createUser(input) {
    const now = this.now();
    const userId = input.userId || input.id;
    const record = {
      id: userId,
      email: normalizeUserEmail(input.email),
      realname: input.realname || null,
      account: input.account || null,
      accountId: input.accountId || null,
      employeenum: input.employeenum || null,
      employeeStatus: input.employeeStatus || 'unknown',
      feishuOpenId: input.feishuOpenId || null,
      cindyMembershipId: input.cindyMembershipId || null,
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
              feishu_open_id, cindy_membership_id, created_source, department_path, department_checked_at,
              session_version, last_login_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.cindyMembershipId,
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
  },

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
      email: normalizeUserEmail(input.email),
      realname: input.realname || null,
      account: input.account || null,
      accountId: input.accountId || null,
      employeenum: input.employeenum || null,
      employeeStatus: input.employeeStatus || 'unknown',
      feishuOpenId: existing?.feishuOpenId || null,
      cindyMembershipId: existing?.cindyMembershipId || null,
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
              feishu_open_id, cindy_membership_id, created_source, department_path, department_checked_at,
              session_version, last_login_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        record.cindyMembershipId,
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
  },

  async getUser(id) {
    const row = await this.db.prepare('SELECT * FROM users WHERE user_id = ?').bind(id).first();
    return row ? mapUser(row) : null;
  },

  async getUserByEmail(email) {
    const normalizedEmail = normalizeUserEmail(email);
    if (!normalizedEmail) return null;
    const row = await this.db.prepare('SELECT * FROM users WHERE lower(trim(email)) = ?').bind(normalizedEmail).first();
    return row ? mapUser(row) : null;
  },

  async getUserByFeishuOpenId(feishuOpenId) {
    if (!feishuOpenId) return null;
    const row = await this.db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').bind(feishuOpenId).first();
    return row ? mapUser(row) : null;
  },

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
  },

  async getUserByCindyMembershipId(membershipId) {
    if (!membershipId) return null;
    const row = await this.db.prepare('SELECT * FROM users WHERE cindy_membership_id = ?').bind(membershipId).first();
    return row ? mapUser(row) : null;
  },

  async bindUserCindyMembershipId(userId, membershipId) {
    if (!membershipId) return false;
    const result = await this.db
      .prepare(
        `UPDATE users
            SET cindy_membership_id = ?, updated_at = ?
            WHERE user_id = ?
              AND (cindy_membership_id IS NULL OR cindy_membership_id = ?)
              AND NOT EXISTS (
                SELECT 1 FROM users AS bound_users
                WHERE bound_users.cindy_membership_id = ?
                  AND bound_users.user_id != users.user_id
              )`
      )
      .bind(membershipId, this.now(), userId, membershipId, membershipId)
      .run();
    return result?.meta?.changes === 1;
  },

  async updateUserRealnameIfEmpty(userId, realname) {
    const normalizedRealname = typeof realname === 'string' ? realname.trim() : '';
    if (!normalizedRealname) return this.getUser(userId);
    await this.db
      .prepare(
        `UPDATE users
            SET realname = ?, updated_at = ?
            WHERE user_id = ? AND (realname IS NULL OR trim(realname) = '')`
      )
      .bind(normalizedRealname, this.now(), userId)
      .run();
    return this.getUser(userId);
  },
};
