import { departmentTeamDisplayName } from '../../../department-path.js';
import { accessModeFromVisibility, normalizeExposure } from '@xd/pages-access-policy';
import { parseJsonColumn } from '../support/common.js';
import { dispatchTypeFromExecutionProvider, executionProviderFromRuntime } from '../support/routes.js';

export function mapSite(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title || null,
    dataNamespace: row.data_namespace || row.slug,
    slugRevision: Number(row.slug_revision ?? 1),
    slugRoutingSyncedRevision: Number(row.slug_routing_synced_revision ?? 1),
    slugRoutingReconcileAttemptedAt: row.slug_routing_reconcile_attempted_at || null,
    environment: row.environment,
    ownerType: row.owner_type || 'user',
    ownerId: row.owner_id || row.owner_user_id,
    ownerUserId: row.owner_user_id,
    defaultVisibility: row.default_visibility,
    defaultExposure: normalizeExposure(row.default_exposure),
    defaultAccessMode: accessModeFromVisibility(row.default_visibility),
    executionModeOverride: row.execution_mode_override || null,
    siteUuid: row.site_uuid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function mapConsoleDirectorySite(row) {
  const site = mapSiteWithJoinedRoute(row);
  if ((site.ownerType || 'user') === 'team') {
    return {
      ...site,
      ownerDisplayName:
        departmentTeamDisplayName({
          teamType: row.owner_team_type,
          name: row.owner_team_name,
          departmentPath: row.owner_team_department_path,
        }) || null,
      ownerTeamType: row.owner_team_type || null,
      ownerTeamId: row.owner_team_id || null,
    };
  }
  return {
    ...site,
    ownerDisplayName: row.owner_user_realname || row.owner_user_email || null,
  };
}

export function mapAdminSiteWithOwner(row) {
  const site = mapSiteWithJoinedRoute(row);
  if ((site.ownerType || 'user') === 'team') {
    return {
      ...site,
      ownerDisplayName:
        departmentTeamDisplayName({
          teamType: row.owner_team_type,
          name: row.owner_team_name,
          departmentPath: row.owner_team_department_path,
        }) || null,
      ownerTeamType: row.owner_team_type || null,
      ownerDepartmentPath: row.owner_team_department_path || null,
    };
  }
  return {
    ...site,
    ownerEmail: row.owner_user_email || null,
    ownerDisplayName: row.owner_user_realname || null,
  };
}

export function mapSiteWithJoinedRoute(row) {
  const site = mapSite(row);
  site.deploymentShape = row.active_version_deployment_shape ?? null;
  if (row.management_role !== undefined) site.managementRole = row.management_role || null;
  site.route = row.route_id
    ? {
        id: row.route_id,
        hostname: row.route_hostname,
        siteId: site.id,
        environment: site.environment,
        runtime: row.route_runtime,
        executionProvider: row.route_execution_provider || executionProviderFromRuntime(row.route_runtime),
        workerName: row.route_worker_name,
        dispatchType:
          row.route_dispatch_type || dispatchTypeFromExecutionProvider(row.route_execution_provider || row.route_runtime),
        dispatchBindingName: row.route_dispatch_binding_name || null,
        slotId: row.route_slot_id || null,
        activeVersionId: row.route_active_version_id,
        visibility: row.route_visibility,
        exposure: normalizeExposure(row.route_exposure),
        accessMode: accessModeFromVisibility(row.route_visibility),
        policyVersion: row.route_policy_version,
        routeGeneration: row.route_route_generation,
        runtimeConfigGeneration: row.route_runtime_config_generation || 0,
        routeStatus: row.route_route_status,
        cacheTier: row.route_cache_tier,
        createdAt: row.route_created_at,
        updatedAt: row.route_updated_at,
      }
    : null;
  return site;
}

export function mapSiteRoute(row) {
  return {
    id: row.id,
    hostname: row.hostname,
    siteId: row.site_id,
    environment: row.environment,
    runtime: row.runtime,
    executionProvider: row.execution_provider || executionProviderFromRuntime(row.runtime),
    workerName: row.worker_name,
    dispatchType: row.dispatch_type || dispatchTypeFromExecutionProvider(row.execution_provider || row.runtime),
    dispatchBindingName: row.dispatch_binding_name || null,
    slotId: row.slot_id || null,
    activeVersionId: row.active_version_id,
    visibility: row.visibility,
    exposure: normalizeExposure(row.exposure),
    accessMode: accessModeFromVisibility(row.visibility),
    policyVersion: row.policy_version,
    routeGeneration: row.route_generation,
    runtimeConfigGeneration: row.runtime_config_generation || 0,
    routeStatus: row.route_status,
    cacheTier: row.cache_tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapSiteCommitLock(row) {
  return {
    environment: row.environment,
    siteId: row.site_id,
    lockId: row.lock_id,
    fencingToken: Number(row.fencing_token),
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function mapHostnameClaim(row) {
  return {
    id: row.id,
    environment: row.environment,
    hostname: row.hostname,
    normalizedSlug: row.normalized_slug,
    hostnameFamily: row.hostname_family,
    ownerSystem: row.owner_system,
    ownerId: row.owner_id,
    ownerRef: row.owner_ref,
    status: row.status,
    source: row.source,
    acquiredAt: row.acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    releasedAt: row.released_at,
    reuseHoldUntil: row.reuse_hold_until,
    releaseReason: row.release_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapSiteMember(row) {
  return {
    siteId: row.site_id,
    userId: row.user_id,
    role: row.role,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function mapSiteAclEntry(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    accessRole: row.access_role,
    effect: row.effect,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function mapSiteVersion(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    deploymentId: row.deployment_id,
    workerName: row.worker_name,
    runtime: row.runtime,
    executionProvider: row.execution_provider || executionProviderFromRuntime(row.runtime),
    dispatchType: row.dispatch_type || dispatchTypeFromExecutionProvider(row.execution_provider || row.runtime),
    dispatchBindingName: row.dispatch_binding_name || null,
    slotId: row.slot_id || null,
    artifactRef: row.artifact_ref,
    contentHash: row.content_hash,
    deploymentShape: row.deployment_shape || null,
    requestedFallback: row.requested_fallback || null,
    resolvedFallback: row.resolved_fallback || null,
    routingMode: row.routing_mode || null,
    workerEntry: row.worker_entry || null,
    assetsConfigJson: parseJsonColumn(row.assets_config_json),
    workerModulesJson: parseJsonColumn(row.worker_modules_json),
    assetManifestJson: parseJsonColumn(row.asset_manifest_json),
    canonicalContentHash: row.canonical_content_hash || row.content_hash,
    varNamesJson: parseJsonColumn(row.var_names_json),
    secretNamesJson: parseJsonColumn(row.secret_names_json),
    runtimeConfigSnapshotJson: parseJsonColumn(row.runtime_config_snapshot_json),
    artifactAvailability: row.artifact_availability || 'active',
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
