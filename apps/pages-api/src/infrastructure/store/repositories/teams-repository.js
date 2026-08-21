import {
  mapTeam,
  mapTeamMember,
  mapTeamWithCurrentMember,
  normalizeNullableString,
  normalizeTeamName,
  normalizeTeamRole,
  randomStoreId,
  teamDeleteAuditEvent,
} from '../store-support.js';

export const teamsRepositoryMethods = {
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
  },

  async getTeam(teamId) {
    const row = await this.db
      .prepare("SELECT * FROM teams WHERE id = ? AND status = 'active' AND deleted_at IS NULL")
      .bind(teamId)
      .first();
    return row ? mapTeam(row) : null;
  },

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
  },

  async removeTeamMember({ teamId, userId, actorUserId }) {
    const now = this.now();
    const result = await this.db
      .prepare('UPDATE team_members SET removed_at = ?, removed_by_user_id = ?, updated_at = ? WHERE team_id = ? AND user_id = ?')
      .bind(now, actorUserId || null, now, teamId, userId)
      .run();
    if (result?.meta?.changes === 0) return null;
    return this.getTeamMember({ teamId, userId, includeRemoved: true });
  },

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
  },

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
  },

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
  },

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
  },

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
  },
};
