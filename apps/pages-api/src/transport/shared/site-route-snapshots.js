import { jsonError } from '../../http.js';
import { createSiteRouteSnapshots } from '../../infrastructure/route-snapshots/site-route-snapshots.js';
import {
  buildRouteSnapshot,
  clearRoutePointerIfCurrent,
  repairRouteSnapshot,
  routeSnapshotKey,
  writeRouteSnapshot,
} from '../../route-snapshot.js';

export function createSiteRouteSnapshotAdapter({ store, env }) {
  return createSiteRouteSnapshots({
    store,
    buildSnapshot: buildRouteSnapshot,
    writeSnapshot: (snapshot) => writeRouteSnapshot(env, snapshot),
    repairSnapshot: (snapshot) => repairRouteSnapshot(env, snapshot),
    clearPointer: (pointer) =>
      clearRoutePointerIfCurrent(env, {
        ...pointer,
        snapshotKey: routeSnapshotKey(
          pointer.environment,
          pointer.hostname,
          pointer.routeGeneration,
          pointer.policyVersion,
          pointer.siteId,
        ),
      }),
  });
}

export async function refreshActiveRouteSnapshot(env, store, site, route, environment, aclEntries) {
  try {
    await createSiteRouteSnapshotAdapter({ store, env }).refreshActive({ site, route, environment, aclEntries });
    return null;
  } catch (error) {
    return routeSnapshotErrorResponse(error);
  }
}

export async function refreshCurrentRouteSnapshot(env, store, site, route, environment) {
  try {
    await createSiteRouteSnapshotAdapter({ store, env }).refreshCurrent({ site, route, environment });
    return null;
  } catch (error) {
    return routeSnapshotErrorResponse(error);
  }
}

export async function restoreSiteVisibilityAfterSnapshotFailure(
  store,
  siteId,
  previousSite,
  previousRoute,
  expectedRoute,
  environment
) {
  if (typeof store.restoreSiteVisibilityIfCurrent === 'function') {
    return store.restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, expectedRoute, environment);
  }
  return store.restoreSiteVisibility(siteId, previousSite, previousRoute, environment);
}

export async function restoreSiteAclAfterSnapshotFailure(
  store,
  siteId,
  previousEntries,
  previousRoute,
  previousSite,
  expectedRoute,
  environment
) {
  if (typeof store.restoreSiteAclEntriesIfCurrent === 'function') {
    return store.restoreSiteAclEntriesIfCurrent(
      siteId,
      previousEntries,
      previousRoute,
      previousSite,
      expectedRoute,
      environment
    );
  }
  return store.restoreSiteAclEntries(siteId, previousEntries, previousRoute, previousSite, environment);
}

export function routeSnapshotErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'ROUTE_VERSION_NOT_FOUND') {
    return jsonError('ROUTE_VERSION_NOT_FOUND', 'Active route version was not found.', 500, 'Check route consistency.');
  }
  return jsonError('ROUTE_SNAPSHOT_WRITE_FAILED', 'Route snapshot could not be written.', 503, 'Retry the policy update.');
}
