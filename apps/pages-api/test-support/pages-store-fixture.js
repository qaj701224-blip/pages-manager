import { createD1TestDatabase } from '../src/d1-test-db.js';
import { D1PagesStore } from '../src/infrastructure/store/create-store.js';
import { createSchemaSql } from '../src/schema.js';

const databases = new WeakMap();

export function createTestPagesStore({ now = () => new Date().toISOString(), failAuditWrites = false } = {}) {
  const db = createD1TestDatabase();
  void db.exec(createSchemaSql().join(';\n'));
  const store = new D1PagesStore(db, {
    now,
    secretEncryptionKey: 'pages-api-test-store-encryption-key',
  });
  databases.set(store, db);
  if (failAuditWrites) failTestAuditWrites(store);
  return store;
}

export function failTestAuditWrites(store) {
  const fail = () => {
    throw new Error('AUDIT_WRITE_FAILED');
  };
  store.recordAuditEvent = async () => {
    throw new Error('AUDIT_WRITE_FAILED');
  };
  store.auditEventStatement = fail;
  store.siteSecretPutAuditEventStatement = fail;
  store.siteSecretDeleteAuditEventStatement = fail;
}

export async function updateTestSitePolicy(store, siteId, { defaultExposure, defaultAccessMode } = {}) {
  const updates = [];
  const values = [];
  if (defaultExposure !== undefined) {
    updates.push('default_exposure = ?');
    values.push(defaultExposure);
  }
  if (defaultAccessMode !== undefined) {
    updates.push('default_access_mode = ?');
    values.push(defaultAccessMode);
  }
  if (updates.length === 0) return;
  await databaseFor(store)
    .prepare(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values, siteId)
    .run();
}

export async function updateTestSite(store, siteId, patch) {
  const columns = {
    deletedAt: 'deleted_at',
    executionModeOverride: 'execution_mode_override',
    slugRevision: 'slug_revision',
    updatedAt: 'updated_at',
  };
  await updateTestRecord(store, 'sites', siteId, patch, columns);
}

export async function updateTestUser(store, userId, patch) {
  const columns = {
    sessionVersion: 'session_version',
  };
  await updateTestRecord(store, 'users', userId, patch, columns, 'user_id');
}

export async function updateTestTeam(store, teamId, patch) {
  const columns = {
    deletedAt: 'deleted_at',
    status: 'status',
  };
  await updateTestRecord(store, 'teams', teamId, patch, columns);
}

export async function updateTestSiteVersion(store, versionId, patch) {
  const columns = {
    executionProvider: 'execution_provider',
  };
  await updateTestRecord(store, 'site_versions', versionId, patch, columns);
}

export async function updateTestDeployment(store, deploymentId, patch) {
  const columns = {
    traceId: 'trace_id',
  };
  await updateTestRecord(store, 'deployments', deploymentId, patch, columns);
}

