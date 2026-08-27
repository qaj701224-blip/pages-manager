import { cloneRecord, mapAccessKey } from '../store-support.js';

export const accessKeysRepositoryMethods = {
  async createAccessKey(input) {
    if ('plaintext' in input) throw new Error('ACCESS_KEY_PLAINTEXT_FORBIDDEN');
    const now = this.now();
    const ownerType = input.ownerType ?? 'user';
    const ownerId = input.ownerId ?? input.ownerUserId;
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
      issuedSource: input.issuedSource || 'legacy',
      issuedSessionVersion: input.issuedSessionVersion ?? null,
    };
    await this.accessKeyInsertStatement(record).run();
    return cloneRecord(record);
  },

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
  },

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
  },

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
  },

  async updateAccessKeyLastUsed(id, lastUsedAt) {
    await this.db.prepare('UPDATE access_keys SET last_used_at = ? WHERE id = ?').bind(lastUsedAt, id).run();
    return this.getAccessKeyById(id);
  },

  async revokeAccessKey(id, revokedAt, { revokedByUserId = null, revokedReason = null } = {}) {
    await this.db
      .prepare('UPDATE access_keys SET revoked_at = ?, revoked_by_user_id = ?, revoked_reason = ? WHERE id = ?')
      .bind(revokedAt, revokedByUserId, revokedReason, id)
      .run();
    return this.getAccessKeyById(id);
  },

  accessKeyInsertStatement(record) {
    return this.db
      .prepare(
        `INSERT INTO access_keys (
            id, environment, owner_user_id, key_hash, pepper_id, name, scopes_json, site_id,
            owner_type, owner_id, created_by_user_id, issued_source, issued_session_version,
            expires_at, last_used_at,
            revoked_at, revoked_by_user_id, revoked_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        record.issuedSource,
        record.issuedSessionVersion,
        record.expiresAt,
        record.lastUsedAt,
        record.revokedAt,
        record.revokedByUserId,
        record.revokedReason,
        record.createdAt
      );
  },
};
