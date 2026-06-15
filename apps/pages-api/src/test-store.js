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

  async listSitesForUser(userId, actor = {}) {
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
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    );
  }

  async getSiteForUser(siteId, userId, actor = {}) {
    if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return null;
    const members = this.siteMembers.get(siteId) || [];
    if (actor.type !== 'access_key' && !members.some((member) => member.userId === userId)) return null;
    return cloneRecord(this.siteWithRoute(siteId));
  }

  async listSiteMembers(siteId) {
    return cloneRecord(this.siteMembers.get(siteId) || []);
  }

  async getRouteBySiteId(siteId) {
    return cloneRecord(this.routes.get(this.routeBySiteId.get(siteId)) || null);
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

  async getSiteVersion(id) {
    return cloneRecord(this.siteVersions.get(id) || null);
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

  async getAccessKeyById(id) {
    return cloneRecord(this.accessKeys.get(id) || null);
  }

  async listAccessKeysForOwner(ownerUserId) {
    return cloneRecord([...this.accessKeys.values()].filter((key) => key.ownerUserId === ownerUserId));
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

  async getDeployment(id) {
    return cloneRecord(this.deployments.get(id) || null);
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
