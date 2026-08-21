import {
  accessModeFromVisibility,
  cacheTierForVisibility,
  cloneRecord,
  dispatchTypeFromExecutionProvider,
  executionProviderFromRuntime,
  mapSiteVersion,
  normalizeExposure,
  normalizeSitePolicyLease,
  routeRestoredAsNewCommit,
  routesMatchExecutionState,
  stringifyJsonColumn,
} from '../store-support.js';

export const routeActivationMethods = {
  async createSiteVersion(input) {
    const now = this.now();
    const record = {
      id: input.id,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      workerName: input.workerName,
      runtime: input.runtime,
      executionProvider: input.executionProvider || executionProviderFromRuntime(input.runtime),
      dispatchType: input.dispatchType || dispatchTypeFromExecutionProvider(input.executionProvider),
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
      createdAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO site_versions (
            id, site_id, deployment_id, worker_name, runtime, execution_provider,
            dispatch_type, dispatch_binding_name, slot_id,
            artifact_ref, content_hash, deployment_shape, requested_fallback,
            resolved_fallback, routing_mode, worker_entry, assets_config_json,
            worker_modules_json, asset_manifest_json, canonical_content_hash,
            var_names_json, secret_names_json, runtime_config_snapshot_json,
            artifact_availability, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.siteId,
        record.deploymentId,
        record.workerName,
        record.runtime,
        record.executionProvider,
        record.dispatchType,
        record.dispatchBindingName,
        record.slotId,
        record.artifactRef,
        record.contentHash,
        record.deploymentShape,
        record.requestedFallback,
        record.resolvedFallback,
        record.routingMode,
        record.workerEntry,
        stringifyJsonColumn(record.assetsConfigJson),
        stringifyJsonColumn(record.workerModulesJson),
        stringifyJsonColumn(record.assetManifestJson),
        record.canonicalContentHash,
        stringifyJsonColumn(record.varNamesJson),
        stringifyJsonColumn(record.secretNamesJson),
        stringifyJsonColumn(record.runtimeConfigSnapshotJson),
        record.artifactAvailability,
        record.createdBy,
        record.createdAt
      )
      .run();
    return cloneRecord(record);
  },

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
      requiredArtifactAvailability = null,
      updatedAt,
      lease = null,
    },
    environment,
    expectedRoute = null
  ) {
    const leaseValue = lease ? normalizeSitePolicyLease(lease) : null;
    if (leaseValue) await this.assertSitePolicyLease(environment, siteId, leaseValue, this.now());
    const expectedConditions = [];
    if (expectedRoute) {
      expectedConditions.push(
        ' AND route_generation = ? AND policy_version = ? AND runtime_config_generation = ? AND active_version_id IS ?'
      );
      if (Object.hasOwn(expectedRoute, 'exposure')) expectedConditions.push(' AND exposure = ?');
    }
    if (leaseValue) {
      expectedConditions.push(
        ` AND EXISTS (
            SELECT 1 FROM site_policy_locks
            WHERE environment = ? AND site_id = ? AND lock_id = ? AND fencing_token = ? AND expires_at > ?
          )`
      );
    }
    const artifactAvailabilityCondition = requiredArtifactAvailability
      ? ` AND EXISTS (
            SELECT 1 FROM site_versions
            WHERE site_versions.id = ?
              AND site_versions.site_id = site_routes.site_id
              AND site_versions.artifact_availability = ?
          )`
      : '';
    const conditionBinds = [
      ...(expectedRoute
        ? [
            expectedRoute.routeGeneration,
            expectedRoute.policyVersion,
            expectedRoute.runtimeConfigGeneration || 0,
            expectedRoute.activeVersionId,
            ...(Object.hasOwn(expectedRoute, 'exposure') ? [normalizeExposure(expectedRoute.exposure)] : []),
          ]
        : []),
      ...(leaseValue ? [environment, siteId, leaseValue.lockId, leaseValue.fencingToken, this.now()] : []),
      ...(requiredArtifactAvailability ? [activeVersionId, requiredArtifactAvailability] : []),
    ];
    const routeExpected = Boolean(expectedRoute || requiredArtifactAvailability || leaseValue);
    const whereSuffix = [
      environment ? ' AND environment = ?' : '',
      expectedConditions.join(''),
      artifactAvailabilityCondition,
    ].join('');
    const bindValues = environment
      ? [
          activeVersionId,
          workerName,
          runtime,
          executionProvider,
          dispatchType,
          dispatchBindingName,
          slotId,
          visibility,
          accessModeFromVisibility(visibility),
          cacheTierForVisibility(visibility),
          updatedAt,
          siteId,
          environment,
          ...conditionBinds,
        ]
      : [
          activeVersionId,
          workerName,
          runtime,
          executionProvider,
          dispatchType,
          dispatchBindingName,
          slotId,
          visibility,
          accessModeFromVisibility(visibility),
          cacheTierForVisibility(visibility),
          updatedAt,
          siteId,
          ...conditionBinds,
        ];
    const result = await this.db
      .prepare(
        `UPDATE site_routes
          SET active_version_id = ?, worker_name = ?, runtime = ?,
            execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
            visibility = ?, access_mode = ?, cache_tier = ?, route_status = 'active', route_generation = route_generation + 1,
            updated_at = ?
          WHERE site_id = ?${whereSuffix}`
      )
      .bind(...bindValues)
      .run();
    if (routeExpected && result?.meta?.changes === 0) return null;
    return this.getRouteBySiteId(siteId, environment);
  },

  async restoreSiteRoute(siteId, route, environment) {
    if (!route) return null;
    await this.db
      .prepare(
        `UPDATE site_routes
          SET active_version_id = ?, worker_name = ?, runtime = ?,
            execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
            visibility = ?, exposure = ?, access_mode = ?, policy_version = ?, route_generation = ?,
            runtime_config_generation = ?, route_status = ?, cache_tier = ?, updated_at = ?
          WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
      )
      .bind(
        ...(environment
          ? [
              route.activeVersionId,
              route.workerName,
              route.runtime,
              route.executionProvider,
              route.dispatchType,
              route.dispatchBindingName,
              route.slotId,
              route.visibility,
              normalizeExposure(route.exposure),
              accessModeFromVisibility(route.visibility),
              route.policyVersion,
              route.routeGeneration,
              route.runtimeConfigGeneration || 0,
              route.routeStatus,
              route.cacheTier,
              route.updatedAt,
              siteId,
              environment,
            ]
          : [
              route.activeVersionId,
              route.workerName,
              route.runtime,
              route.executionProvider,
              route.dispatchType,
              route.dispatchBindingName,
              route.slotId,
              route.visibility,
              normalizeExposure(route.exposure),
              accessModeFromVisibility(route.visibility),
              route.policyVersion,
              route.routeGeneration,
              route.runtimeConfigGeneration || 0,
              route.routeStatus,
              route.cacheTier,
              route.updatedAt,
              siteId,
            ])
      )
      .run();
    return this.getRouteBySiteId(siteId, environment);
  },

  async restoreSiteRouteIfCurrent(siteId, previousRoute, expectedRoute, environment) {
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (!routesMatchExecutionState(currentRoute, expectedRoute)) {
      return currentRoute;
    }
    return this.restoreSiteRoute(siteId, routeRestoredAsNewCommit(previousRoute, currentRoute), environment);
  },

  async restoreSiteDeleteIfCurrent(siteId, previousSite, previousRoute, previousHostnameClaim, expectedRoute, environment) {
    if (!previousSite || !previousRoute) return null;
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (!routesMatchExecutionState(currentRoute, expectedRoute)) {
      return currentRoute;
    }

    const restoredRoute = routeRestoredAsNewCommit(previousRoute, currentRoute);
    const statements = [
      this.db
        .prepare(`UPDATE sites SET deleted_at = ?, updated_at = ? WHERE id = ?${environment ? ' AND environment = ?' : ''}`)
        .bind(
          ...(environment
            ? [previousSite.deletedAt || null, previousSite.updatedAt, siteId, environment]
            : [previousSite.deletedAt || null, previousSite.updatedAt, siteId])
        ),
      this.db
        .prepare(
          `UPDATE site_routes
            SET active_version_id = ?, worker_name = ?, runtime = ?,
              execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
              visibility = ?, exposure = ?, access_mode = ?, policy_version = ?, route_generation = ?,
              runtime_config_generation = ?, route_status = ?, cache_tier = ?, updated_at = ?
            WHERE site_id = ?${environment ? ' AND environment = ?' : ''}`
        )
        .bind(
          ...(environment
            ? [
                restoredRoute.activeVersionId,
                restoredRoute.workerName,
                restoredRoute.runtime,
                restoredRoute.executionProvider,
                restoredRoute.dispatchType,
                restoredRoute.dispatchBindingName,
                restoredRoute.slotId,
                restoredRoute.visibility,
                normalizeExposure(restoredRoute.exposure),
                accessModeFromVisibility(restoredRoute.visibility),
                restoredRoute.policyVersion,
                restoredRoute.routeGeneration,
                restoredRoute.runtimeConfigGeneration || 0,
                restoredRoute.routeStatus,
                restoredRoute.cacheTier,
                restoredRoute.updatedAt,
                siteId,
                environment,
              ]
            : [
                restoredRoute.activeVersionId,
                restoredRoute.workerName,
                restoredRoute.runtime,
                restoredRoute.executionProvider,
                restoredRoute.dispatchType,
                restoredRoute.dispatchBindingName,
                restoredRoute.slotId,
                restoredRoute.visibility,
                normalizeExposure(restoredRoute.exposure),
                accessModeFromVisibility(restoredRoute.visibility),
                restoredRoute.policyVersion,
                restoredRoute.routeGeneration,
                restoredRoute.runtimeConfigGeneration || 0,
                restoredRoute.routeStatus,
                restoredRoute.cacheTier,
                restoredRoute.updatedAt,
                siteId,
              ])
        ),
    ];

    if (previousHostnameClaim) {
      statements.push(
        this.db
          .prepare(
            `UPDATE hostname_claims
              SET environment = ?, normalized_slug = ?, hostname_family = ?, owner_system = ?, owner_id = ?,
                owner_ref = ?, status = ?, source = ?, acquired_at = ?, lease_expires_at = ?,
                released_at = ?, reuse_hold_until = ?, release_reason = ?, updated_at = ?
              WHERE hostname = ? AND owner_system = ? AND owner_id = ?`
          )
          .bind(
            previousHostnameClaim.environment,
            previousHostnameClaim.normalizedSlug,
            previousHostnameClaim.hostnameFamily,
            previousHostnameClaim.ownerSystem,
            previousHostnameClaim.ownerId,
            previousHostnameClaim.ownerRef,
            previousHostnameClaim.status,
            previousHostnameClaim.source,
            previousHostnameClaim.acquiredAt,
            previousHostnameClaim.leaseExpiresAt,
            previousHostnameClaim.releasedAt,
            previousHostnameClaim.reuseHoldUntil,
            previousHostnameClaim.releaseReason,
            previousHostnameClaim.updatedAt,
            previousHostnameClaim.hostname,
            previousHostnameClaim.ownerSystem,
            previousHostnameClaim.ownerId
          )
      );
    }

    await this.db.batch(statements);
    return this.getRouteBySiteId(siteId, environment);
  },

  async getSiteVersion(id, environment) {
    const row = await this.db
      .prepare(
        `SELECT site_versions.*
          FROM site_versions
          JOIN sites ON sites.id = site_versions.site_id
          WHERE site_versions.id = ?${environment ? ' AND sites.environment = ?' : ''}`
      )
      .bind(...(environment ? [id, environment] : [id]))
      .first();
    return row ? mapSiteVersion(row) : null;
  },
};