export async function updateTestRoute(store, routeId, patch) {
  const columns = {
    accessMode: 'access_mode',
    activeVersionId: 'active_version_id',
    dispatchBindingName: 'dispatch_binding_name',
    dispatchType: 'dispatch_type',
    executionProvider: 'execution_provider',
    exposure: 'exposure',
    policyVersion: 'policy_version',
    routeGeneration: 'route_generation',
    routeStatus: 'route_status',
    runtime: 'runtime',
    runtimeConfigGeneration: 'runtime_config_generation',
    slotId: 'slot_id',
    visibility: 'visibility',
    workerName: 'worker_name',
    updatedAt: 'updated_at',
  };
  const updates = [];
  const values = [];
  for (const [field, value] of Object.entries(patch)) {
    const column = columns[field];
    if (!column) throw new Error(`Unsupported test route field: ${field}`);
    updates.push(`${column} = ?`);
    values.push(value);
  }
  if (updates.length === 0) return;
  await databaseFor(store)
    .prepare(`UPDATE site_routes SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values, routeId)
    .run();
}

export async function insertTestRoute(store, route) {
  await databaseFor(store)
    .prepare(
      `INSERT INTO site_routes (
        id, hostname, site_id, environment, runtime, execution_provider, worker_name,
        dispatch_type, dispatch_binding_name, slot_id, active_version_id, visibility,
        exposure, access_mode, policy_version, route_generation, runtime_config_generation,
        runtime_config_lock_id, runtime_config_lock_expires_at, route_status, cache_tier,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      route.id,
      route.hostname,
      route.siteId,
      route.environment,
      route.runtime,
      route.executionProvider ?? null,
      route.workerName ?? null,
      route.dispatchType ?? null,
      route.dispatchBindingName ?? null,
      route.slotId ?? null,
      route.activeVersionId ?? null,
      route.visibility,
      route.exposure,
      route.accessMode ?? null,
      route.policyVersion,
      route.routeGeneration,
      route.runtimeConfigGeneration,
      route.runtimeConfigLockId ?? null,
      route.runtimeConfigLockExpiresAt ?? null,
      route.routeStatus,
      route.cacheTier,
      route.createdAt,
      route.updatedAt
    )
    .run();
}

export async function insertTestHostnameClaim(store, claim) {
  await databaseFor(store)
    .prepare(
      `INSERT INTO hostname_claims (
        id, environment, hostname, normalized_slug, hostname_family, owner_system,
        owner_id, owner_ref, status, source, acquired_at, lease_expires_at,
        released_at, reuse_hold_until, release_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      claim.id,
      claim.environment,
      claim.hostname,
      claim.normalizedSlug,
      claim.hostnameFamily,
      claim.ownerSystem,
      claim.ownerId,
      claim.ownerRef ?? null,
      claim.status,
      claim.source,
      claim.acquiredAt,
      claim.leaseExpiresAt ?? null,
      claim.releasedAt ?? null,
      claim.reuseHoldUntil ?? null,
      claim.releaseReason ?? null,
      claim.createdAt,
      claim.updatedAt
    )
    .run();
}

export async function deleteTestSiteRecord(store, siteId) {
  await databaseFor(store).prepare('DELETE FROM sites WHERE id = ?').bind(siteId).run();
}

export async function addTestSiteMember(store, { siteId, userId, role, createdBy, createdAt = store.now() }) {
  await databaseFor(store)
    .prepare('INSERT INTO site_members (site_id, user_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(siteId, userId, role, createdBy, createdAt)
    .run();
}

export async function insertTestTeam(store, team) {
  await databaseFor(store)
    .prepare(
      `INSERT INTO teams (
        id, environment, name, description, team_type, department_path, status,
        created_by_type, created_by_user_id, merged_into_team_id, merged_at,
        merged_by_user_id, merge_reason, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      team.id,
      team.environment,
      team.name,
      team.description ?? null,
      team.teamType,
      team.departmentPath ?? null,
      team.status ?? 'active',
      team.createdByType,
      team.createdByUserId ?? null,
      team.mergedIntoTeamId ?? null,
      team.mergedAt ?? null,
      team.mergedByUserId ?? null,
      team.mergeReason ?? null,
      team.deletedAt ?? null,
      team.createdAt,
      team.updatedAt
    )
    .run();
}

export async function insertTestTeamMember(store, member) {
  await databaseFor(store)
    .prepare(
      `INSERT INTO team_members (
        team_id, user_id, role, membership_source, department_path, role_overridden_at,
        removed_at, removed_by_user_id, restored_at, restored_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      member.teamId,
      member.userId,
      member.role,
      member.membershipSource,
      member.departmentPath ?? null,
      member.roleOverriddenAt ?? null,
      member.removedAt ?? null,
      member.removedByUserId ?? null,
      member.restoredAt ?? null,
      member.restoredByUserId ?? null,
      member.createdAt,
      member.updatedAt
    )
    .run();
}

export async function readTestSitePolicy(store, siteId) {
  const row = await databaseFor(store)
    .prepare('SELECT default_visibility, default_exposure, default_access_mode FROM sites WHERE id = ?')
    .bind(siteId)
    .first();
  return row
    ? {
        defaultVisibility: row.default_visibility,
        defaultExposure: row.default_exposure,
        defaultAccessMode: row.default_access_mode,
      }
    : null;
}

export async function readTestRoutePolicy(store, siteId) {
  const row = await databaseFor(store)
    .prepare('SELECT visibility, exposure, access_mode FROM site_routes WHERE site_id = ?')
    .bind(siteId)
    .first();
  return row
    ? {
        visibility: row.visibility,
        exposure: row.exposure,
        accessMode: row.access_mode,
      }
    : null;
}

export async function updateTestRoutePolicy(store, siteId, { exposure, accessMode, visibility } = {}) {
  const updates = [];
  const values = [];
  if (exposure !== undefined) {
    updates.push('exposure = ?');
    values.push(exposure);
  }
  if (accessMode !== undefined) {
    updates.push('access_mode = ?');
    values.push(accessMode);
  }
  if (visibility !== undefined) {
    updates.push('visibility = ?');
    values.push(visibility);
  }
  if (updates.length === 0) return;
  await databaseFor(store)
    .prepare(`UPDATE site_routes SET ${updates.join(', ')} WHERE site_id = ?`)
    .bind(...values, siteId)
    .run();
}

function databaseFor(store) {
  const db = databases.get(store);
  if (!db) throw new TypeError('Expected a pages-api test store');
  return db;
}

async function updateTestRecord(store, table, id, patch, columns, idColumn = 'id') {
  const updates = [];
  const values = [];
  for (const [field, value] of Object.entries(patch)) {
    const column = columns[field];
    if (!column) throw new Error(`Unsupported test ${table} field: ${field}`);
    updates.push(`${column} = ?`);
    values.push(value);
  }
  if (updates.length === 0) return;
  await databaseFor(store)
    .prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE ${idColumn} = ?`)
    .bind(...values, id)
    .run();
}
