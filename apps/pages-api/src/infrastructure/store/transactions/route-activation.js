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
  sitePolicyError,
  stringifyJsonColumn,
} from '../store-support.js';
import {
  SITE_MUTATION_AUTHORIZATION_FAILED,
  SITE_MUTATION_STATE_CHANGED,
  SITE_TRANSFER_INVARIANT_FAILED,
  siteMutationAuthorizationStatements,
  siteMutationExpectedStateStatements,
  siteTransferInvariantStatements,
} from '../support/site-mutation-authorization.js';

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

  async commitDeploymentActivation({
    siteId,
    route,
    environment,
    expectedRoute,
    expectedSite,
    authorization,
    ownerTransfer = null,
  }) {
    if (!expectedRoute || !expectedSite || !authorization || !route?.lease) {
      throw sitePolicyError('SITE_POLICY_CONFLICT');
    }
    const commitNow = this.now();
    const lease = normalizeSitePolicyLease(route.lease);
    await this.assertSitePolicyLease(environment, siteId, lease, commitNow);
    const target = ownerTransfer ? { ownerType: ownerTransfer.ownerType || 'team', ownerId: ownerTransfer.ownerId } : null;
    const statements = siteMutationAuthorizationStatements(this, {
      siteId,
      environment,
      authorization,
      now: commitNow,
      target,
    });
    statements.push(...siteMutationExpectedStateStatements(this, { siteId, environment, expected: expectedSite }));

    if (ownerTransfer) {
      statements.push(
        ...siteTransferInvariantStatements(this, {
          siteId,
          environment,
          target,
          expectedRoute,
          targetVisibility: route.visibility,
        }),
        this.db
          .prepare(
            `UPDATE sites
              SET owner_type = ?, owner_id = ?, owner_user_id = ?,
                default_visibility = ?, default_access_mode = ?, updated_at = ?
              WHERE id = ? AND environment = ? AND deleted_at IS NULL
                AND COALESCE(owner_type, 'user') = ?
                AND COALESCE(owner_id, owner_user_id) = ?
                AND slug_revision = ?
                AND EXISTS (
                  SELECT 1 FROM site_policy_locks
                  WHERE environment = ? AND site_id = ? AND lock_id = ?
                    AND fencing_token = ? AND expires_at > ?
                )`
          )
          .bind(
            target.ownerType,
            target.ownerId,
            ownerTransfer.ownerUserId,
            route.visibility,
            accessModeFromVisibility(route.visibility),
            route.updatedAt,
            siteId,
            environment,
            expectedSite.ownerType || 'user',
            expectedSite.ownerId || expectedSite.ownerUserId,
            expectedSite.slugRevision,
            environment,
            siteId,
            lease.lockId,
            lease.fencingToken,
            commitNow
          ),
        this.sitePolicyGuardStatement()
      );
    }

    statements.push(
      this.db
        .prepare(
          `UPDATE site_routes
            SET active_version_id = ?, worker_name = ?, runtime = ?,
              execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
              visibility = ?, access_mode = ?, cache_tier = ?, route_status = 'active',
              route_generation = route_generation + 1, updated_at = ?
            WHERE id = ? AND site_id = ? AND environment = ?
              AND route_generation = ? AND policy_version = ?
              AND runtime_config_generation = ? AND active_version_id IS ? AND exposure = ?
              AND EXISTS (
                SELECT 1 FROM site_versions
                WHERE site_versions.id = ? AND site_versions.site_id = site_routes.site_id
                  AND site_versions.artifact_availability = ?
              )
              AND EXISTS (
                SELECT 1 FROM site_policy_locks
                WHERE environment = ? AND site_id = ? AND lock_id = ?
                  AND fencing_token = ? AND expires_at > ?
              )`
        )
        .bind(
          route.activeVersionId,
          route.workerName,
          route.runtime,
          route.executionProvider,
          route.dispatchType,
          route.dispatchBindingName,
          route.slotId,
          route.visibility,
          accessModeFromVisibility(route.visibility),
          cacheTierForVisibility(route.visibility),
          route.updatedAt,
          expectedRoute.id,
          siteId,
          environment,
          expectedRoute.routeGeneration,
          expectedRoute.policyVersion,
          expectedRoute.runtimeConfigGeneration || 0,
          expectedRoute.activeVersionId,
          normalizeExposure(expectedRoute.exposure),
          route.activeVersionId,
          route.requiredArtifactAvailability || 'active',
          environment,
          siteId,
          lease.lockId,
          lease.fencingToken,
          commitNow
        ),
      deploymentActivationGuardStatement(this, 'ROUTE_ACTIVATION_CONFLICT')
    );
    if (ownerTransfer?.auditEvent) statements.push(this.auditEventStatement(ownerTransfer.auditEvent));

    try {
      await this.db.batch(statements);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('ROUTE_ACTIVATION_CONFLICT')) {
        return null;
      }
      if (message.includes(SITE_MUTATION_AUTHORIZATION_FAILED)) {
        throw sitePolicyError('SITE_NOT_FOUND');
      }
      if (
        message.includes(SITE_MUTATION_STATE_CHANGED) ||
        message.includes(SITE_TRANSFER_INVARIANT_FAILED) ||
        message.includes('SITE_POLICY_CONFLICT')
      ) {
        throw sitePolicyError('SITE_POLICY_CONFLICT');
      }
      throw error;
    }

    const committedSite = ownerTransfer
      ? {
          ...expectedSite,
          ownerType: target.ownerType,
          ownerId: target.ownerId,
          ownerUserId: ownerTransfer.ownerUserId,
          defaultVisibility: route.visibility,
          defaultAccessMode: accessModeFromVisibility(route.visibility),
          updatedAt: route.updatedAt,
        }
      : expectedSite;
    const committedRoute = {
      ...expectedRoute,
      activeVersionId: route.activeVersionId,
      workerName: route.workerName,
      runtime: route.runtime,
      executionProvider: route.executionProvider,
      dispatchType: route.dispatchType,
      dispatchBindingName: route.dispatchBindingName,
      slotId: route.slotId,
      visibility: route.visibility,
      accessMode: accessModeFromVisibility(route.visibility),
      cacheTier: cacheTierForVisibility(route.visibility),
      routeStatus: 'active',
      routeGeneration: expectedRoute.routeGeneration + 1,
      updatedAt: route.updatedAt,
    };
    return { site: committedSite, route: committedRoute };
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

  async restoreDeploymentActivationIfCurrent({
    siteId,
    previousSite,
    failedSite,
    previousRoute,
    expectedRoute,
    environment,
    lease,
  }) {
    if (!previousSite || !failedSite || !previousRoute || !expectedRoute || !lease) return null;
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (!routesMatchExecutionState(currentRoute, expectedRoute)) return null;

    const commitNow = this.now();
    const currentLease = await this.assertSitePolicyLease(environment, siteId, lease, commitNow);
    const restoredRoute = {
      ...routeRestoredAsNewCommit(previousRoute, currentRoute),
      visibility: previousRoute.visibility,
      accessMode: accessModeFromVisibility(previousRoute.visibility),
      cacheTier: cacheTierForVisibility(previousRoute.visibility),
    };
    const restoredSite = {
      ...failedSite,
      ownerType: previousSite.ownerType || 'user',
      ownerId: previousSite.ownerId || previousSite.ownerUserId,
      ownerUserId: previousSite.ownerUserId,
      defaultVisibility: previousSite.defaultVisibility,
      defaultAccessMode: accessModeFromVisibility(previousSite.defaultVisibility),
      updatedAt: commitNow,
    };
    const leaseBinds = [environment, siteId, currentLease.lockId, currentLease.fencingToken, commitNow];

    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE sites
              SET owner_type = ?, owner_id = ?, owner_user_id = ?,
                default_visibility = ?, default_access_mode = ?, updated_at = ?
              WHERE id = ? AND environment = ? AND deleted_at IS NULL
                AND COALESCE(owner_type, 'user') = ?
                AND COALESCE(owner_id, owner_user_id) = ?
                AND slug_revision = ?
                AND EXISTS (
                  SELECT 1 FROM site_policy_locks
                  WHERE environment = ? AND site_id = ? AND lock_id = ?
                    AND fencing_token = ? AND expires_at > ?
                )`
          )
          .bind(
            restoredSite.ownerType,
            restoredSite.ownerId,
            restoredSite.ownerUserId,
            restoredSite.defaultVisibility,
            restoredSite.defaultAccessMode,
            restoredSite.updatedAt,
            siteId,
            environment,
            failedSite.ownerType || 'user',
            failedSite.ownerId || failedSite.ownerUserId,
            failedSite.slugRevision,
            ...leaseBinds
          ),
        this.sitePolicyGuardStatement(),
        this.db
          .prepare(
            `UPDATE site_routes
              SET active_version_id = ?, worker_name = ?, runtime = ?,
                execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
                visibility = ?, exposure = ?, access_mode = ?, policy_version = ?, route_generation = ?,
                runtime_config_generation = ?, route_status = ?, cache_tier = ?, updated_at = ?
              WHERE id = ? AND site_id = ? AND environment = ?
                AND hostname = ? AND active_version_id IS ? AND worker_name IS ? AND runtime IS ?
                AND execution_provider IS ? AND dispatch_type IS ?
                AND dispatch_binding_name IS ? AND slot_id IS ?
                AND visibility IS ? AND exposure IS ? AND access_mode IS ?
                AND policy_version = ? AND route_generation = ?
                AND runtime_config_generation = ? AND route_status = ? AND cache_tier IS ?
                AND EXISTS (
                  SELECT 1 FROM site_policy_locks
                  WHERE environment = ? AND site_id = ? AND lock_id = ?
                    AND fencing_token = ? AND expires_at > ?
                )`
          )
          .bind(
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
            currentRoute.id,
            siteId,
            environment,
            currentRoute.hostname,
            currentRoute.activeVersionId,
            currentRoute.workerName,
            currentRoute.runtime,
            currentRoute.executionProvider,
            currentRoute.dispatchType,
            currentRoute.dispatchBindingName,
            currentRoute.slotId,
            currentRoute.visibility,
            normalizeExposure(currentRoute.exposure),
            accessModeFromVisibility(currentRoute.visibility),
            currentRoute.policyVersion,
            currentRoute.routeGeneration,
            currentRoute.runtimeConfigGeneration || 0,
            currentRoute.routeStatus,
            currentRoute.cacheTier,
            ...leaseBinds
          ),
        this.sitePolicyGuardStatement(),
      ]);
    } catch (error) {
      if (String(error?.message || error).includes('SITE_POLICY_CONFLICT')) {
        throw sitePolicyError('SITE_POLICY_CONFLICT');
      }
      throw error;
    }
    return { site: restoredSite, route: restoredRoute };
  },

  async restoreSiteDeleteIfCurrent(
    siteId,
    previousSite,
    previousRoute,
    previousHostnameClaims,
    expectedRoute,
    environment,
    lease = null
  ) {
    if (!previousSite || !previousRoute) return null;
    const currentRoute = await this.getRouteBySiteId(siteId, environment);
    if (!routesMatchExecutionState(currentRoute, expectedRoute)) {
      return currentRoute;
    }

    const commitNow = this.now();
    const targetEnvironment = environment || previousSite.environment;
    const currentLease = lease ? await this.assertSitePolicyLease(targetEnvironment, siteId, lease, commitNow) : null;
    const leaseClause = currentLease
      ? ` AND EXISTS (
          SELECT 1 FROM site_policy_locks
          WHERE environment = ? AND site_id = ? AND lock_id = ?
            AND fencing_token = ? AND expires_at > ?
        )`
      : '';
    const leaseBinds = currentLease ? [targetEnvironment, siteId, currentLease.lockId, currentLease.fencingToken, commitNow] : [];
    const restoredRoute = routeRestoredAsNewCommit(previousRoute, currentRoute);
    const statements = [
      this.db
        .prepare(
          `UPDATE sites SET deleted_at = ?, updated_at = ?
            WHERE id = ?${environment ? ' AND environment = ?' : ''} AND deleted_at IS NOT NULL${leaseClause}`
        )
        .bind(
          ...(environment
            ? [previousSite.deletedAt || null, previousSite.updatedAt, siteId, environment]
            : [previousSite.deletedAt || null, previousSite.updatedAt, siteId]),
          ...leaseBinds
        ),
      ...(currentLease ? [this.sitePolicyGuardStatement()] : []),
      this.db
        .prepare(
          `UPDATE site_routes
            SET active_version_id = ?, worker_name = ?, runtime = ?,
              execution_provider = ?, dispatch_type = ?, dispatch_binding_name = ?, slot_id = ?,
              visibility = ?, exposure = ?, access_mode = ?, policy_version = ?, route_generation = ?,
              route_status = ?, cache_tier = ?
            WHERE id = ? AND site_id = ?${environment ? ' AND environment = ?' : ''}
              AND hostname = ? AND active_version_id IS ? AND worker_name IS ? AND runtime IS ?
              AND execution_provider IS ? AND dispatch_type IS ? AND dispatch_binding_name IS ? AND slot_id IS ?
              AND visibility IS ? AND exposure IS ? AND access_mode IS ? AND policy_version = ?
              AND route_generation = ? AND route_status = ? AND cache_tier IS ?${leaseClause}`
        )
        .bind(
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
          restoredRoute.routeStatus,
          restoredRoute.cacheTier,
          currentRoute.id,
          siteId,
          ...(environment ? [environment] : []),
          currentRoute.hostname,
          currentRoute.activeVersionId,
          currentRoute.workerName,
          currentRoute.runtime,
          currentRoute.executionProvider,
          currentRoute.dispatchType,
          currentRoute.dispatchBindingName,
          currentRoute.slotId,
          currentRoute.visibility,
          normalizeExposure(currentRoute.exposure),
          accessModeFromVisibility(currentRoute.visibility),
          currentRoute.policyVersion,
          currentRoute.routeGeneration,
          currentRoute.routeStatus,
          currentRoute.cacheTier,
          ...leaseBinds
        ),
      ...(currentLease ? [this.sitePolicyGuardStatement()] : []),
    ];

    const claims = Array.isArray(previousHostnameClaims)
      ? previousHostnameClaims
      : previousHostnameClaims
        ? [previousHostnameClaims]
        : [];
    for (const previousHostnameClaim of claims) {
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

function deploymentActivationGuardStatement(store, code) {
  return store.db.prepare(`SELECT json_extract('{"ok":true}', CASE WHEN changes() = 1 THEN '$.ok' ELSE ? END)`).bind(code);
}
