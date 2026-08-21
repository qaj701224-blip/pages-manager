export function createExposureSnapshotFinalization({
  snapshots,
  policies,
  sites,
  routes,
  versions,
  aclEntries,
  audits,
}) {
  if (typeof snapshots?.commit !== 'function') throw new TypeError('snapshots.commit is required');
  if (typeof snapshots?.clearFailed !== 'function') throw new TypeError('snapshots.clearFailed is required');
  if (typeof policies?.restore !== 'function') throw new TypeError('policies.restore is required');
  if (typeof sites?.get !== 'function') throw new TypeError('sites.get is required');
  if (typeof routes?.get !== 'function') throw new TypeError('routes.get is required');
  if (typeof versions?.get !== 'function') throw new TypeError('versions.get is required');
  if (typeof aclEntries?.list !== 'function') throw new TypeError('aclEntries.list is required');
  if (typeof audits?.record !== 'function') throw new TypeError('audits.record is required');

  return { finalize };

  async function finalize(command) {
    const committedSite = command.mutation.site || command.currentSite;
    const committedRoute = command.mutation.route || command.currentRoute;
    const committedVersion = committedRoute.activeVersionId
      ? await versions.get(committedRoute.activeVersionId, command.environment)
      : null;
    const snapshotResult = await snapshots.commit({
      site: committedSite,
      route: committedRoute,
      environment: command.environment,
    });
    if (!snapshotResult.error) return { ok: true, site: committedSite, route: committedRoute };

    let restoredRoute = null;
    let compensationError = null;
    try {
      restoredRoute = await policies.restore({
        siteId: command.currentSite.id,
        currentSite: command.currentSite,
        currentRoute: command.currentRoute,
        committedRoute,
        environment: command.environment,
      });
      if (!restoredRoute || restoredRoute.exposure !== command.currentExposure) {
        compensationError = new Error('ROUTE_POLICY_REPAIR_REQUIRED');
      }
    } catch (error) {
      compensationError = error;
    }

    if (!compensationError) {
      const restoredSite =
        (await sites.get(command.currentSite.id, command.environment)) || command.currentSite;
      const safeSnapshotResult = await snapshots.commit({
        site: restoredSite,
        route: restoredRoute,
        environment: command.environment,
      });
      if (safeSnapshotResult.error) compensationError = new Error('ROUTE_POLICY_REPAIR_REQUIRED');
    }

    if (compensationError) {
      try {
        await snapshots.clearFailed({
          site: command.currentSite,
          route: committedRoute,
          version: committedVersion,
          aclEntries: command.mutation.aclEntries || (await aclEntries.list(command.currentSite.id)),
        });
      } catch {
        // The repair-required result remains fail-closed when pointer cleanup is unavailable.
      }
    }

    const compensationStage = compensationError ? 'compensation_failed' : 'compensated_failure';
    try {
      const authorityRoute = await routes.get(command.currentSite.id, command.environment);
      await audits.record({
        id: `${command.operation.operationId}:${compensationStage}`,
        environment: command.environment,
        traceId: command.operation.operationId,
        eventType: 'admin.site.exposure',
        actorUserId: command.actorUserId,
        actorType: 'platform_admin',
        siteId: command.currentSite.id,
        routeId: command.currentRoute.id,
        decision: 'deny',
        statusCode: 503,
        metadata: {
          ...command.operation.auditMetadata,
          previousExposure: command.currentExposure,
          authorityExposure: authorityRoute?.exposure || null,
          effectiveExposure: null,
          stage: compensationStage,
          compensation: compensationError ? 'failed' : 'restored_internal',
        },
        createdAt: command.operation.now,
      });
    } catch {
      // Audit loss must not mask the repair-required result.
    }

    return {
      ok: false,
      error: {
        reason: 'repair_required',
        cause: snapshotResult.error,
        compensationStage,
      },
    };
  }
}
