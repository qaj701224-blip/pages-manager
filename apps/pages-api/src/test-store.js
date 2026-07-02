import {
  cacheTierForVisibility,
  cloneRecord,
  createHostnameClaim,
  createInitialRoute,
  createOwnerMember,
  deploymentIdempotencyScope,
  hostnameFamilyForHostname,
} from './store.js';

export function createTestPagesStore({ now = () => new Date().toISOString(), failAuditWrites = false } = {}) {
  return new TestPagesStore({ now, failAuditWrites });
}

class TestPagesStore {
  constructor({ now, failAuditWrites }) {
    this.now = now;
    this.failAuditWrites = failAuditWrites;
    this.users = new Map();
    this.teams = new Map();
    this.teamMembers = new Map();
    this.sites = new Map();
    this.siteSlugIndex = new Map();
    this.routes = new Map();
    this.hostnameClaims = new Map();
    this.routeBySiteId = new Map();
    this.siteMembers = new Map();
    this.siteAclEntries = new Map();
    this.siteVersions = new Map();
    this.siteSecrets = new Map();
    this.siteVars = new Map();
    this.siteVarHistory = new Map();
    this.workerSlots = new Map();
    this.accessKeys = new Map();
    this.platformAdmins = new Map();
    this.webhookSubscriptions = new Map();
    this.webhookDeliveries = new Map();
    this.deployments = new Map();
    this.deploymentIdempotencyIndex = new Map();
    this.auditEvents = [];
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
      departmentPath: input.departmentPath || null,
      departmentCheckedAt: input.departmentCheckedAt || null,
      sessionVersion: input.sessionVersion || 1,
      lastLoginAt: input.lastLoginAt || null,
      createdAt: now,
      updatedAt: now,
    };
    if (this.users.has(record.id)) throw new Error('USER_EXISTS');
    this.users.set(record.id, record);
    return cloneRecord(record);
  }

  async upsertUserFromSso(input) {
    const userId = input.userId || input.id;
    const existing = this.users.get(userId) || null;
    const now = input.updatedAt || this.now();
    const incomingSessionVersion = input.sessionVersion || 1;
    const incomingStatus = input.employeeStatus || 'unknown';
    const employeeStatus = resolveSsoEmployeeStatus(existing?.employeeStatus, incomingStatus);
    const staleActiveOrUnknown = existing && employeeStatus === existing.employeeStatus && employeeStatus !== incomingStatus;
    const statusChanged = existing && existing.employeeStatus !== employeeStatus;
    const record = {
      id: userId,
      email: staleActiveOrUnknown ? existing.email : input.email,
      realname: staleActiveOrUnknown ? existing.realname : input.realname || existing?.realname || null,
      account: staleActiveOrUnknown ? existing.account : input.account || existing?.account || null,
      accountId: staleActiveOrUnknown ? existing.accountId : input.accountId || existing?.accountId || null,
      employeenum: staleActiveOrUnknown ? existing.employeenum : input.employeenum || existing?.employeenum || null,
      employeeStatus,
      departmentPath: staleActiveOrUnknown
        ? existing.departmentPath || null
        : input.departmentPath || existing?.departmentPath || null,
      departmentCheckedAt: staleActiveOrUnknown
        ? existing.departmentCheckedAt || null
        : input.departmentCheckedAt || existing?.departmentCheckedAt || null,
      sessionVersion: staleActiveOrUnknown
        ? existing.sessionVersion
        : Math.max(incomingSessionVersion, existing ? existing.sessionVersion + (statusChanged ? 1 : 0) : 1),
      lastLoginAt: staleActiveOrUnknown ? existing.lastLoginAt : input.lastLoginAt || now,
      createdAt: existing?.createdAt || now,
      updatedAt: staleActiveOrUnknown ? existing.updatedAt : now,
    };
    this.users.set(record.id, record);
    return cloneRecord(record);
  }

  async getUser(id) {
    return cloneRecord(this.users.get(id) || null);
  }

  async grantPlatformAdmin({ environment, userId, grantedByUserId, grantReason }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedUserId = normalizeRequiredString(userId);
    const normalizedGrantedBy = normalizeRequiredString(grantedByUserId);
    if (!normalizedEnvironment || !normalizedUserId || !normalizedGrantedBy) throw new Error('PLATFORM_ADMIN_INVALID');

    const now = this.now();
    const existing = this.platformAdmins.get(platformAdminKey(normalizedEnvironment, normalizedUserId));
    const record = {
      environment: normalizedEnvironment,
      userId: normalizedUserId,
      grantedByUserId: normalizedGrantedBy,
      grantReason: normalizeNullableString(grantReason),
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.platformAdmins.set(platformAdminKey(normalizedEnvironment, normalizedUserId), record);
    await this.recordAuditEvent(
      platformAdminAuditEvent(
        {
          environment: normalizedEnvironment,
          targetUserId: normalizedUserId,
          actorUserId: normalizedGrantedBy,
        },
        'admin.platform_admin.grant',
        now
      )
    );
    return cloneRecord(record);
  }

  async revokePlatformAdmin({ environment, userId, revokedByUserId, revokeReason }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedUserId = normalizeRequiredString(userId);
    const normalizedRevokedBy = normalizeRequiredString(revokedByUserId);
    if (!normalizedEnvironment || !normalizedUserId || !normalizedRevokedBy) throw new Error('PLATFORM_ADMIN_INVALID');

    const existing = this.platformAdmins.get(platformAdminKey(normalizedEnvironment, normalizedUserId));
    if (!existing) return null;
    const now = this.now();
    const record = {
      ...existing,
      revokedAt: now,
      revokedByUserId: normalizedRevokedBy,
      revokeReason: normalizeNullableString(revokeReason),
      updatedAt: now,
    };
    this.platformAdmins.set(platformAdminKey(normalizedEnvironment, normalizedUserId), record);
    await this.recordAuditEvent(
      platformAdminAuditEvent(
        {
          environment: normalizedEnvironment,
          targetUserId: normalizedUserId,
          actorUserId: normalizedRevokedBy,
        },
        'admin.platform_admin.revoke',
        now
      )
    );
    return cloneRecord(record);
  }

  async isPlatformAdmin({ environment, userId }) {
    const admin = this.platformAdmins.get(platformAdminKey(environment, userId));
    return Boolean(admin && !admin.revokedAt);
  }

  async listPlatformAdmins({ environment }) {
    return [...this.platformAdmins.values()]
      .filter((admin) => admin.environment === environment && !admin.revokedAt)
      .sort((left, right) => left.userId.localeCompare(right.userId))
      .map(cloneRecord);
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
    this.webhookSubscriptions.set(record.id, record);
    return cloneRecord(withoutWebhookSecret(record));
  }

  async getWebhookSubscription({ environment, id, includeSecret = false }) {
    const record = this.webhookSubscriptions.get(id) || null;
    if (!record || (environment && record.environment !== environment)) return null;
    return cloneRecord(includeSecret ? record : withoutWebhookSecret(record));
  }

  async listWebhookSubscriptions({ environment }) {
    return cloneRecord(
      [...this.webhookSubscriptions.values()]
        .filter((webhook) => webhook.environment === environment)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name))
        .map(withoutWebhookSecret)
    );
  }

  async updateWebhookSubscription({ environment, id, patch }) {
    const existing = this.webhookSubscriptions.get(id);
    if (!existing || existing.environment !== environment) return null;
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
    this.webhookSubscriptions.set(id, next);
    return cloneRecord(withoutWebhookSecret(next));
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
    this.webhookDeliveries.set(record.id, record);
    const subscription = this.webhookSubscriptions.get(record.subscriptionId);
    if (subscription && subscription.environment === record.environment) {
      subscription.lastDeliveryStatus = record.deliveryStatus;
      subscription.updatedAt = record.updatedAt;
      this.webhookSubscriptions.set(subscription.id, subscription);
    }
    return cloneRecord(record);
  }

  async updateWebhookDelivery(id, patch) {
    const existing = this.webhookDeliveries.get(id);
    if (!existing) return null;
    const next = {
      ...existing,
      deliveryStatus: patch.deliveryStatus || existing.deliveryStatus,
      renderStatus: patch.renderStatus || existing.renderStatus,
      payloadHash: patch.payloadHash ?? existing.payloadHash,
      httpStatus: patch.httpStatus ?? existing.httpStatus,
      attemptCount: patch.attemptCount ?? existing.attemptCount,
      nextRetryAt: patch.nextRetryAt ?? existing.nextRetryAt,
      errorCode: patch.errorCode ?? existing.errorCode,
      updatedAt: patch.updatedAt || this.now(),
    };
    this.webhookDeliveries.set(id, next);
    const subscription = this.webhookSubscriptions.get(next.subscriptionId);
    if (subscription && subscription.environment === next.environment) {
      subscription.lastDeliveryStatus = next.deliveryStatus;
      subscription.updatedAt = next.updatedAt;
      this.webhookSubscriptions.set(subscription.id, subscription);
    }
    return cloneRecord(next);
  }

  async listWebhookDeliveries({ environment, subscriptionId }) {
    return cloneRecord(
      [...this.webhookDeliveries.values()]
        .filter(
          (delivery) => delivery.environment === environment && (!subscriptionId || delivery.subscriptionId === subscriptionId)
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    );
  }

  async getAdminDashboard({ environment }) {
    const sites = [...this.sites.values()].filter((site) => site.environment === environment && !site.deletedAt);
    const teams = [...this.teams.values()].filter((team) => team.environment === environment && !team.deletedAt);
    const deployments = [...this.deployments.values()].filter((deployment) => deployment.environment === environment);
    const failedDeployments = deployments
      .filter((deployment) => deployment.status === 'failed')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 10);

    return cloneRecord({
      environment,
      counts: {
        sites: sites.length,
        users: this.users.size,
        teams: teams.filter((team) => team.status === 'active').length,
        deployments: deployments.length,
        failedDeployments: failedDeployments.length,
      },
      failedDeployments,
    });
  }

  async listAdminUsers({ environment }) {
    return cloneRecord(
      [...this.users.values()]
        .map((user) => ({
          ...user,
          isPlatformAdmin: Boolean(this.platformAdmins.get(platformAdminKey(environment, user.id))?.revokedAt === null),
        }))
        .sort((left, right) => left.email.localeCompare(right.email))
    );
  }

  async listAdminSites({ environment }) {
    return cloneRecord(
      [...this.sites.values()]
        .filter((site) => !site.deletedAt)
        .filter((site) => !environment || site.environment === environment)
        .map((site) => this.decorateAdminSite(this.siteWithRoute(site.id)))
        .filter(Boolean)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    );
  }

  async listAdminTeams({ environment, teamType, status } = {}) {
    return cloneRecord(
      [...this.teams.values()]
        .filter((team) => !environment || team.environment === environment)
        .filter((team) => !teamType || team.teamType === teamType)
        .filter((team) => !status || team.status === status)
        .sort((left, right) => left.name.localeCompare(right.name))
    );
  }

  countDepartmentTeamMergeAssets(sourceTeamId) {
    const now = this.now();
    return {
      sites: [...this.sites.values()].filter(
        (site) => site.ownerType === 'team' && site.ownerId === sourceTeamId && !site.deletedAt
      ).length,
      accessKeys: [...this.accessKeys.values()].filter(
        (key) =>
          key.ownerType === 'team' && key.ownerId === sourceTeamId && !key.revokedAt && (!key.expiresAt || key.expiresAt > now)
      ).length,
      departmentMembers: [...this.teamMembers.values()].filter(
        (member) => member.teamId === sourceTeamId && member.membershipSource === 'department_auto' && !member.removedAt
      ).length,
    };
  }

  async previewDepartmentTeamMerge({ sourceTeamId, targetTeamId, environment }) {
    const source = this.getDepartmentMergeTeam(sourceTeamId, environment);
    const target = this.getDepartmentMergeTeam(targetTeamId, environment);
    assertDepartmentMergeTeams(source, target);
    return cloneRecord({
      sourceTeam: source,
      targetTeam: target,
      counts: this.countDepartmentTeamMergeAssets(source.id),
    });
  }

  async mergeDepartmentTeams({ sourceTeamId, targetTeamId, actorUserId, reason, environment }) {
    const source = this.getDepartmentMergeTeam(sourceTeamId, environment);
    const target = this.getDepartmentMergeTeam(targetTeamId, environment);
    assertDepartmentMergeTeams(source, target);
    const now = this.now();
    const counts = this.countDepartmentTeamMergeAssets(source.id);

    for (const site of this.sites.values()) {
      if (site.ownerType !== 'team' || site.ownerId !== source.id || site.deletedAt) continue;
      site.ownerId = target.id;
      site.updatedAt = now;
      this.sites.set(site.id, site);
    }

    for (const accessKey of this.accessKeys.values()) {
      if (accessKey.ownerType !== 'team' || accessKey.ownerId !== source.id || accessKey.revokedAt) continue;
      if (accessKey.expiresAt && accessKey.expiresAt <= now) continue;
      accessKey.ownerId = target.id;
      this.accessKeys.set(accessKey.id, accessKey);
    }

    for (const member of [...this.teamMembers.values()]) {
      if (member.teamId !== source.id || member.membershipSource !== 'department_auto' || member.removedAt) {
        continue;
      }
      const targetKey = teamMemberKey(target.id, member.userId);
      const existingTargetMember = this.teamMembers.get(targetKey) || null;
      if (existingTargetMember?.membershipSource === 'department_auto') {
        this.teamMembers.set(targetKey, {
          ...existingTargetMember,
          role: member.role,
          departmentPath: target.departmentPath,
          roleOverriddenAt: member.roleOverriddenAt || null,
          removedAt: null,
          removedByUserId: null,
          restoredAt: existingTargetMember.removedAt ? now : existingTargetMember.restoredAt,
          restoredByUserId: existingTargetMember.removedAt ? actorUserId : existingTargetMember.restoredByUserId,
          updatedAt: now,
        });
      } else if (!existingTargetMember) {
        this.teamMembers.set(targetKey, {
          ...member,
          teamId: target.id,
          departmentPath: target.departmentPath,
          createdAt: member.createdAt,
          updatedAt: now,
        });
      }
      member.removedAt = now;
      member.removedByUserId = actorUserId;
      member.updatedAt = now;
      this.teamMembers.set(teamMemberKey(source.id, member.userId), member);
    }

    source.status = 'merged';
    source.mergedIntoTeamId = target.id;
    source.mergedAt = now;
    source.mergedByUserId = actorUserId;
    source.mergeReason = normalizeNullableString(reason);
    source.updatedAt = now;
    this.teams.set(source.id, source);

    await this.recordAuditEvent({
      id: randomStoreId('audit'),
      environment: source.environment,
      eventType: 'admin.department_team.merge',
      actorUserId,
      actorType: 'user',
      decision: 'allow',
      statusCode: 200,
      metadata: {
        sourceTeamId: source.id,
        targetTeamId: target.id,
        counts,
      },
      createdAt: now,
    });

    return cloneRecord({
      sourceTeam: source,
      targetTeam: target,
      counts,
    });
  }

  getDepartmentMergeTeam(teamId, environment) {
    const team = this.teams.get(teamId) || null;
    if (!team || team.deletedAt) return null;
    if (environment && team.environment !== environment) return null;
    return team;
  }

  async updateUserDepartmentFromDirectory({ userId, departmentPath, departmentCheckedAt }) {
    const existing = this.users.get(userId);
    if (!existing) return null;
    const checkedAt = departmentCheckedAt || this.now();
    const record = {
      ...existing,
      departmentPath: normalizeDepartmentPath(departmentPath) || null,
      departmentCheckedAt: checkedAt,
      updatedAt: checkedAt,
    };
    this.users.set(userId, record);
    return cloneRecord(record);
  }

  async findOrCreateDepartmentTeam({ environment, departmentPath, createdAt }) {
    const normalizedPath = normalizeDepartmentPath(departmentPath);
    if (!normalizedPath) throw new Error('DEPARTMENT_PATH_REQUIRED');
    for (const team of this.teams.values()) {
      if (
        team.environment === environment &&
        team.teamType === 'department' &&
        team.departmentPath === normalizedPath &&
        team.status === 'active' &&
        !team.deletedAt
      ) {
        return cloneRecord(team);
      }
    }
    const now = createdAt || this.now();
    const team = {
      id: departmentTeamId(environment, normalizedPath),
      environment,
      name: normalizedPath,
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
    this.teams.set(team.id, team);
    await this.recordAuditEvent(departmentTeamAuditEvent(team, 'system.department_team.create', now));
    return cloneRecord(team);
  }

  async hydrateDepartmentMembership({ environment, userId, departmentPath }) {
    const normalizedPath = normalizeDepartmentPath(departmentPath);
    if (!normalizedPath) return { team: null, member: null, restored: false };
    const now = this.now();
    const migratedFrom = [];

    for (const [key, member] of this.teamMembers.entries()) {
      const team = this.teams.get(member.teamId);
      if (!team || team.environment !== environment) continue;
      if (member.userId !== userId || member.membershipSource !== 'department_auto') continue;
      if (member.departmentPath === normalizedPath) continue;
      if (member.removedAt) continue;
      migratedFrom.push({
        teamId: member.teamId,
        departmentPath: member.departmentPath,
      });
      member.removedAt = now;
      member.removedByUserId = 'system:xds';
      member.updatedAt = now;
      this.teamMembers.set(key, member);
    }

    const team = await this.findOrCreateDepartmentTeam({ environment, departmentPath: normalizedPath, createdAt: now });
    const existing = this.teamMembers.get(teamMemberKey(team.id, userId)) || null;
    if (existing) {
      const shouldRestore = Boolean(existing.removedAt && existing.removedByUserId === 'system:xds');
      existing.departmentPath = normalizedPath;
      if (shouldRestore) {
        existing.removedAt = null;
        existing.removedByUserId = null;
        existing.restoredAt = now;
        existing.restoredByUserId = 'system:xds';
      }
      existing.updatedAt = now;
      this.teamMembers.set(teamMemberKey(team.id, userId), existing);
      await this.recordDepartmentMigrations({
        environment,
        userId,
        migratedFrom,
        targetTeam: team,
        departmentPath: normalizedPath,
        now,
      });
      return { team, member: cloneRecord(existing), restored: shouldRestore };
    }

    const member = {
      teamId: team.id,
      userId,
      role: 'admin',
      membershipSource: 'department_auto',
      departmentPath: normalizedPath,
      roleOverriddenAt: null,
      removedAt: null,
      removedByUserId: null,
      restoredAt: null,
      restoredByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.teamMembers.set(teamMemberKey(team.id, userId), member);
    await this.recordAuditEvent(
      departmentMembershipAuditEvent(
        { environment, userId, teamId: team.id, departmentPath: normalizedPath },
        'system.department_membership.join',
        now
      )
    );
    await this.recordDepartmentMigrations({
      environment,
      userId,
      migratedFrom,
      targetTeam: team,
      departmentPath: normalizedPath,
      now,
    });
    return { team, member: cloneRecord(member), restored: true };
  }

  async recordDepartmentMigrations({ environment, userId, migratedFrom, targetTeam, departmentPath, now }) {
    for (const source of migratedFrom) {
      await this.recordAuditEvent(
        departmentMembershipMigrationAuditEvent(
          {
            environment,
            userId,
            oldTeamId: source.teamId,
            newTeamId: targetTeam.id,
            oldDepartmentPath: source.departmentPath,
            newDepartmentPath: departmentPath,
          },
          now
        )
      );
    }
  }

  async createTeam(input) {
    const now = this.now();
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
    this.teams.set(team.id, team);
    if (input.createdByUserId) {
      await this.addTeamMember({
        teamId: team.id,
        userId: input.createdByUserId,
        role: 'admin',
        membershipSource: 'manual',
        actorUserId: input.createdByUserId,
        createdAt: now,
      });
    }
    return cloneRecord(team);
  }

  async getTeam(teamId) {
    const team = this.teams.get(teamId) || null;
    if (!team || team.deletedAt || team.status !== 'active') return null;
    return cloneRecord(team);
  }

  async addTeamMember(input) {
    const team = this.teams.get(input.teamId);
    if (!team || team.deletedAt || team.status !== 'active') throw new Error('TEAM_NOT_FOUND');
    const now = input.createdAt || this.now();
    const existing = this.teamMembers.get(teamMemberKey(input.teamId, input.userId));
    const membershipSource =
      existing?.membershipSource === 'department_auto' && input.membershipSource === 'manual'
        ? existing.membershipSource
        : input.membershipSource || existing?.membershipSource || 'manual';
    const member = {
      teamId: input.teamId,
      userId: input.userId,
      role: normalizeTeamRole(input.role),
      membershipSource,
      departmentPath: input.departmentPath || null,
      roleOverriddenAt:
        existing?.membershipSource === 'department_auto' && existing.role !== input.role ? input.roleOverriddenAt || now : null,
      removedAt: null,
      removedByUserId: null,
      restoredAt: existing?.removedAt ? now : existing?.restoredAt || null,
      restoredByUserId: existing?.removedAt ? input.actorUserId || null : existing?.restoredByUserId || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.teamMembers.set(teamMemberKey(input.teamId, input.userId), member);
    return cloneRecord(member);
  }

  async removeTeamMember({ teamId, userId, actorUserId }) {
    const member = this.teamMembers.get(teamMemberKey(teamId, userId));
    if (!member) return null;
    const now = this.now();
    member.removedAt = now;
    member.removedByUserId = actorUserId || null;
    member.updatedAt = now;
    this.teamMembers.set(teamMemberKey(teamId, userId), member);
    return cloneRecord(member);
  }

  async restoreTeamMember({ teamId, userId, actorUserId }) {
    const member = this.teamMembers.get(teamMemberKey(teamId, userId));
    if (!member) return null;
    const now = this.now();
    member.removedAt = null;
    member.removedByUserId = null;
    member.restoredAt = now;
    member.restoredByUserId = actorUserId || null;
    member.updatedAt = now;
    this.teamMembers.set(teamMemberKey(teamId, userId), member);
    return cloneRecord(member);
  }

  async getTeamMember({ teamId, userId, includeRemoved = false }) {
    const member = this.teamMembers.get(teamMemberKey(teamId, userId)) || null;
    if (!member) return null;
    if (member.removedAt && !includeRemoved) return null;
    return cloneRecord(member);
  }

  async listTeamMembers({ teamId, includeRemoved = false } = {}) {
    return cloneRecord(
      [...this.teamMembers.values()]
        .filter((member) => member.teamId === teamId)
        .filter((member) => includeRemoved || !member.removedAt)
        .sort((left, right) => left.userId.localeCompare(right.userId))
    );
  }

  async listTeamsForUser({ environment, userId } = {}) {
    const teams = [];
    for (const member of this.teamMembers.values()) {
      if (member.userId !== userId || member.removedAt) continue;
      const team = this.teams.get(member.teamId);
      if (!team || team.deletedAt || team.status !== 'active') continue;
      if (environment && team.environment !== environment) continue;
      teams.push({
        ...team,
        currentUserRole: member.role,
        currentUserMembershipSource: member.membershipSource,
      });
    }
    return cloneRecord(teams.sort((left, right) => left.name.localeCompare(right.name)));
  }

  async countTeamBlockingAssets({ teamId }) {
    const blockingSites = [...this.sites.values()].filter(
      (site) => site.ownerType === 'team' && site.ownerId === teamId && !site.deletedAt
    ).length;
    const activeAccessKeys = [...this.accessKeys.values()].filter(
      (key) =>
        key.ownerType === 'team' && key.ownerId === teamId && !key.revokedAt && (!key.expiresAt || key.expiresAt > this.now())
    ).length;
    return { sites: blockingSites, accessKeys: activeAccessKeys };
  }

  async deleteCustomTeam({ teamId, actorUserId }) {
    const team = this.teams.get(teamId);
    if (!team || team.deletedAt || team.status !== 'active') return null;
    if (team.teamType !== 'custom') throw new Error('DEPARTMENT_TEAM_DELETE_FORBIDDEN');
    const blocking = await this.countTeamBlockingAssets({ teamId });
    if (blocking.sites > 0 || blocking.accessKeys > 0) throw new Error('TEAM_HAS_BLOCKING_ASSETS');
    this.teams.delete(teamId);
    for (const key of [...this.teamMembers.keys()]) {
      if (key.startsWith(`${teamId}:`)) this.teamMembers.delete(key);
    }
    await this.recordAuditEvent(teamDeleteAuditEvent(team, blocking, actorUserId, this.now()));
    return cloneRecord(team);
  }

  async createSite(input) {
    const slugKey = `${input.environment}:${input.slug}`;
    if (this.siteSlugIndex.has(slugKey)) throw new Error('SITE_SLUG_CONFLICT');
    if (this.routes.has(input.routeId)) throw new Error('ROUTE_EXISTS');

    const now = this.now();
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
    const owner = createOwnerMember(site.id, site.ownerUserId, now);
    const claim = createHostnameClaim(
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

    const existingClaim = this.hostnameClaims.get(claim.hostname);
    if (existingClaim) {
      if (!['released', 'held'].includes(existingClaim.status)) throw new Error('HOSTNAME_CLAIM_CONFLICT');
      if (existingClaim.reuseHoldUntil && existingClaim.reuseHoldUntil > now) {
        throw new Error('HOSTNAME_CLAIM_CONFLICT');
      }
      if (this.findConflictingHostnameClaimSync({ ...claim, excludeHostname: claim.hostname })) {
        throw new Error('HOSTNAME_CLAIM_CONFLICT');
      }
      this.hostnameClaims.set(claim.hostname, { ...claim, id: existingClaim.id, createdAt: existingClaim.createdAt });
    } else {
      if (this.findConflictingHostnameClaimSync(claim)) throw new Error('HOSTNAME_CLAIM_CONFLICT');
      this.hostnameClaims.set(claim.hostname, claim);
    }

    this.sites.set(site.id, site);
    this.siteSlugIndex.set(slugKey, site.id);
    this.routes.set(route.id, route);
    this.routeBySiteId.set(site.id, route.id);
    this.siteMembers.set(site.id, [owner]);
    this.siteAclEntries.set(site.id, []);

    return cloneRecord(site);
  }

  async getHostnameClaim(hostname) {
    return cloneRecord(this.hostnameClaims.get(String(hostname || '').toLowerCase()) || null);
  }

  async findConflictingHostnameClaim(input) {
    return cloneRecord(this.findConflictingHostnameClaimSync(input));
  }

  async acquireHostnameClaim(input) {
    const now = input.acquiredAt || this.now();
    const claim = createHostnameClaim(input, now);
    const existing = this.hostnameClaims.get(claim.hostname);
    if (existing) {
      if (existing.status === 'released' || existing.status === 'held') {
        if (existing.reuseHoldUntil && existing.reuseHoldUntil > now) {
          return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: cloneRecord(existing) };
        }
        const conflicting = this.findConflictingHostnameClaimSync({ ...claim, excludeHostname: claim.hostname });
        if (conflicting) return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: cloneRecord(conflicting) };
        const revived = { ...claim, id: existing.id, createdAt: existing.createdAt };
        this.hostnameClaims.set(claim.hostname, revived);
        return { ok: true, claim: cloneRecord(revived) };
      }
      if (hostnameClaimOwnerMatches(existing, claim) && existing.status !== 'conflicted') {
        return { ok: true, claim: cloneRecord(existing) };
      }
      return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: cloneRecord(existing) };
    }
    const existingOwnerClaim = this.findHostnameClaimForOwnerSync(claim);
    if (existingOwnerClaim) {
      if (existingOwnerClaim.hostname === claim.hostname) return { ok: true, claim: cloneRecord(existingOwnerClaim) };
      return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: cloneRecord(existingOwnerClaim) };
    }
    const conflicting = this.findConflictingHostnameClaimSync(claim);
    if (conflicting) return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT', claim: cloneRecord(conflicting) };
    this.hostnameClaims.set(claim.hostname, claim);
    return { ok: true, claim: cloneRecord(claim) };
  }

  async confirmHostnameClaim(input) {
    const claim = this.hostnameClaims.get(String(input.hostname || '').toLowerCase());
    if (!claim || !hostnameClaimOwnerMatches(claim, input) || !['pending', 'active'].includes(claim.status)) {
      return { ok: false, code: 'HOSTNAME_CLAIM_NOT_FOUND' };
    }
    claim.status = 'active';
    claim.leaseExpiresAt = null;
    claim.updatedAt = input.confirmedAt || this.now();
    return { ok: true, claim: cloneRecord(claim) };
  }

  async releaseHostnameClaim(input) {
    const claim = this.hostnameClaims.get(String(input.hostname || '').toLowerCase());
    const allowedStatuses = input.reuseHoldUntil ? ['pending', 'active', 'held'] : ['pending'];
    if (!claim || !hostnameClaimOwnerMatches(claim, input) || !allowedStatuses.includes(claim.status)) {
      return { ok: false, code: 'HOSTNAME_CLAIM_NOT_FOUND' };
    }
    claim.status = input.reuseHoldUntil ? 'held' : 'released';
    claim.releasedAt = input.releasedAt || this.now();
    claim.reuseHoldUntil = input.reuseHoldUntil || null;
    claim.releaseReason = input.releaseReason || null;
    claim.updatedAt = claim.releasedAt;
    return { ok: true, claim: cloneRecord(claim) };
  }

  async findSiteBySlug(environment, slug) {
    const site = await this.getSite(this.siteSlugIndex.get(`${environment}:${slug}`));
    return site?.deletedAt ? null : site;
  }

  async getSite(id) {
    return cloneRecord(this.sites.get(id) || null);
  }

  async listSitesForUser(userId, actor = {}, environment) {
    const siteIds = new Set();
    if (actor.type === 'access_key') {
      for (const site of this.sites.values()) {
        if (actor.siteId && actor.siteId !== site.id) continue;
        if (!this.accessKeyCanSeeSite(actor, site)) continue;
        siteIds.add(site.id);
      }
    } else {
      for (const [siteId, members] of this.siteMembers.entries()) {
        if (members.some((member) => member.userId === userId)) siteIds.add(siteId);
      }
    }

    return cloneRecord(
      [...siteIds]
        .map((siteId) => this.siteWithRoute(siteId))
        .filter(Boolean)
        .filter((site) => !site.deletedAt)
        .filter((site) => !environment || site.environment === environment)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    );
  }

  async getSiteForUser(siteId, userId, actor = {}, environment) {
    const site = this.siteWithRoute(siteId);
    if (site?.deletedAt) return null;
    if (environment && site?.environment !== environment) return null;
    if (actor.type === 'access_key') {
      if (actor.siteId && actor.siteId !== siteId) return null;
      if (!this.accessKeyCanSeeSite(actor, site)) return null;
      return cloneRecord(this.decorateAccessKeySite(actor, site));
    }
    const members = this.siteMembers.get(siteId) || [];
    if ((site.ownerType || 'user') === 'user' && members.some((member) => member.userId === userId)) {
      return cloneRecord(site);
    }
    if (site.ownerType === 'team') {
      const member = this.teamMembers.get(teamMemberKey(site.ownerId, userId));
      if (member && !member.removedAt) {
        return cloneRecord({
          ...site,
          managementRole: member.role,
        });
      }
    }
    return null;
  }

  accessKeyCanSeeSite(actor, site) {
    if (actor.siteId && !actor.ownerType && !actor.ownerId && !actor.userId) return actor.siteId === site.id;
    const ownerType = actor.ownerType || 'user';
    if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === actor.ownerId;
    const ownerUserId = actor.ownerId || actor.userId;
    if ((site.ownerType || 'user') === 'user') return (site.ownerId || site.ownerUserId) === ownerUserId;
    if (site.ownerType === 'team') {
      const member = this.teamMembers.get(teamMemberKey(site.ownerId, ownerUserId));
      return Boolean(member && !member.removedAt);
    }
    return false;
  }

  decorateAccessKeySite(actor, site) {
    if ((actor.ownerType || 'user') !== 'user' || site.ownerType !== 'team') return site;
    const member = this.teamMembers.get(teamMemberKey(site.ownerId, actor.ownerId || actor.userId));
    return {
      ...site,
      managementRole: member?.role || null,
    };
  }

  async listConsoleDirectorySites({ environment, viewerUserId } = {}) {
    const siteIds = new Set();
    for (const site of this.sites.values()) {
      if (site.deletedAt) continue;
      if (environment && site.environment !== environment) continue;
      const route = this.routes.get(this.routeBySiteId.get(site.id));
      if (route?.visibility === 'internal' || site.defaultVisibility === 'internal') siteIds.add(site.id);
    }
    if (viewerUserId) {
      for (const site of await this.listSitesForUser(viewerUserId, { type: 'user', userId: viewerUserId }, environment)) {
        siteIds.add(site.id);
      }
      for (const site of await this.listTeamOwnedSitesForUser({ environment, userId: viewerUserId })) {
        siteIds.add(site.id);
      }
    }
    return cloneRecord(
      [...siteIds]
        .map((siteId) => this.decorateDirectorySite(this.siteWithRoute(siteId)))
        .filter(Boolean)
        .sort((left, right) => left.slug.localeCompare(right.slug))
    );
  }

  async listWorkspaceSites({ environment, userId, ownerFilter, teamId } = {}) {
    if (ownerFilter === 'team') return this.listTeamOwnedSitesForUser({ environment, userId, teamId });
    const sites = await this.listSitesForUser(userId, { type: 'user', userId }, environment);
    return sites.filter((site) => (site.ownerType || 'user') === 'user' && (site.ownerId || site.ownerUserId) === userId);
  }

  async listTeamOwnedSitesForUser({ environment, userId, teamId } = {}) {
    const teams = await this.listTeamsForUser({ environment, userId });
    const teamsById = new Map(teams.map((team) => [team.id, team]));
    return cloneRecord(
      [...this.sites.values()]
        .filter((site) => !site.deletedAt)
        .filter((site) => !environment || site.environment === environment)
        .filter((site) => site.ownerType === 'team' && teamsById.has(site.ownerId))
        .filter((site) => !teamId || site.ownerId === teamId)
        .map((site) => this.decorateTeamSite(site, teamsById.get(site.ownerId)))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    );
  }

  async getConsoleSiteDetail({ environment, userId, siteId } = {}) {
    const rawSite = this.sites.get(siteId) || null;
    if (!rawSite || rawSite.deletedAt) return null;
    if (environment && rawSite.environment !== environment) return null;
    const site = this.siteWithRoute(siteId);
    if ((site.ownerType || 'user') === 'team') {
      const member = await this.getTeamMember({ teamId: site.ownerId, userId });
      if (!member) return null;
      const team = this.teams.get(site.ownerId);
      if (!team || team.deletedAt || team.status !== 'active') return null;
      return {
        ...site,
        ownerType: 'team',
        ownerDisplayName: team.name,
        ownerTeamType: team.teamType,
        ownerTeamId: team.id,
        currentUserId: userId,
        managementRole: member.role,
      };
    }
    if ((site.ownerId || site.ownerUserId) !== userId) return null;
    return {
      ...site,
      ownerType: 'user',
      ownerDisplayName: null,
      currentUserId: userId,
      managementRole: 'admin',
    };
  }

  async listConsoleSiteDeployments({ environment, userId, siteId } = {}) {
    const site = await this.getConsoleSiteDetail({ environment, userId, siteId });
    if (!site) return [];
    return cloneRecord(
      [...this.deployments.values()]
        .filter((deployment) => deployment.siteId === siteId)
        .filter((deployment) => !environment || deployment.environment === environment)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    );
  }

  async listSiteMembers(siteId) {
    return cloneRecord(this.siteMembers.get(siteId) || []);
  }

  async addSiteMember(input) {
    const members = this.siteMembers.get(input.siteId) || [];
    members.push({
      siteId: input.siteId,
      userId: input.userId,
      role: input.role,
      createdBy: input.createdBy,
      createdAt: input.createdAt || this.now(),
    });
    this.siteMembers.set(input.siteId, members);
    return cloneRecord(members.at(-1));
  }

  async listSiteAclEntries(siteId) {
    return cloneRecord(this.siteAclEntries.get(siteId) || []);
  }

  async getRouteBySiteId(siteId, environment) {
    const route = this.routes.get(this.routeBySiteId.get(siteId)) || null;
    if (environment && route?.environment !== environment) return null;
    return cloneRecord(route);
  }

  async updateSiteVisibility(siteId, { visibility, updatedAt }, environment) {
    const site = this.sites.get(siteId);
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    if (!site || !route) return null;
    if (environment && route.environment !== environment) return null;

    site.defaultVisibility = visibility;
    site.updatedAt = updatedAt || this.now();
    route.visibility = visibility;
    route.policyVersion += 1;
    route.cacheTier = cacheTierForVisibility(visibility);
    route.updatedAt = updatedAt || this.now();
    return cloneRecord(route);
  }

  async deleteSite(siteId, { deletedAt, reuseHoldUntil, releaseReason = 'site_deleted' } = {}, environment) {
    const site = this.sites.get(siteId);
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    if (!site || site.deletedAt || !route) return null;
    if (environment && site.environment !== environment) return null;

    const now = deletedAt || this.now();
    site.deletedAt = now;
    site.updatedAt = now;
    this.siteSlugIndex.delete(`${site.environment}:${site.slug}`);
    route.routeStatus = 'deleted';
    route.runtime = 'disabled';
    route.activeVersionId = null;
    route.workerName = null;
    route.dispatchType = null;
    route.dispatchBindingName = null;
    route.slotId = null;
    route.routeGeneration += 1;
    route.updatedAt = now;

    const claim = this.hostnameClaims.get(route.hostname);
    if (
      claim &&
      claim.ownerSystem === 'v2' &&
      claim.ownerId === site.id &&
      ['pending', 'active', 'held'].includes(claim.status)
    ) {
      claim.status = 'held';
      claim.releasedAt = now;
      claim.reuseHoldUntil = reuseHoldUntil || null;
      claim.releaseReason = releaseReason;
      claim.updatedAt = now;
    }

    return cloneRecord(site);
  }

  async restoreSiteVisibility(siteId, previousSite, previousRoute, environment) {
    return this.restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, null, environment);
  }

  async restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, expectedRoute, environment) {
    const site = this.sites.get(siteId);
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    if (!site || !route || !previousRoute) return null;
    if (environment && route.environment !== environment) return null;
    if (expectedRoute && !routesMatchIgnoringRuntimeConfigGeneration(route, expectedRoute)) return cloneRecord(route);

    site.defaultVisibility = previousSite.defaultVisibility;
    site.updatedAt = previousSite.updatedAt;
    Object.assign(route, routeWithLatestRuntimeConfig(cloneRecord(previousRoute), route));
    return cloneRecord(route);
  }

  async replaceSiteAclEntries(siteId, entries, { createdBy, updatedAt }, environment) {
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    const site = this.sites.get(siteId);
    if (!site || !route) return [];
    if (environment && route.environment !== environment) return [];

    const now = updatedAt || this.now();
    const nextEntries = entries.map((entry) => ({
      id: entry.id,
      siteId,
      subjectType: entry.subjectType,
      subjectValue: entry.subjectValue,
      accessRole: entry.accessRole,
      effect: entry.effect,
      createdBy,
      createdAt: now,
    }));
    this.siteAclEntries.set(siteId, nextEntries);
    site.updatedAt = now;
    route.policyVersion += 1;
    route.updatedAt = now;
    return cloneRecord(nextEntries);
  }

  async addSiteAclEntries(siteId, entries, { createdBy, updatedAt }, environment) {
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    const site = this.sites.get(siteId);
    if (!site || !route) return [];
    if (environment && route.environment !== environment) return [];

    const existing = this.siteAclEntries.get(siteId) || [];
    const existingKeys = new Set(existing.map(siteAclEntryKey));
    const now = updatedAt || this.now();
    const nextEntries = [...existing];
    for (const entry of entries) {
      if (existingKeys.has(siteAclEntryKey(entry))) continue;
      existingKeys.add(siteAclEntryKey(entry));
      nextEntries.push({
        id: entry.id,
        siteId,
        subjectType: entry.subjectType,
        subjectValue: entry.subjectValue,
        accessRole: entry.accessRole,
        effect: entry.effect,
        createdBy,
        createdAt: now,
      });
    }
    if (nextEntries.length === existing.length) return cloneRecord(existing);

    this.siteAclEntries.set(siteId, nextEntries);
    site.updatedAt = now;
    route.policyVersion += 1;
    route.updatedAt = now;
    return cloneRecord(nextEntries);
  }

  async removeSiteAclEntries(siteId, entries, { updatedAt }, environment) {
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    const site = this.sites.get(siteId);
    if (!site || !route) return [];
    if (environment && route.environment !== environment) return [];

    const removedKeys = new Set(entries.map(siteAclEntryKey));
    const existing = this.siteAclEntries.get(siteId) || [];
    const nextEntries = existing.filter((entry) => !removedKeys.has(siteAclEntryKey(entry)));
    if (nextEntries.length === existing.length) return cloneRecord(existing);

    const now = updatedAt || this.now();
    this.siteAclEntries.set(siteId, nextEntries);
    site.updatedAt = now;
    route.policyVersion += 1;
    route.updatedAt = now;
    return cloneRecord(nextEntries);
  }

  async restoreSiteAclEntries(siteId, previousEntries, previousRoute, previousSite, environment) {
    return this.restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, null, environment);
  }

  async restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, expectedRoute, environment) {
    const site = this.sites.get(siteId);
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    if (!site || !route || !previousRoute) return [];
    if (environment && route.environment !== environment) return [];
    if (expectedRoute && !routesMatchIgnoringRuntimeConfigGeneration(route, expectedRoute)) {
      return cloneRecord(this.siteAclEntries.get(siteId) || []);
    }

    this.siteAclEntries.set(siteId, cloneRecord(previousEntries));
    site.updatedAt = previousSite.updatedAt;
    Object.assign(route, routeWithLatestRuntimeConfig(cloneRecord(previousRoute), route));
    return cloneRecord(previousEntries);
  }

  async createSiteVersion(input) {
    if (this.siteVersions.has(input.id)) throw new Error('VERSION_EXISTS');
    validateResolvedDeploymentMetadata(input);
    const record = {
      id: input.id,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      workerName: input.workerName,
      runtime: input.runtime,
      executionProvider: input.executionProvider || executionProviderFromRuntime(input.runtime),
      dispatchType: input.dispatchType || dispatchTypeFromExecutionProvider(input.executionProvider || input.runtime),
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
      createdAt: this.now(),
    };
    this.siteVersions.set(record.id, record);
    return cloneRecord(record);
  }

  async putSiteSecret(input) {
    return this.putSiteSecretRecord(input);
  }

  async putSiteSecretWithAudit(input) {
    if (this.failAuditWrites) throw new Error('AUDIT_WRITE_FAILED');
    const secret = this.buildSiteSecretRecord(input);
    await this.recordAuditEvent(secretAuditEvent(input, 'site_secret.put', secret, input.updatedAt || this.now()));
    this.siteSecrets.set(siteSecretKey(input.environment, input.siteId, input.name), secret);
    this.bumpRuntimeConfigGeneration(input.environment, input.siteId, input.updatedAt || this.now());
    return cloneRecord(secret);
  }

  putSiteSecretRecord(input) {
    const record = this.buildSiteSecretRecord(input);
    this.siteSecrets.set(siteSecretKey(input.environment, input.siteId, input.name), record);
    this.bumpRuntimeConfigGeneration(input.environment, input.siteId, input.updatedAt || this.now());
    return cloneRecord(record);
  }

  buildSiteSecretRecord(input) {
    const key = siteSecretKey(input.environment, input.siteId, input.name);
    const existing = this.siteSecrets.get(key);
    const now = input.updatedAt || this.now();
    const revision = this.nextSiteSecretRevision(input.environment, input.siteId, input.name) + 1;
    const record = {
      id: input.id || existing?.id,
      environment: input.environment,
      siteId: input.siteId,
      name: input.name,
      value: input.value,
      revision,
      createdBy: input.actorId || input.createdBy,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      deletedAt: null,
    };
    return record;
  }

  nextSiteSecretRevision(environment, siteId, name) {
    let revision = 0;
    for (const secret of this.siteSecrets.values()) {
      if (secret.environment !== environment || secret.siteId !== siteId || secret.name !== name) continue;
      revision = Math.max(revision, Number(secret.revision || 0));
    }
    return revision;
  }

  async deleteSiteSecret(environment, siteId, name, { deletedAt } = {}) {
    return this.deleteSiteSecretRecord(environment, siteId, name, { deletedAt });
  }

  async deleteSiteSecretWithAudit(input) {
    if (this.failAuditWrites) throw new Error('AUDIT_WRITE_FAILED');
    const secret = this.buildDeletedSiteSecretRecord(input.environment, input.siteId, input.name, { deletedAt: input.deletedAt });
    await this.recordAuditEvent(
      secretAuditEvent(input, 'site_secret.delete', secret || { name: input.name }, input.deletedAt || this.now())
    );
    if (secret) {
      this.siteSecrets.set(siteSecretKey(input.environment, input.siteId, input.name), secret);
      this.bumpRuntimeConfigGeneration(input.environment, input.siteId, input.deletedAt || this.now());
    }
    return cloneRecord(secret);
  }

  deleteSiteSecretRecord(environment, siteId, name, { deletedAt } = {}) {
    const record = this.buildDeletedSiteSecretRecord(environment, siteId, name, { deletedAt });
    if (!record) return null;
    this.siteSecrets.set(siteSecretKey(environment, siteId, name), record);
    this.bumpRuntimeConfigGeneration(environment, siteId, deletedAt || this.now());
    return cloneRecord(record);
  }

  buildDeletedSiteSecretRecord(environment, siteId, name, { deletedAt } = {}) {
    const key = siteSecretKey(environment, siteId, name);
    const existing = this.siteSecrets.get(key);
    if (!existing || existing.deletedAt) return null;
    const record = cloneRecord(existing);
    record.deletedAt = deletedAt || this.now();
    record.updatedAt = record.deletedAt;
    return record;
  }

  bumpRuntimeConfigGeneration(environment, siteId, updatedAt) {
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    if (!route || route.environment !== environment) throw new Error('SITE_ROUTE_NOT_FOUND');
    route.runtimeConfigGeneration = (route.runtimeConfigGeneration || 0) + 1;
    route.updatedAt = updatedAt || this.now();
  }

  async listEnabledSiteSecrets(environment, siteId) {
    return cloneRecord(
      [...this.siteSecrets.values()]
        .filter((secret) => secret.environment === environment && secret.siteId === siteId && !secret.deletedAt)
        .sort((left, right) => left.name.localeCompare(right.name))
    );
  }

  async listEnabledSiteVars(environment, siteId) {
    return cloneRecord(this.listEnabledSiteVarsSync(environment, siteId));
  }

  listEnabledSiteVarsSync(environment, siteId) {
    return [...this.siteVars.values()]
      .filter((entry) => entry.environment === environment && entry.siteId === siteId && !entry.deletedAt)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async replaceSiteVars(input) {
    const existing = this.listEnabledSiteVarsSync(input.environment, input.siteId);
    const existingByName = new Map(existing.map((entry) => [entry.name, entry]));
    const vars = input.vars || {};
    const desiredNames = Object.keys(vars).sort();
    const existingNames = existing.map((entry) => entry.name).sort();
    const hasChanges =
      desiredNames.length !== existingNames.length ||
      desiredNames.some((name) => {
        const record = existingByName.get(name);
        return !record || record.value !== vars[name];
      });
    if (!hasChanges) return cloneRecord(existing);

    const now = input.updatedAt || this.now();
    for (const name of desiredNames) {
      const current = existingByName.get(name);
      if (current && current.value === vars[name]) continue;
      const record = {
        id: current?.id || input.createId?.(name) || `var_${this.siteVars.size + 1}`,
        environment: input.environment,
        siteId: input.siteId,
        name,
        value: vars[name],
        revision: this.nextSiteVarRevision(input.environment, input.siteId, name) + 1,
        createdBy: current?.createdBy || input.actorId || input.createdBy,
        createdAt: current?.createdAt || now,
        updatedAt: now,
        deletedAt: null,
      };
      this.siteVars.set(siteVarKey(input.environment, input.siteId, name), record);
      this.siteVarHistory.set(siteVarHistoryKey(input.environment, input.siteId, name, record.id), cloneRecord(record));
    }
    for (const name of existingNames) {
      if (desiredNames.includes(name)) continue;
      const current = this.siteVars.get(siteVarKey(input.environment, input.siteId, name));
      if (!current || current.deletedAt) continue;
      current.deletedAt = now;
      current.updatedAt = now;
      this.siteVarHistory.set(siteVarHistoryKey(input.environment, input.siteId, name, current.id), cloneRecord(current));
    }
    this.bumpRuntimeConfigGeneration(input.environment, input.siteId, now);
    return cloneRecord(this.listEnabledSiteVarsSync(input.environment, input.siteId));
  }

  nextSiteVarRevision(environment, siteId, name) {
    let revision = 0;
    for (const entry of [...this.siteVars.values(), ...this.siteVarHistory.values()]) {
      if (entry.environment !== environment || entry.siteId !== siteId || entry.name !== name) continue;
      revision = Math.max(revision, Number(entry.revision || 0));
    }
    return revision;
  }

  async recordAuditEvent(input) {
    if (this.failAuditWrites) throw new Error('AUDIT_WRITE_FAILED');
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
      metadata: cloneRecord(input.metadata || null),
      createdAt: input.createdAt || this.now(),
    };
    this.auditEvents.push(record);
    return cloneRecord(record);
  }

  async listAuditEvents({ environment } = {}) {
    const events = environment ? this.auditEvents.filter((event) => event.environment === environment) : this.auditEvents;
    return cloneRecord(events);
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
      updatedAt,
    },
    environment,
    expectedRoute = null
  ) {
    const routeId = this.routeBySiteId.get(siteId);
    const route = this.routes.get(routeId);
    if (!route) return null;
    if (environment && route.environment !== environment) return null;
    if (expectedRoute && !routeActivationMatches(route, expectedRoute)) return null;
    route.activeVersionId = activeVersionId;
    route.workerName = workerName;
    route.visibility = visibility;
    route.runtime = runtime;
    route.executionProvider = executionProvider;
    route.dispatchType = dispatchType;
    route.dispatchBindingName = dispatchBindingName;
    route.slotId = slotId;
    route.routeStatus = 'active';
    route.routeGeneration += 1;
    route.updatedAt = updatedAt;
    return cloneRecord(route);
  }

  async restoreSiteRoute(siteId, previousRoute, environment) {
    const routeId = this.routeBySiteId.get(siteId);
    const route = this.routes.get(routeId);
    if (!route || !previousRoute) return null;
    if (environment && route.environment !== environment) return null;
    Object.assign(route, cloneRecord(previousRoute));
    return cloneRecord(route);
  }

  async restoreSiteRouteIfCurrent(siteId, previousRoute, expectedRoute, environment) {
    const routeId = this.routeBySiteId.get(siteId);
    const route = this.routes.get(routeId);
    if (!route || !previousRoute) return null;
    if (environment && route.environment !== environment) return null;
    if (!routesMatchExecutionState(route, expectedRoute)) return cloneRecord(route);
    Object.assign(route, routeRestoredAsNewCommit(cloneRecord(previousRoute), route));
    return cloneRecord(route);
  }

  async getSiteVersion(id, environment) {
    const version = this.siteVersions.get(id) || null;
    const site = version ? this.sites.get(version.siteId) : null;
    if (environment && site?.environment !== environment) return null;
    return cloneRecord(version);
  }

  async createWorkerSlot(input) {
    if (this.workerSlots.has(input.id)) throw new Error('WORKER_SLOT_EXISTS');
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
    this.workerSlots.set(record.id, record);
    return cloneRecord(record);
  }

  async getWorkerSlot(id) {
    return cloneRecord(this.workerSlots.get(id) || null);
  }

  async listWorkerSlots(environment) {
    return cloneRecord(
      [...this.workerSlots.values()]
        .filter((slot) => slot.environment === environment)
        .sort((left, right) => left.slotNumber - right.slotNumber)
    );
  }

  async assignAvailableWorkerSlot({ environment, siteId, routeId, versionId, assignedAt }) {
    const slot = [...this.workerSlots.values()]
      .filter((candidate) => candidate.environment === environment && candidate.status === 'available')
      .sort((left, right) => left.slotNumber - right.slotNumber)[0];
    if (!slot) return null;
    const now = assignedAt || this.now();
    slot.status = 'assigned';
    slot.assignedSiteId = siteId;
    slot.assignedRouteId = routeId;
    slot.assignedVersionId = versionId;
    slot.assignedAt = now;
    slot.lastDeployedVersionId = versionId;
    slot.updatedAt = now;
    return cloneRecord(slot);
  }

  async releaseWorkerSlot(id, { status = 'available', updatedAt } = {}) {
    const slot = this.workerSlots.get(id);
    if (!slot) return null;
    slot.status = status;
    slot.assignedSiteId = null;
    slot.assignedRouteId = null;
    slot.assignedVersionId = null;
    slot.assignedAt = null;
    slot.updatedAt = updatedAt || this.now();
    return cloneRecord(slot);
  }

  async markWorkerSlotCleanupPending(id, { expectedVersionId, updatedAt } = {}) {
    const slot = this.workerSlots.get(id);
    if (!slot || slot.status !== 'assigned' || slot.assignedVersionId !== expectedVersionId) return null;
    if (this.activeRouteReferencesSlot(slot)) return null;
    slot.status = 'cleanup_pending';
    slot.updatedAt = updatedAt || this.now();
    return cloneRecord(slot);
  }

  async releaseCleanupWorkerSlot(id, { expectedVersionId, updatedAt } = {}) {
    const slot = this.workerSlots.get(id);
    if (!slot || slot.status !== 'cleanup_pending' || slot.assignedVersionId !== expectedVersionId) return null;
    if (this.activeRouteReferencesSlot(slot)) return null;
    slot.status = 'available';
    slot.lastDeployedVersionId ||= expectedVersionId;
    slot.assignedSiteId = null;
    slot.assignedRouteId = null;
    slot.assignedVersionId = null;
    slot.assignedAt = null;
    slot.updatedAt = updatedAt || this.now();
    return cloneRecord(slot);
  }

  async createAccessKey(input) {
    if ('plaintext' in input) throw new Error('ACCESS_KEY_PLAINTEXT_FORBIDDEN');
    if (this.accessKeys.has(input.id)) throw new Error('ACCESS_KEY_EXISTS');
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
      createdAt: this.now(),
    };
    this.accessKeys.set(record.id, record);
    return cloneRecord(record);
  }

  async getAccessKeyById(id, environment) {
    const key = this.accessKeys.get(id) || null;
    if (environment && !this.accessKeyMatchesEnvironment(key, environment)) return null;
    return cloneRecord(key);
  }

  async listAccessKeysForOwner(ownerUserId, environment) {
    return cloneRecord(
      [...this.accessKeys.values()].filter((key) => {
        if ((key.ownerType || 'user') !== 'user') return false;
        if ((key.ownerId || key.ownerUserId) !== ownerUserId) return false;
        if (key.ownerUserId !== ownerUserId) return false;
        return this.accessKeyMatchesEnvironment(key, environment);
      })
    );
  }

  async listAccessKeys({ ownerType, ownerId, environment } = {}) {
    return cloneRecord(
      [...this.accessKeys.values()]
        .filter((key) => {
          if (ownerType && (key.ownerType || 'user') !== ownerType) return false;
          if (ownerId && (key.ownerId || key.ownerUserId) !== ownerId) return false;
          return this.accessKeyMatchesEnvironment(key, environment);
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    );
  }

  accessKeyMatchesEnvironment(key, environment) {
    if (!environment) return true;
    if (!key) return false;
    if (key.environment) return key.environment === environment;
    if (key.siteId) return this.sites.get(key.siteId)?.environment === environment;
    return false;
  }

  async updateAccessKeyLastUsed(id, lastUsedAt) {
    const record = this.accessKeys.get(id);
    if (!record) return null;
    record.lastUsedAt = lastUsedAt;
    return cloneRecord(record);
  }

  async revokeAccessKey(id, revokedAt, { revokedByUserId = null, revokedReason = null } = {}) {
    const record = this.accessKeys.get(id);
    if (!record) return null;
    record.revokedAt = revokedAt;
    record.revokedByUserId = revokedByUserId;
    record.revokedReason = revokedReason;
    return cloneRecord(record);
  }

  async getDeployment(id, environment) {
    const deployment = this.deployments.get(id) || null;
    if (environment && deployment?.environment !== environment) return null;
    return cloneRecord(deployment);
  }

  async updateDeployment(id, patch) {
    const record = this.deployments.get(id);
    if (!record) return null;
    Object.assign(record, patch);
    return cloneRecord(record);
  }

  async createDeploymentForIdempotency(input) {
    const scope = deploymentIdempotencyScope(input);
    const key = `${scope}:${input.idempotencyKey}`;
    const existingId = this.deploymentIdempotencyIndex.get(key);
    if (existingId) {
      const deployment = this.deployments.get(existingId);
      if (deployment.requestHash !== input.requestHash) return { kind: 'conflict', deployment: cloneRecord(deployment) };
      return { kind: 'existing', deployment: cloneRecord(deployment) };
    }

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
      idempotencyScope: scope,
      requestHash: input.requestHash,
      terminalResponseJson: input.terminalResponseJson || null,
      previousVersionId: input.previousVersionId || null,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      createdAt: this.now(),
      completedAt: input.completedAt || null,
    };
    this.deployments.set(record.id, record);
    this.deploymentIdempotencyIndex.set(key, record.id);
    return { kind: 'created', deployment: cloneRecord(record) };
  }

  siteWithRoute(siteId) {
    const site = this.sites.get(siteId);
    if (!site) return null;
    return {
      ...site,
      route: this.routes.get(this.routeBySiteId.get(siteId)) || null,
    };
  }

  decorateTeamSite(site, team) {
    return {
      ...this.siteWithRoute(site.id),
      ownerType: 'team',
      ownerDisplayName: team.name,
      ownerTeamType: team.teamType,
      ownerTeamId: team.id,
      managementRole: team.currentUserRole,
    };
  }

  decorateDirectorySite(site) {
    if (!site) return null;
    if ((site.ownerType || 'user') === 'team') {
      const team = this.teams.get(site.ownerId);
      return {
        ...site,
        ownerDisplayName: team?.name || null,
        ownerTeamType: team?.teamType || null,
        ownerTeamId: team?.id || null,
      };
    }
    const user = this.users.get(site.ownerId || site.ownerUserId);
    return {
      ...site,
      ownerDisplayName: user?.realname || null,
    };
  }

  decorateAdminSite(site) {
    if (!site) return null;
    if ((site.ownerType || 'user') === 'team') {
      const team = this.teams.get(site.ownerId);
      return {
        ...site,
        ownerDisplayName: team?.name || null,
        ownerTeamType: team?.teamType || null,
        ownerDepartmentPath: team?.departmentPath || null,
      };
    }
    const user = this.users.get(site.ownerId || site.ownerUserId);
    return {
      ...site,
      ownerEmail: user?.email || null,
      ownerDisplayName: user?.realname || null,
    };
  }

  activeRouteReferencesSlot(slot) {
    for (const route of this.routes.values()) {
      if (route.environment !== slot.environment || route.routeStatus !== 'active') continue;
      if (route.slotId === slot.id || route.activeVersionId === slot.assignedVersionId) return true;
    }
    return false;
  }

  findConflictingHostnameClaimSync(input) {
    const now = input.now || this.now();
    for (const claim of this.hostnameClaims.values()) {
      if (claim.environment !== input.environment) continue;
      if (claim.normalizedSlug !== input.normalizedSlug) continue;
      if (!isBlockingHostnameClaim(claim, now)) continue;
      if (input.excludeHostname && claim.hostname === input.excludeHostname) continue;
      return claim;
    }
    return null;
  }

  findHostnameClaimForOwnerSync(input) {
    const now = input.now || this.now();
    for (const claim of this.hostnameClaims.values()) {
      if (claim.environment !== input.environment) continue;
      if (claim.normalizedSlug !== input.normalizedSlug) continue;
      if (claim.ownerSystem !== input.ownerSystem || claim.ownerId !== input.ownerId) continue;
      if (!isBlockingHostnameClaim(claim, now)) continue;
      return claim;
    }
    return null;
  }
}

