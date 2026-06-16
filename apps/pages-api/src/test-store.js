import {
  cacheTierForVisibility,
  cloneRecord,
  createInitialRoute,
  createOwnerMember,
  deploymentIdempotencyScope,
} from './store.js';

export function createTestPagesStore({ now = () => new Date().toISOString() } = {}) {
  return new TestPagesStore({ now });
}

class TestPagesStore {
  constructor({ now }) {
    this.now = now;
    this.users = new Map();
    this.sites = new Map();
    this.siteSlugIndex = new Map();
    this.routes = new Map();
    this.routeBySiteId = new Map();
    this.siteMembers = new Map();
    this.siteAclEntries = new Map();
    this.siteVersions = new Map();
    this.workerSlots = new Map();
    this.accessKeys = new Map();
    this.deployments = new Map();
    this.deploymentIdempotencyIndex = new Map();
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

  async createSite(input) {
    const slugKey = `${input.environment}:${input.slug}`;
    if (this.siteSlugIndex.has(slugKey)) throw new Error('SITE_SLUG_CONFLICT');
    if (this.routes.has(input.routeId)) throw new Error('ROUTE_EXISTS');

    const now = this.now();
    const site = {
      id: input.id,
      slug: input.slug,
      environment: input.environment,
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

    this.sites.set(site.id, site);
    this.siteSlugIndex.set(slugKey, site.id);
    this.routes.set(route.id, route);
    this.routeBySiteId.set(site.id, route.id);
    this.siteMembers.set(site.id, [owner]);
    this.siteAclEntries.set(site.id, []);

    return cloneRecord(site);
  }

  async findSiteBySlug(environment, slug) {
    return this.getSite(this.siteSlugIndex.get(`${environment}:${slug}`));
  }

  async getSite(id) {
    return cloneRecord(this.sites.get(id) || null);
  }

  async listSitesForUser(userId, actor = {}, environment) {
    const siteIds = new Set();
    if (actor.type === 'access_key' && actor.siteId) {
      siteIds.add(actor.siteId);
    } else {
      for (const [siteId, members] of this.siteMembers.entries()) {
        if (members.some((member) => member.userId === userId)) siteIds.add(siteId);
      }
    }

    return cloneRecord(
      [...siteIds]
        .map((siteId) => this.siteWithRoute(siteId))
        .filter(Boolean)
        .filter((site) => !environment || site.environment === environment)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    );
  }

  async getSiteForUser(siteId, userId, actor = {}, environment) {
    if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return null;
    const members = this.siteMembers.get(siteId) || [];
    if (actor.type !== 'access_key' && !members.some((member) => member.userId === userId)) return null;
    const site = this.siteWithRoute(siteId);
    if (environment && site?.environment !== environment) return null;
    return cloneRecord(site);
  }

  async listSiteMembers(siteId) {
    return cloneRecord(this.siteMembers.get(siteId) || []);
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

  async restoreSiteVisibility(siteId, previousSite, previousRoute, environment) {
    return this.restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, null, environment);
  }

  async restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, expectedRoute, environment) {
    const site = this.sites.get(siteId);
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    if (!site || !route || !previousRoute) return null;
    if (environment && route.environment !== environment) return null;
    if (expectedRoute && !routesMatch(route, expectedRoute)) return cloneRecord(route);

    site.defaultVisibility = previousSite.defaultVisibility;
    site.updatedAt = previousSite.updatedAt;
    Object.assign(route, cloneRecord(previousRoute));
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

  async restoreSiteAclEntries(siteId, previousEntries, previousRoute, previousSite, environment) {
    return this.restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, null, environment);
  }

  async restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, expectedRoute, environment) {
    const site = this.sites.get(siteId);
    const route = this.routes.get(this.routeBySiteId.get(siteId));
    if (!site || !route || !previousRoute) return [];
    if (environment && route.environment !== environment) return [];
    if (expectedRoute && !routesMatch(route, expectedRoute)) return cloneRecord(this.siteAclEntries.get(siteId) || []);

    this.siteAclEntries.set(siteId, cloneRecord(previousEntries));
    site.updatedAt = previousSite.updatedAt;
    Object.assign(route, cloneRecord(previousRoute));
    return cloneRecord(previousEntries);
  }

  async createSiteVersion(input) {
    if (this.siteVersions.has(input.id)) throw new Error('VERSION_EXISTS');
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
      artifactKind: input.artifactKind,
      artifactRef: input.artifactRef,
      contentHash: input.contentHash,
      createdBy: input.createdBy,
      createdAt: this.now(),
    };
    this.siteVersions.set(record.id, record);
    return cloneRecord(record);
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
    if (!routesMatch(route, expectedRoute)) return cloneRecord(route);
    Object.assign(route, cloneRecord(previousRoute));
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

  async createAccessKey(input) {
    if ('plaintext' in input) throw new Error('ACCESS_KEY_PLAINTEXT_FORBIDDEN');
    if (this.accessKeys.has(input.id)) throw new Error('ACCESS_KEY_EXISTS');
    const record = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      keyHash: input.keyHash,
      pepperId: input.pepperId,
      name: input.name,
      scopes: [...input.scopes],
      siteId: input.siteId || null,
      expiresAt: input.expiresAt || null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: this.now(),
    };
    this.accessKeys.set(record.id, record);
    return cloneRecord(record);
  }

  async getAccessKeyById(id, environment) {
    const key = this.accessKeys.get(id) || null;
    if (environment && key?.siteId) {
      const site = this.sites.get(key.siteId);
      if (site?.environment !== environment) return null;
    }
    return cloneRecord(key);
  }

  async listAccessKeysForOwner(ownerUserId, environment) {
    return cloneRecord(
      [...this.accessKeys.values()].filter((key) => {
        if (key.ownerUserId !== ownerUserId) return false;
        if (!environment || !key.siteId) return true;
        return this.sites.get(key.siteId)?.environment === environment;
      })
    );
  }

  async updateAccessKeyLastUsed(id, lastUsedAt) {
    const record = this.accessKeys.get(id);
    if (!record) return null;
    record.lastUsedAt = lastUsedAt;
    return cloneRecord(record);
  }

  async revokeAccessKey(id, revokedAt) {
    const record = this.accessKeys.get(id);
    if (!record) return null;
    record.revokedAt = revokedAt;
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
    actual.routeStatus === expected.routeStatus
  );
}

function routeActivationMatches(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.activeVersionId === expected.activeVersionId &&
    actual.routeGeneration === expected.routeGeneration &&
    actual.policyVersion === expected.policyVersion
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
