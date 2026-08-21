import {
  assertDepartmentMergeTeams,
  departmentMembershipAuditEvent,
  departmentMembershipMigrationAuditEvent,
  departmentTeamAuditEvent,
  departmentTeamId,
  deriveDepartmentTeamIdentity,
  mapTeam,
  normalizeDepartmentPath,
  normalizeNullableString,
  randomStoreId,
} from '../support/index.js';

export const departmentMetadataMethods = {
  async previewDepartmentTeamMerge({ sourceTeamId, targetTeamId, environment }) {
    const source = await this.getTeamForDepartmentMerge(sourceTeamId, environment);
    const target = await this.getTeamForDepartmentMerge(targetTeamId, environment);
    assertDepartmentMergeTeams(source, target);
    return {
      sourceTeam: source,
      targetTeam: target,
      counts: await this.countDepartmentTeamMergeAssets(source.id),
    };
  },

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
  },

  async getTeamForDepartmentMerge(teamId, environment) {
    const row = environment
      ? await this.db
          .prepare('SELECT * FROM teams WHERE id = ? AND environment = ? AND deleted_at IS NULL')
          .bind(teamId, environment)
          .first()
      : await this.db.prepare('SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL').bind(teamId).first();
    return row ? mapTeam(row) : null;
  },

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
  },

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
  },

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
    const existingById = await this.getTeamForDepartmentMerge(deterministicId, environment);
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
    const inserted = await this.getTeamForDepartmentMerge(team.id, environment);
    if (inserted?.mergedIntoTeamId) {
      const target = await this.getTeam(inserted.mergedIntoTeamId);
      if (target && target.environment === environment && target.status === 'active' && !target.deletedAt) return target;
    }
    target = inserted || (await this.findDepartmentTeam(environment, normalizedPath));
    if (!target) return target;
    await this.mergeLegacyDepartmentTeamIfNeeded({ environment, fullPath: identity.fullPath, target });
    return this.getTeam(target.id);
  },

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
  },

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
  },

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
  },

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
  },
};
