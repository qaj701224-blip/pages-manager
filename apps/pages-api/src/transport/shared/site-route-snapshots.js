import { jsonError } from '../../http.js';
import { createSiteRouteSnapshots } from '../../infrastructure/route-snapshots/site-route-snapshots.js';
import { buildRouteSnapshot, writeRouteSnapshot } from '../../route-snapshot.js';

export function createSiteRouteSnapshotAdapter({ store, env }) {
  return createSiteRouteSnapshots({
    store,
    buildSnapshot: buildRouteSnapshot,
    writeSnapshot: (snapshot) => writeRouteSnapshot(env, snapshot),
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

export function routeSnapshotErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'ROUTE_VERSION_NOT_FOUND') {
    return jsonError('ROUTE_VERSION_NOT_FOUND', 'Active route version was not found.', 500, 'Check route consistency.');
  }
  return jsonError('ROUTE_SNAPSHOT_WRITE_FAILED', 'Route snapshot could not be written.', 503, 'Retry the policy update.');
}
