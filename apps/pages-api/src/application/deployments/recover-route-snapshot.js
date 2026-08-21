export function createDeploymentRouteSnapshotRecovery({ routes, runtimeConfig, routeSnapshots, telemetry, repairs }) {
  if (typeof routes?.restore !== 'function') throw new TypeError('routes.restore is required');
  if (typeof runtimeConfig?.restore !== 'function') throw new TypeError('runtimeConfig.restore is required');
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
    let restorationFailed = false;
    try {
      restoredRoute = await routes.restore({
        siteId: command.siteId,
        previousRoute: command.previousRoute,
        expectedRoute: command.failedRoute,
        environment: command.environment,
      });
    } catch {
      restorationFailed = true;
    }

    try {
      await runtimeConfig.restore(command.runtimeConfig);
    } catch {
      restorationFailed = true;
    }

    const restoredSite = (await restoreOwner(routes, command)) || command.site;
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

async function restoreOwner(routes, command) {
  const previousSite = command.ownerTransfer?.previousSite;
  if (!command.ownerTransfer?.enabled || !previousSite || typeof routes.restoreOwner !== 'function') return null;
  try {
    return await routes.restoreOwner(command.siteId, {
      ownerType: previousSite.ownerType || 'user',
      ownerId: previousSite.ownerId || previousSite.ownerUserId,
      ownerUserId: previousSite.ownerUserId,
      defaultVisibility: previousSite.defaultVisibility,
      updatedAt: previousSite.updatedAt,
    }, command.environment);
  } catch {
    return null;
  }
}
