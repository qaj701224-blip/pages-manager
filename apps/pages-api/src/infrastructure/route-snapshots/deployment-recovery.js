import { routeSnapshotKey } from '../../route-snapshot.js';

export function createDeploymentRouteSnapshotRecoveryAdapter({ store, routeSnapshots, routePointers }) {
  return {
    writeRestored: (input) => writeRouteSnapshot(store, routeSnapshots, input),
    writeSafeDisabled: ({ route, ...input }) =>
      writeRouteSnapshot(store, routeSnapshots, {
        ...input,
        route: route
          ? {
              ...route,
              exposure: 'internal',
              visibility: 'disabled',
              accessMode: 'disabled',
            }
          : null,
      }),
    async clearCurrent(route) {
      if (!route || typeof routePointers?.clearIfCurrent !== 'function') return false;
      try {
        const identity = route.siteId && route.id ? { siteId: route.siteId, routeId: route.id } : {};
        return await routePointers.clearIfCurrent({
          hostname: route.hostname,
          environment: route.environment,
          routeGeneration: Number(route.routeGeneration || 0),
          policyVersion: Number(route.policyVersion || 0),
          snapshotKey: routeSnapshotKey(
            route.environment,
            route.hostname,
            Number(route.routeGeneration || 0),
            Number(route.policyVersion || 0),
            identity.siteId
          ),
          ...identity,
        });
      } catch {
        return false;
      }
    },
  };
}

async function writeRouteSnapshot(store, routeSnapshots, { site, route, environment }) {
  if (!route) return false;
  try {
    const version = route.activeVersionId
      ? await store.getSiteVersion(route.activeVersionId, environment)
      : inactiveRouteVersion(route);
    if (!version && route.routeStatus === 'active') return false;
    await routeSnapshots.commitDeployment({ site, route, version });
    return true;
  } catch {
    return false;
  }
}

function inactiveRouteVersion(route) {
  return {
    id: null,
    executionProvider: route.executionProvider,
    dispatchType: route.dispatchType,
    dispatchBindingName: route.dispatchBindingName,
    slotId: route.slotId,
    contentHash: null,
    deploymentShape: 'inactive',
    resolvedFallback: null,
    routingMode: null,
  };
}
