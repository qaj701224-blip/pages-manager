import {
  MAX_RUNTIME_VARS,
  RUNTIME_CONFIG_LOCK_RENEW_MS,
  RUNTIME_CONFIG_PROVIDER_TIMEOUT_MS,
  encryptSiteSecretValue,
  mapSiteSecretMetadata,
  markRuntimeConfigError,
  randomStoreId,
  runtimeConfigLockExpiry,
  runtimeVarObjectsEqual,
  runtimeVarsObject,
  secretAuditEvent,
  stringifyJsonColumn,
  validateRuntimeBindingQuotas,
} from '../store-support.js';

export const runtimeConfigMutationMethods = {
  async putSiteSecret(input) {
    const now = input.updatedAt || this.now();
    const encryptedValue = await encryptSiteSecretValue(input.value, this.secretEncryptionKey);
    const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
    const revision = (await this.nextSiteSecretRevision(input.environment, input.siteId, input.name)) + 1;
    const id = existing?.id || input.id;
    if (existing) {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE site_secrets
                SET encrypted_value = ?, revision = ?, updated_at = ?
                WHERE id = ? AND revision = ? AND deleted_at IS NULL`
          )
          .bind(encryptedValue, revision, now, existing.id, Number(existing.revision || 0)),
        this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
          secretId: id,
          revision,
          encryptedValue,
        }),
      ]);
      if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
        throw new Error('SITE_SECRET_REVISION_CONFLICT');
      }
    } else {
      const results = await this.db.batch([
        this.siteSecretInsertStatement({
          id,
          environment: input.environment,
          siteId: input.siteId,
          name: input.name,
          encryptedValue,
          revision,
          createdBy: input.actorId || input.createdBy,
          createdAt: now,
          updatedAt: now,
        }),
        this.bumpRuntimeConfigGenerationForPutStatement(input.environment, input.siteId, now, {
          secretId: id,
          revision,
          encryptedValue,
        }),
      ]);
      if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
        throw new Error('SITE_SECRET_REVISION_CONFLICT');
      }
    }
    return {
      id,
      environment: input.environment,
      siteId: input.siteId,
      name: input.name,
      value: input.value,
      revision,
      createdBy: input.actorId || input.createdBy,
      createdAt: existing?.created_at || now,
      updatedAt: now,
      deletedAt: null,
    };
  },

  async putSiteSecretWithAudit(input) {
    let diagnosticStage = 'unknown';
    try {
      const now = input.updatedAt || this.now();
      const encryptedValue = await encryptSiteSecretValue(input.value, this.secretEncryptionKey);
      const lockId = input.lockId || randomStoreId('runtime_lock');
      diagnosticStage = 'lock_acquire';
      const lock = await this.acquireRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
      if (lock?.meta?.changes !== 1) throw new Error('SITE_SECRET_REVISION_CONFLICT');

      let released = false;
      try {
        diagnosticStage = 'route_state_read';
        const routeState = await this.getRuntimeConfigRouteState(input.environment, input.siteId);
        if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('SITE_SECRET_REVISION_CONFLICT');
        diagnosticStage = 'bindings_read';
        const liveVars = await this.listEnabledSiteVars(input.environment, input.siteId);
        const liveSecrets = await this.listEnabledSiteSecrets(input.environment, input.siteId);
        const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
        diagnosticStage = 'revision_read';
        const revision = (await this.nextSiteSecretRevision(input.environment, input.siteId, input.name)) + 1;
        const id = existing?.id || input.id;
        validateRuntimeBindingQuotas(runtimeVarsObject(liveVars), [
          ...liveSecrets.filter((secret) => secret.name !== input.name),
          { name: input.name, value: input.value },
        ]);

        diagnosticStage = 'statement_build';
        const secretStatement = existing
          ? this.db
              .prepare(
                `UPDATE site_secrets
                    SET encrypted_value = ?, revision = ?, updated_at = ?
                    WHERE id = ? AND revision = ? AND deleted_at IS NULL`
              )
              .bind(encryptedValue, revision, now, existing.id, Number(existing.revision || 0))
          : this.siteSecretInsertStatement({
              id,
              environment: input.environment,
              siteId: input.siteId,
              name: input.name,
              encryptedValue,
              revision,
              createdBy: input.actorId || input.createdBy,
              createdAt: now,
              updatedAt: now,
            });
        const auditRecord = secretAuditEvent(input, 'site_secret.put', { name: input.name, revision }, now);
        const statements = [];
        this.pushRuntimeChangeStatement(statements, secretStatement, 'SITE_SECRET_REVISION_CONFLICT');
        this.pushRuntimeChangeStatement(
          statements,
          this.bumpRuntimeConfigGenerationAndReleaseLockStatement(input.environment, input.siteId, now, lockId),
          'SITE_SECRET_REVISION_CONFLICT'
        );
        this.pushRuntimeChangeStatement(
          statements,
          this.siteSecretPutAuditEventStatement(auditRecord, {
            secretId: id,
            revision,
            encryptedValue,
            updatedAt: now,
          }),
          'SITE_SECRET_REVISION_CONFLICT'
        );
        diagnosticStage = 'mutation_batch';
        await this.db.batch(statements);
        released = true;
        return {
          id,
          environment: input.environment,
          siteId: input.siteId,
          name: input.name,
          value: input.value,
          revision,
          createdBy: input.actorId || input.createdBy,
          createdAt: existing?.created_at || now,
          updatedAt: now,
          deletedAt: null,
        };
      } finally {
        if (!released) {
          try {
            await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
          } catch {
            // Best effort: the next runtime config operation will fail closed if the lock remains.
          }
        }
      }
    } catch (error) {
      throw markRuntimeConfigError(error, { stage: diagnosticStage });
    }
  },

  async nextSiteSecretRevision(environment, siteId, name) {
    const row = await this.db
      .prepare(
        `SELECT MAX(revision) AS max_revision FROM site_secrets
            WHERE environment = ? AND site_id = ? AND name = ?`
      )
      .bind(environment, siteId, name)
      .first();
    return Number(row?.max_revision || 0);
  },

  async deleteSiteSecret(environment, siteId, name, { deletedAt } = {}) {
    const now = deletedAt || this.now();
    const existing = await this.db
      .prepare(
        `SELECT * FROM site_secrets
            WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL`
      )
      .bind(environment, siteId, name)
      .first();
    if (!existing) return null;
    const results = await this.db.batch([
      this.db
        .prepare('UPDATE site_secrets SET deleted_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL')
        .bind(now, now, existing.id, Number(existing.revision || 0)),
      this.bumpRuntimeConfigGenerationForDeleteStatement(environment, siteId, now, {
        secretId: existing.id,
        revision: Number(existing.revision || 0),
        deletedAt: now,
      }),
    ]);
    if (results?.[0]?.meta?.changes !== 1 || results?.[1]?.meta?.changes !== 1) {
      throw new Error('SITE_SECRET_REVISION_CONFLICT');
    }
    return mapSiteSecretMetadata({ ...existing, deleted_at: now, updated_at: now });
  },

  async deleteSiteSecretWithAudit(input) {
    let diagnosticStage = 'lock_acquire';
    try {
      const now = input.deletedAt || this.now();
      const lockId = input.lockId || randomStoreId('runtime_lock');
      const lock = await this.acquireRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
      if (lock?.meta?.changes !== 1) throw new Error('SITE_SECRET_REVISION_CONFLICT');

      let released = false;
      try {
        diagnosticStage = 'route_state_read';
        const routeState = await this.getRuntimeConfigRouteState(input.environment, input.siteId);
        if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('SITE_SECRET_REVISION_CONFLICT');
        diagnosticStage = 'bindings_read';
        const existing = await this.getLiveSiteSecretRow(input.environment, input.siteId, input.name);
        const secret = existing ? mapSiteSecretMetadata({ ...existing, deleted_at: now, updated_at: now }) : null;
        const statements = [];
        if (!existing) {
          diagnosticStage = 'statement_build';
          this.pushRuntimeChangeStatement(
            statements,
            this.auditEventStatement(secretAuditEvent(input, 'site_secret.delete', { name: input.name }, now)),
            'SITE_SECRET_REVISION_CONFLICT'
          );
          this.pushRuntimeChangeStatement(
            statements,
            this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now),
            'SITE_SECRET_REVISION_CONFLICT'
          );
          diagnosticStage = 'mutation_batch';
          await this.db.batch(statements);
          released = true;
          return null;
        }

        const revision = Number(existing.revision || 0);
        diagnosticStage = 'statement_build';
        const auditRecord = secretAuditEvent(input, 'site_secret.delete', secret, now);
        this.pushRuntimeChangeStatement(
          statements,
          this.db
            .prepare(
              `UPDATE site_secrets
                  SET deleted_at = ?, updated_at = ?
                  WHERE id = ? AND revision = ? AND deleted_at IS NULL
                    AND EXISTS (
                      SELECT 1 FROM site_routes
                      WHERE environment = ? AND site_id = ?
                        AND runtime_config_lock_id = ?
                    )`
            )
            .bind(now, now, existing.id, revision, input.environment, input.siteId, lockId),
          'SITE_SECRET_REVISION_CONFLICT'
        );
        this.pushRuntimeChangeStatement(
          statements,
          this.bumpRuntimeConfigGenerationAndReleaseLockStatement(input.environment, input.siteId, now, lockId),
          'SITE_SECRET_REVISION_CONFLICT'
        );
        this.pushRuntimeChangeStatement(
          statements,
          this.siteSecretDeleteAuditEventStatement(auditRecord, {
            secretId: existing.id,
            revision,
            deletedAt: now,
          }),
          'SITE_SECRET_REVISION_CONFLICT'
        );
        diagnosticStage = 'mutation_batch';
        await this.db.batch(statements);
        released = true;
        return secret;
      } finally {
        if (!released) {
          try {
            await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
          } catch {
            // Best effort: the next runtime config operation will fail closed if the lock remains.
          }
        }
      }
    } catch (error) {
      throw markRuntimeConfigError(error, { stage: diagnosticStage });
    }
  },

  async mutateSiteVar(input) {
    let diagnosticStage = 'lock_acquire';
    try {
      const now = input.updatedAt || this.now();
      const lockId = input.lockId || randomStoreId('runtime_lock');
      const lock = await this.acquireRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
      if (lock?.meta?.changes !== 1) throw new Error('SITE_VAR_REVISION_CONFLICT');

      let released = false;
      try {
        diagnosticStage = 'route_state_read';
        const routeState = await this.getRuntimeConfigRouteState(input.environment, input.siteId);
        if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('SITE_VAR_REVISION_CONFLICT');
        diagnosticStage = 'bindings_read';
        const liveVars = await this.listEnabledSiteVars(input.environment, input.siteId);
        const liveSecrets = await this.listEnabledSiteSecrets(input.environment, input.siteId);
        const nextVars = runtimeVarsObject(liveVars);
        if (input.operation === 'delete') delete nextVars[input.name];
        else nextVars[input.name] = input.value;
        if (Object.keys(nextVars).length > MAX_RUNTIME_VARS) throw new Error('RUNTIME_VARS_LIMIT_EXCEEDED');
        validateRuntimeBindingQuotas(nextVars, liveSecrets);

        const existing = liveVars.find((record) => record.name === input.name) || null;
        if (runtimeVarObjectsEqual(runtimeVarsObject(liveVars), nextVars)) {
          diagnosticStage = 'statement_build';
          const releaseStatement = this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now);
          diagnosticStage = 'mutation_batch';
          const release = await releaseStatement.run();
          released = release?.meta?.changes === 1;
          if (!released) throw new Error('SITE_VAR_REVISION_CONFLICT');
          return {
            record: existing || { name: input.name },
            vars: liveVars,
            generation: routeState.runtimeConfigGeneration,
            changed: false,
          };
        }

        const statements = [];
        if (input.operation === 'delete') {
          diagnosticStage = 'statement_build';
          this.pushRuntimeChangeStatement(
            statements,
            this.siteVarDeleteStatement({
              environment: input.environment,
              siteId: input.siteId,
              existing,
              deletedAt: now,
              lockId,
            })
          );
        } else {
          diagnosticStage = 'revision_read';
          const revision = (await this.nextSiteVarRevision(input.environment, input.siteId, input.name)) + 1;
          diagnosticStage = 'statement_build';
          this.pushRuntimeChangeStatement(
            statements,
            existing
              ? this.siteVarUpdateStatement({
                  environment: input.environment,
                  siteId: input.siteId,
                  value: input.value,
                  revision,
                  updatedAt: now,
                  existing,
                  lockId,
                })
              : this.siteVarInsertStatement({
                  id: input.createId ? input.createId(input.name) : randomStoreId('var'),
                  environment: input.environment,
                  siteId: input.siteId,
                  name: input.name,
                  value: input.value,
                  revision,
                  createdBy: input.actorId || input.createdBy,
                  createdAt: now,
                  updatedAt: now,
                  lockId,
                })
          );
        }
        this.pushRuntimeChangeStatement(
          statements,
          this.bumpRuntimeConfigGenerationAndReleaseLockStatement(input.environment, input.siteId, now, lockId)
        );
        diagnosticStage = 'mutation_batch';
        await this.db.batch(statements);
        released = true;
        diagnosticStage = 'post_commit_read';
        const vars = await this.listEnabledSiteVars(input.environment, input.siteId);
        return {
          record: input.operation === 'delete' ? existing : vars.find((record) => record.name === input.name),
          vars,
          generation: routeState.runtimeConfigGeneration + 1,
          changed: true,
        };
      } finally {
        if (!released) {
          try {
            await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
          } catch {
            // Best effort: the next runtime config operation will fail closed if the lock remains.
          }
        }
      }
    } catch (error) {
      throw markRuntimeConfigError(error, { stage: diagnosticStage });
    }
  },

  async replaceSiteVars(input) {
    const now = input.updatedAt || this.now();
    const vars = input.vars || {};
    const lockId = input.lockId || randomStoreId('runtime_lock');
    const lock = await this.acquireRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
    if (lock?.meta?.changes !== 1) throw new Error('SITE_VAR_REVISION_CONFLICT');

    let released = false;
    try {
      const routeState = await this.getRuntimeConfigRouteState(input.environment, input.siteId);
      if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('SITE_VAR_REVISION_CONFLICT');
      const liveVars = await this.listEnabledSiteVars(input.environment, input.siteId);
      const liveByName = new Map(liveVars.map((record) => [record.name, record]));
      const desiredNames = Object.keys(vars).sort();
      const liveNames = [...liveByName.keys()].sort();
      const hasChanges =
        desiredNames.length !== liveNames.length ||
        desiredNames.some((name) => {
          const existing = liveByName.get(name);
          return !existing || existing.value !== vars[name];
        });
      if (!hasChanges) {
        const release = await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
        released = release?.meta?.changes === 1;
        if (!released) throw new Error('SITE_VAR_REVISION_CONFLICT');
        return liveVars;
      }

      const statements = [];
      for (const name of desiredNames) {
        const existing = liveByName.get(name);
        if (existing && existing.value === vars[name]) continue;
        const revision = (await this.nextSiteVarRevision(input.environment, input.siteId, name)) + 1;
        if (existing) {
          this.pushRuntimeChangeStatement(
            statements,
            this.siteVarUpdateStatement({
              environment: input.environment,
              siteId: input.siteId,
              value: vars[name],
              revision,
              updatedAt: now,
              existing,
              lockId,
            })
          );
        } else {
          const id = input.createId ? input.createId(name) : randomStoreId('var');
          this.pushRuntimeChangeStatement(
            statements,
            this.siteVarInsertStatement({
              id,
              environment: input.environment,
              siteId: input.siteId,
              name,
              value: vars[name],
              revision,
              createdBy: input.actorId || input.createdBy,
              createdAt: now,
              updatedAt: now,
              lockId,
            })
          );
        }
      }
      for (const name of liveNames) {
        if (desiredNames.includes(name)) continue;
        const existing = liveByName.get(name);
        this.pushRuntimeChangeStatement(
          statements,
          this.siteVarDeleteStatement({
            environment: input.environment,
            siteId: input.siteId,
            existing,
            deletedAt: now,
            lockId,
          })
        );
      }
      this.pushRuntimeChangeStatement(
        statements,
        this.bumpRuntimeConfigGenerationAndReleaseLockStatement(input.environment, input.siteId, now, lockId)
      );

      await this.db.batch(statements);
      released = true;
      return this.listEnabledSiteVars(input.environment, input.siteId);
    } catch (error) {
      if (!released) {
        try {
          await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
        } catch {
          // Best effort: the next runtime config operation will fail closed if the lock remains.
        }
      }
      throw error;
    }
  },

  async withRuntimeConfigLock(environment, siteId, callback, options = {}) {
    const now = options.updatedAt || this.now();
    const lockId = options.lockId || randomStoreId('runtime_lock');
    const lock = await this.acquireRuntimeConfigLockStatement(environment, siteId, lockId, now).run();
    if (lock?.meta?.changes !== 1) throw new Error('RUNTIME_CONFIG_LOCKED');

    let result;
    let failure;
    const abortController = new globalThis.AbortController();
    const providerTimeoutMs = options.providerTimeoutMs || RUNTIME_CONFIG_PROVIDER_TIMEOUT_MS;
    const providerTimeout = globalThis.setTimeout(() => {
      abortController.abort(new Error('RUNTIME_CONFIG_PROVIDER_TIMEOUT'));
    }, providerTimeoutMs);
    let renewal = Promise.resolve();
    const renew = () => {
      renewal = renewal
        .then(async () => {
          const renewedAt = this.now();
          const renewed = await this.renewRuntimeConfigLockStatement(environment, siteId, lockId, renewedAt).run();
          if (renewed?.meta?.changes !== 1) throw new Error('RUNTIME_CONFIG_LOCKED');
        })
        .catch((error) => {
          abortController.abort(error);
          throw error;
        });
      renewal.catch(() => {});
    };
    const renewIntervalMs = options.renewIntervalMs || RUNTIME_CONFIG_LOCK_RENEW_MS;
    const timer = globalThis.setInterval(renew, renewIntervalMs);
    try {
      const routeState = await this.getRuntimeConfigRouteState(environment, siteId);
      if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('RUNTIME_CONFIG_LOCKED');
      result = await callback({ ...routeState, signal: abortController.signal });
    } catch (error) {
      failure = error;
    }
    globalThis.clearInterval(timer);
    globalThis.clearTimeout(providerTimeout);
    try {
      await renewal;
    } catch (error) {
      if (!failure) failure = error;
    }
    try {
      const release = await this.releaseRuntimeConfigLockStatement(environment, siteId, lockId, this.now()).run();
      if (release?.meta?.changes !== 1 && !failure) failure = new Error('RUNTIME_CONFIG_LOCKED');
    } catch (error) {
      if (!failure) failure = error;
    }
    if (failure) throw failure;
    return result;
  },

  async nextSiteVarRevision(environment, siteId, name) {
    const row = await this.db
      .prepare(
        `SELECT MAX(revision) AS max_revision FROM site_vars
            WHERE environment = ? AND site_id = ? AND name = ?`
      )
      .bind(environment, siteId, name)
      .first();
    return Number(row?.max_revision || 0);
  },

  siteSecretInsertStatement({ id, environment, siteId, name, encryptedValue, revision, createdBy, createdAt, updatedAt }) {
    return this.db
      .prepare(
        `INSERT INTO site_secrets (
              id, environment, site_id, name, encrypted_value, revision,
              created_by, created_at, updated_at, deleted_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
            WHERE NOT EXISTS (
              SELECT 1 FROM site_secrets
              WHERE environment = ? AND site_id = ? AND name = ? AND deleted_at IS NULL
            )`
      )
      .bind(id, environment, siteId, name, encryptedValue, revision, createdBy, createdAt, updatedAt, environment, siteId, name);
  },

  bumpRuntimeConfigGenerationForPutStatement(environment, siteId, updatedAt, { secretId, revision, encryptedValue }) {
    return this.db
      .prepare(
        `UPDATE site_routes
            SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
            WHERE environment = ? AND site_id = ?
              AND EXISTS (
                SELECT 1 FROM site_secrets
                WHERE id = ? AND revision = ? AND encrypted_value = ? AND deleted_at IS NULL
              )`
      )
      .bind(updatedAt, environment, siteId, secretId, revision, encryptedValue);
  },

  bumpRuntimeConfigGenerationForDeleteStatement(environment, siteId, updatedAt, { secretId, revision, deletedAt }) {
    return this.db
      .prepare(
        `UPDATE site_routes
            SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
            WHERE environment = ? AND site_id = ?
              AND EXISTS (
                SELECT 1 FROM site_secrets
                WHERE id = ? AND revision = ? AND deleted_at = ?
              )`
      )
      .bind(updatedAt, environment, siteId, secretId, revision, deletedAt);
  },

  siteVarUpdateStatement({ environment, siteId, value, revision, updatedAt, existing, lockId }) {
    return this.db
      .prepare(
        `UPDATE site_vars
            SET value = ?, revision = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM site_routes
                WHERE environment = ? AND site_id = ?
                  AND runtime_config_lock_id = ?
              )`
      )
      .bind(value, revision, updatedAt, existing.id, environment, siteId, lockId);
  },

  siteVarDeleteStatement({ environment, siteId, existing, deletedAt, lockId }) {
    return this.db
      .prepare(
        `UPDATE site_vars
            SET deleted_at = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM site_routes
                WHERE environment = ? AND site_id = ?
                  AND runtime_config_lock_id = ?
              )`
      )
      .bind(deletedAt, deletedAt, existing.id, environment, siteId, lockId);
  },

  siteVarInsertStatement({ id, environment, siteId, name, value, revision, createdBy, createdAt, updatedAt, lockId }) {
    return this.db
      .prepare(
        `INSERT INTO site_vars (
              id, environment, site_id, name, value, revision,
              created_by, created_at, updated_at, deleted_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
            WHERE EXISTS (
              SELECT 1 FROM site_routes
              WHERE environment = ? AND site_id = ?
                AND runtime_config_lock_id = ?
            )`
      )
      .bind(id, environment, siteId, name, value, revision, createdBy, createdAt, updatedAt, environment, siteId, lockId);
  },

  acquireRuntimeConfigLockStatement(environment, siteId, lockId, updatedAt) {
    const expiresAt = runtimeConfigLockExpiry(updatedAt);
    return this.db
      .prepare(
        `UPDATE site_routes
            SET runtime_config_lock_id = ?, runtime_config_lock_expires_at = ?, updated_at = ?
            WHERE environment = ? AND site_id = ?
              AND (
                runtime_config_lock_id IS NULL
                OR runtime_config_lock_expires_at IS NULL
                OR runtime_config_lock_expires_at <= ?
              )`
      )
      .bind(lockId, expiresAt, updatedAt, environment, siteId, updatedAt);
  },

  renewRuntimeConfigLockStatement(environment, siteId, lockId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
            SET runtime_config_lock_expires_at = ?
            WHERE environment = ? AND site_id = ?
              AND runtime_config_lock_id = ?
              AND runtime_config_lock_expires_at > ?`
      )
      .bind(runtimeConfigLockExpiry(updatedAt), environment, siteId, lockId, updatedAt);
  },

  releaseRuntimeConfigLockStatement(environment, siteId, lockId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
            SET runtime_config_lock_id = NULL, runtime_config_lock_expires_at = NULL, updated_at = ?
            WHERE environment = ? AND site_id = ? AND runtime_config_lock_id = ?`
      )
      .bind(updatedAt, environment, siteId, lockId);
  },

  bumpRuntimeConfigGenerationAndReleaseLockStatement(environment, siteId, updatedAt, lockId) {
    return this.db
      .prepare(
        `UPDATE site_routes
            SET runtime_config_generation = runtime_config_generation + 1,
              runtime_config_lock_id = NULL,
              runtime_config_lock_expires_at = NULL,
              updated_at = ?
            WHERE environment = ? AND site_id = ?
              AND runtime_config_lock_id = ?`
      )
      .bind(updatedAt, environment, siteId, lockId);
  },

  pushRuntimeChangeStatement(statements, statement, errorCode = 'SITE_VAR_REVISION_CONFLICT') {
    statements.push(statement, this.runtimeChangeGuardStatement(errorCode));
  },

  runtimeChangeGuardStatement(errorCode = 'SITE_VAR_REVISION_CONFLICT') {
    return this.db.prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`).bind(errorCode);
  },

  bumpRuntimeConfigGenerationStatement(environment, siteId, updatedAt) {
    return this.db
      .prepare(
        `UPDATE site_routes
            SET runtime_config_generation = runtime_config_generation + 1, updated_at = ?
            WHERE environment = ? AND site_id = ?`
      )
      .bind(updatedAt, environment, siteId);
  },

  siteSecretPutAuditEventStatement(record, { secretId, revision, encryptedValue, updatedAt }) {
    return this.db
      .prepare(
        `INSERT INTO audit_events (
              id, environment, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
              decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM site_secrets
            WHERE id = ? AND revision = ? AND encrypted_value = ? AND updated_at = ? AND deleted_at IS NULL`
      )
      .bind(
        record.id,
        record.environment || record.metadata?.environment || null,
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt,
        secretId,
        revision,
        encryptedValue,
        updatedAt
      );
  },

  siteSecretDeleteAuditEventStatement(record, { secretId, revision, deletedAt }) {
    return this.db
      .prepare(
        `INSERT INTO audit_events (
              id, environment, trace_id, event_type, actor_user_id, actor_type, site_id, route_id, version_id,
              decision, status_code, ip_hash, user_agent_hash, metadata_json, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM site_secrets
            WHERE id = ? AND revision = ? AND deleted_at = ?`
      )
      .bind(
        record.id,
        record.environment || record.metadata?.environment || null,
        record.traceId,
        record.eventType,
        record.actorUserId,
        record.actorType,
        record.siteId,
        record.routeId,
        record.versionId,
        record.decision,
        record.statusCode,
        record.ipHash,
        record.userAgentHash,
        stringifyJsonColumn(record.metadata),
        record.createdAt,
        secretId,
        revision,
        deletedAt
      );
  },
};
