import { createSitePolicyPort } from '../../application/ports/site-policy.js';
import { createUpdateSiteAccessPolicy } from '../../application/sites/update-access-policy.js';
import { jsonError } from '../../http.js';
import { createSiteRouteSnapshotAdapter, routeSnapshotErrorResponse } from './site-route-snapshots.js';

export function createSitePolicyApplication({ store, env }) {
  return createUpdateSiteAccessPolicy({
    sitePolicy: createSitePolicyPort(store),
    routeSnapshots: createSiteRouteSnapshotAdapter({ store, env }),
    clock: { now: () => readNow(env) },
  });
}

export async function mutateUserSiteAccessPolicy({ env, config, store, siteId, actorUserId, visibility, resolveAclEntries }) {
  try {
    return await createSitePolicyApplication({ store, env })({
      environment: config.environment,
      siteId,
      actorUserId,
      visibility,
      resolveAclEntries,
    });
  } catch (error) {
    return sitePolicyErrorResponse(error);
  }
}

export function sitePolicyErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'SITE_NOT_FOUND') return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (code === 'SITE_POLICY_CONFLICT') {
    return jsonError(
      'SITE_POLICY_CONFLICT',
      'Site policy changed while the access update was being applied.',
      409,
      'Refresh the site and retry.'
    );
  }
  if (code === 'ROUTE_VERSION_NOT_FOUND' || code === 'ROUTE_SNAPSHOT_WRITE_FAILED') {
    return routeSnapshotErrorResponse(error);
  }
  if (code === 'ROUTE_POLICY_REPAIR_REQUIRED') {
    return jsonError(
      'ROUTE_POLICY_REPAIR_REQUIRED',
      'Route policy could not be confirmed effective.',
      503,
      'Repair the route snapshot before retrying.'
    );
  }
  return jsonError(
    'SITE_POLICY_UPDATE_FAILED',
    'Site access policy could not be updated.',
    503,
    'Retry after refreshing the site.'
  );
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
