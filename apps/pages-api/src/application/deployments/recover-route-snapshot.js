export function createDeploymentRouteSnapshotRecovery({
  routes,
  runtimeConfig,
  ownerTransfers,
  routeSnapshots,
  telemetry,
  repairs,
}) {
  if (typeof routes?.restore !== 'function') throw new TypeError('routes.restore is required');
  if (typeof runtimeConfig?.restore !== 'function') throw new TypeError('runtimeConfig.restore is required');
  if (typeof ownerTransfers?.restore !== 'function') throw new TypeError('ownerTransfers.restore is required');
  if (typeof routeSnapshots?.writeRestored !== 'function') {
    throw new TypeError('routeSnapshots.writeRestored is required');
  }
  if (typeof routeSnapshots?.clearCurrent !== 'function') {
    throw new TypeError('routeSnapshots.clearCurrent is required');
  }
  if (typeof telemetry?.record !== 'function') throw new TypeError('telemetry.record is required');
  if (typeof repairs?.report !== 'function') throw new TypeError('repairs.report is required');

  return { recover };

  async function recover(command) {
    let restoredRoute = null;
    let restoredSite = command.site;
    let restorationFailed = false;
    try {
      if (command.ownerTransfer?.enabled && typeof routes.restoreWithOwner === 'function') {
        const restored = await routes.restoreWithOwner({
          siteId: command.siteId,
          previousSite: command.ownerTransfer.previousSite,
          failedSite: command.site,
          previousRoute: command.previousRoute,
          expectedRoute: command.failedRoute,
          environment: command.environment,
          lease: command.lease,
        });
        restoredRoute = restored?.route || null;
        restoredSite = restored?.site || restoredSite;
        if (!restored) restorationFailed = true;
      } else {
        restoredRoute = await routes.restore({
          siteId: command.siteId,
          previousRoute: command.previousRoute,
          expectedRoute: command.failedRoute,
          environment: command.environment,
        });
      }
    } catch {
      restorationFailed = true;
    }

    try {
      await runtimeConfig.restore(command.runtimeConfig);
    } catch {
      restorationFailed = true;
    }

    if (!command.ownerTransfer?.enabled || typeof routes.restoreWithOwner !== 'function') {
      restoredSite =
        (await ownerTransfers.restore({
          siteId: command.siteId,
          environment: command.environment,
          ...(command.ownerTransfer || {}),
        })) || restoredSite;
    }
    const restoredSnapshotWritten = restorationFailed
      ? false
      : await routeSnapshots.writeRestored({
          site: restoredSite,
          route: restoredRoute,
          environment: command.environment,
        });
    const routePointerCleared = restoredSnapshotWritten
      ? false
      : await routeSnapshots.clearCurrent(restoredRoute || command.failedRoute);

    const result = {
      site: restoredSite,
      restoredRoute,
      restoredSnapshotWritten,
      routePointerCleared,
      repairRequired: restorationFailed || !restoredSnapshotWritten,
    };
    await telemetry.record(result);
    if (result.repairRequired) {
      await repairs.report({
        environment: command.environment,
        siteId: command.siteId,
        deploymentId: command.deploymentId,
        reason: 'route_snapshot_repair_failed',
      });
    }
    return result;
  }
}
