import { mapSiteSecret, mapSiteSecretReadMetadata, mapSiteVar } from '../store-support.js';

export const runtimeConfigRepositoryMethods = {
  async getLiveSiteSecretRow(environment, siteId, name) {
    return this.db
      .prepare(
        `SELECT * FROM site_secrets
            WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL`
      )
      .bind(environment, siteId, name)
      .first();
  },

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
  },

  async listEnabledSiteSecretMetadata(environment, siteId) {
    const result = await this.db
      .prepare(
        `SELECT name, revision, updated_at FROM site_secrets
            WHERE environment = ? AND site_id = ? AND deleted_at IS NULL
            ORDER BY name ASC`
      )
      .bind(environment, siteId)
      .all();
    return (result.results || []).map(mapSiteSecretReadMetadata);
  },

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
  },

  async getRuntimeConfigRouteState(environment, siteId) {
    const row = await this.db
      .prepare(
        `SELECT runtime_config_generation, runtime_config_lock_id, runtime_config_lock_expires_at
            FROM site_routes
            WHERE environment = ? AND site_id = ?`
      )
      .bind(environment, siteId)
      .first();
    return row
      ? {
          runtimeConfigGeneration: row.runtime_config_generation || 0,
          runtimeConfigLockId: row.runtime_config_lock_id || null,
          runtimeConfigLockExpiresAt: row.runtime_config_lock_expires_at || null,
        }
      : null;
  },
};
