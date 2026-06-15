export function createPagesStore(env = {}) {
  if (env.PAGES_STORE) return env.PAGES_STORE;
  if (!env.PAGES_METADATA) throw new Error('PAGES_METADATA binding is required');
  return new D1PagesStore(env.PAGES_METADATA);
}

export class D1PagesStore {
  constructor(db, { now = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.now = now;
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
    await this.db
      .prepare(
        `INSERT INTO users (
          id, sso_subject, email, name, employee_status, session_version,
          last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.ssoSubject,
        record.email,
        record.name,
        record.employeeStatus,
        record.sessionVersion,
        record.lastLoginAt,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(record);
  }

  async getUser(id) {
    const row = await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return row ? mapUser(row) : null;
  }

  async createSite(input) {
    const now = this.now();
    if (await this.findSiteBySlug(input.environment, input.slug)) throw new Error('SITE_SLUG_CONFLICT');

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
    const member = createOwnerMember(input.id, input.ownerUserId, now);

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO sites (
            id, slug, environment, owner_user_id, default_visibility, site_uuid,
            created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          site.id,
          site.slug,
          site.environment,
          site.ownerUserId,
          site.defaultVisibility,
          site.siteUuid,
          site.createdAt,
          site.updatedAt,
          site.deletedAt
        ),
      this.db
        .prepare(
          `INSERT INTO site_routes (
            id, hostname, site_id, environment, runtime, worker_name,
            active_version_id, visibility, policy_version, route_generation,
            route_status, cache_tier, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          route.id,
          route.hostname,
          route.siteId,
          route.environment,
          route.runtime,
          route.workerName,
          route.activeVersionId,
          route.visibility,
          route.policyVersion,
          route.routeGeneration,
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

    return cloneRecord(site);
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

  async listSiteMembers(siteId) {
    const result = await this.db.prepare('SELECT * FROM site_members WHERE site_id = ?').bind(siteId).all();
    return (result.results || []).map(mapSiteMember);
  }

  async getRouteBySiteId(siteId) {
    const row = await this.db.prepare('SELECT * FROM site_routes WHERE site_id = ?').bind(siteId).first();
    return row ? mapSiteRoute(row) : null;
  }

  async createSiteVersion(input) {
    const now = this.now();
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
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO site_versions (
          id, site_id, deployment_id, worker_name, runtime, artifact_kind,
          artifact_ref, content_hash, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.siteId,
        record.deploymentId,
        record.workerName,
        record.runtime,
        record.artifactKind,
        record.artifactRef,
        record.contentHash,
        record.createdBy,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  }

  async getSiteVersion(id) {
    const row = await this.db.prepare('SELECT * FROM site_versions WHERE id = ?').bind(id).first();
    return row ? mapSiteVersion(row) : null;
  }

  async createAccessKey(input) {
    if ('plaintext' in input) throw new Error('ACCESS_KEY_PLAINTEXT_FORBIDDEN');
    const now = this.now();
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
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO access_keys (
          id, owner_user_id, key_hash, pepper_id, name, scopes_json, site_id,
          expires_at, last_used_at, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.ownerUserId,
        record.keyHash,
        record.pepperId,
        record.name,
        JSON.stringify(record.scopes),
        record.siteId,
        record.expiresAt,
        record.lastUsedAt,
        record.revokedAt,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  }

  async getAccessKeyById(id) {
    const row = await this.db.prepare('SELECT * FROM access_keys WHERE id = ?').bind(id).first();
    return row ? mapAccessKey(row) : null;
  }

  async listAccessKeysForOwner(ownerUserId) {
    const result = await this.db
      .prepare('SELECT * FROM access_keys WHERE owner_user_id = ? ORDER BY created_at DESC')
      .bind(ownerUserId)
      .all();
    return (result.results || []).map(mapAccessKey);
  }

  async updateAccessKeyLastUsed(id, lastUsedAt) {
    await this.db.prepare('UPDATE access_keys SET last_used_at = ? WHERE id = ?').bind(lastUsedAt, id).run();
    return this.getAccessKeyById(id);
  }

  async revokeAccessKey(id, revokedAt) {
    await this.db.prepare('UPDATE access_keys SET revoked_at = ? WHERE id = ?').bind(revokedAt, id).run();
    return this.getAccessKeyById(id);
  }

  async getDeployment(id) {
    const row = await this.db.prepare('SELECT * FROM deployments WHERE id = ?').bind(id).first();
    return row ? mapDeployment(row) : null;
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
      createdAt: now,
      completedAt: input.completedAt || null,
    };
    await this.db
      .prepare(
        `INSERT INTO deployments (
          id, environment, site_id, version_id, actor_id, actor_user_id,
          actor_type, source, operation, visibility, status, idempotency_key,
          idempotency_scope, request_hash, terminal_response_json,
          previous_version_id, error_code, error_message, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.createdAt,
        record.completedAt
      )
      .run();
    return { kind: 'created', deployment: cloneRecord(record) };
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
    workerName: null,
    activeVersionId: null,
    visibility: input.defaultVisibility,
    policyVersion: 1,
    routeGeneration: 0,
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

export function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
}

function mapUser(row) {
  return {
    id: row.id,
    ssoSubject: row.sso_subject,
    email: row.email,
    name: row.name,
    employeeStatus: row.employee_status,
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
    ownerUserId: row.owner_user_id,
    defaultVisibility: row.default_visibility,
    siteUuid: row.site_uuid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapSiteRoute(row) {
  return {
    id: row.id,
    hostname: row.hostname,
    siteId: row.site_id,
    environment: row.environment,
    runtime: row.runtime,
    workerName: row.worker_name,
    activeVersionId: row.active_version_id,
    visibility: row.visibility,
    policyVersion: row.policy_version,
    routeGeneration: row.route_generation,
    routeStatus: row.route_status,
    cacheTier: row.cache_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function mapSiteVersion(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    deploymentId: row.deployment_id,
    workerName: row.worker_name,
    runtime: row.runtime,
    artifactKind: row.artifact_kind,
    artifactRef: row.artifact_ref,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapAccessKey(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    keyHash: row.key_hash,
    pepperId: row.pepper_id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json),
    siteId: row.site_id,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
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
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