function teamMemberKey(teamId, userId) {
  return `${teamId}:${userId}`;
}

function platformAdminKey(environment, userId) {
  return `${environment}:${userId}`;
}

function normalizeDepartmentPath(value) {
  return typeof value === 'string'
    ? value
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
        .join('/')
    : '';
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
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) return `${prefix}_test`;
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
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

function resolveSsoEmployeeStatus(existingStatus, incomingStatus) {
  if (existingStatus === 'left' && incomingStatus !== 'left') return existingStatus;
  if (existingStatus === 'disabled' && (incomingStatus === 'active' || incomingStatus === 'unknown')) {
    return existingStatus;
  }
  return incomingStatus;
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

function hostnameClaimOwnerMatches(existing, input) {
  return existing.ownerSystem === input.ownerSystem && existing.ownerId === input.ownerId;
}

function isBlockingHostnameClaim(claim, now) {
  if (['pending', 'active', 'conflicted'].includes(claim.status)) return true;
  if (claim.status !== 'held') return false;
  return !claim.reuseHoldUntil || claim.reuseHoldUntil > now;
}

function siteAclEntryKey(entry) {
  return `${entry.effect}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole}`;
}

function siteSecretKey(environment, siteId, name) {
  return `${environment}:${siteId}:${name}`;
}

function siteVarKey(environment, siteId, name) {
  return `${environment}:${siteId}:${name}`;
}

function siteVarHistoryKey(environment, siteId, name, id) {
  return `${environment}:${siteId}:${name}:${id}`;
}

function validateResolvedDeploymentMetadata(input) {
  if (!input.deploymentShape || !input.requestedFallback || !input.routingMode) {
    throw new Error('VERSION_DEPLOYMENT_METADATA_REQUIRED');
  }
}

function routeActivationMatches(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.activeVersionId === expected.activeVersionId &&
    actual.routeGeneration === expected.routeGeneration &&
    actual.policyVersion === expected.policyVersion &&
    (actual.runtimeConfigGeneration || 0) === (expected.runtimeConfigGeneration || 0)
  );
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
