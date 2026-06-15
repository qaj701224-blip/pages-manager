import { cloneRecord, createInitialRoute, createOwnerMember, deploymentIdempotencyScope } from './store.js';

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
    this.siteVersions = new Map();
    this.accessKeys = new Map();
    this.deployments = new Map();
    this.deploymentIdempotencyIndex = new Map();
  }

  async createUser(input) {
    const now = this.now();
    const record = {
      id: input.id,
      ssoSubject: input.ssoSubject,
      email: input.email,
      name: input.name || null,
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

  async getRouteBySiteId(siteId, environment) {
    const route = this.routes.get(this.routeBySiteId.get(siteId)) || null;
    if (environment && route?.environment !== environment) return null;
    return cloneRecord(route);
  }

  async createSiteVersion(input) {
    if (this.siteVersions.has(input.id)) throw new Error('VERSION_EXISTS');
    const record = {
      id: input.id,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      workerName: input.workerName,
      runtime: input.runtime,
      artifactKind: input.artifactKind,
      artifactRef: input.artifactRef,
      contentHash: input.contentHash,
      createdBy: input.createdBy,
      createdAt: this.now(),
    };
    this.siteVersions.set(record.id, record);
    return cloneRecord(record);
  }

  async activateSiteVersion(siteId, { activeVersionId, workerName, visibility, updatedAt }, environment) {
    const routeId = this.routeBySiteId.get(siteId);
    const route = this.routes.get(routeId);
    if (!route) return null;
    if (environment && route.environment !== environment) return null;
    route.activeVersionId = activeVersionId;
    route.workerName = workerName;
    route.visibility = visibility;
    route.runtime = 'wfp';
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

  async getSiteVersion(id, environment) {
    const version = this.siteVersions.get(id) || null;
    const site = version ? this.sites.get(version.siteId) : null;
    if (environment && site?.environment !== environment) return null;
    return cloneRecord(version);
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
