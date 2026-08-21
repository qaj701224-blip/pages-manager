export function createRollbackRouteSnapshotRecovery({ routes, officeNet, routeSnapshots, clock }) {
  if (typeof routes?.restore !== 'function') throw new TypeError('routes.restore is required');
  if (typeof routes?.getVersion !== 'function') throw new TypeError('routes.getVersion is required');
  if (typeof routes?.updateAccessPolicy !== 'function') throw new TypeError('routes.updateAccessPolicy is required');
  if (typeof officeNet?.ensure !== 'function') throw new TypeError('officeNet.ensure is required');
  if (typeof routeSnapshots?.writeRestored !== 'function') {
    throw new TypeError('routeSnapshots.writeRestored is required');
  }
  if (typeof routeSnapshots?.writeSafeDisabled !== 'function') {
    throw new TypeError('routeSnapshots.writeSafeDisabled is required');
  }
  if (typeof routeSnapshots?.clearCurrent !== 'function') {
    throw new TypeError('routeSnapshots.clearCurrent is required');
  }
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { recover };

  async function recover(command) {
    let restoredRoute = null;
    let failure = null;
    try {
      restoredRoute = await routes.restore({
        siteId: command.site.id,
        previousRoute: command.previousRoute,
        expectedRoute: command.failedRoute,
        environment: command.environment,
      });
    } catch (error) {
      failure = { kind: 'route_restore', error };
    }

    try {
      const restoredVersion = restoredRoute?.activeVersionId
        ? await routes.getVersion(restoredRoute.activeVersionId, command.environment)
        : null;
      await officeNet.ensure({
        environment: command.environment,
        siteId: command.site.id,
        workerName: restoredRoute?.workerName || restoredVersion?.workerName,
        executionProvider: restoredRoute?.executionProvider || restoredVersion?.executionProvider,
        deploymentShape: restoredVersion?.deploymentShape || 'inactive',
        exposure: restoredRoute?.exposure === 'public' ? 'public' : 'internal',
        signal: command.lease?.signal,
      });
    } catch (error) {
      failure = { kind: 'office_net', error };
    }

    if (failure && restoredRoute?.exposure === 'public') {
      try {
        const compensated = await routes.updateAccessPolicy({
          environment: command.environment,
          siteId: command.site.id,
          exposure: 'internal',
          accessMode: 'disabled',
          expected: {
            policyVersion: restoredRoute.policyVersion,
            routeGeneration: restoredRoute.routeGeneration,
            activeVersionId: restoredRoute.activeVersionId,
            runtimeConfigGeneration: restoredRoute.runtimeConfigGeneration,
          },
          lease: command.lease,
          updatedAt: clock.now(),
        });
        restoredRoute = compensated?.route || restoredRoute;
      } catch (error) {
        failure = { kind: 'safe_route_update', error };
      }
    }

    const restoredSnapshotWritten =
      failure && restoredRoute?.exposure === 'public'
        ? await routeSnapshots.writeSafeDisabled({
            site: command.site,
            route: restoredRoute,
            environment: command.environment,
          })
        : await routeSnapshots.writeRestored({
            site: command.site,
            route: restoredRoute,
            environment: command.environment,
          });
    const routePointerCleared = restoredSnapshotWritten
      ? false
      : await routeSnapshots.clearCurrent(restoredRoute || command.failedRoute);

    return {
      restoredRoute,
      failure,
      restoredSnapshotWritten,
      routePointerCleared,
      repairRequired: !restoredSnapshotWritten,
    };
  }
}
