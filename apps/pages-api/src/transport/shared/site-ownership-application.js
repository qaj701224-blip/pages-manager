import { createSiteOwnershipPort } from '../../application/ports/site-ownership.js';
import { createTransferSiteOwner } from '../../application/sites/transfer-owner.js';
import { jsonError } from '../../http.js';
import { createSiteRouteSnapshotAdapter } from './site-route-snapshots.js';

export function createSiteOwnershipApplication({ store, env }) {
  return createTransferSiteOwner({
    siteOwnership: createSiteOwnershipPort(store),
    routeSnapshots: createSiteRouteSnapshotAdapter({ store, env }),
    clock: { now: () => readNow(env) },
  });
}

export function siteTransferErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'SITE_TRANSFER_UNSUPPORTED') {
    return jsonError('SITE_TRANSFER_UNSUPPORTED', 'Site transfer is unavailable.', 503, 'Retry later.');
  }
  if (code === 'SITE_TRANSFER_INVALID') {
    return jsonError(
      'SITE_TRANSFER_INVALID',
      'Site transfer target is invalid.',
      400,
      'Choose an owner different from the current owner.'
    );
  }
  if (code === 'SITE_NOT_FOUND') return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (code === 'SITE_POLICY_LOCKED' || code === 'SITE_POLICY_CONFLICT' || code === 'SITE_COMMIT_TIMEOUT') {
    return jsonError('SITE_POLICY_CONFLICT', 'Site changed concurrently.', 409, 'Refresh the site and retry.');
  }
  if (code === 'ROUTE_POLICY_REPAIR_REQUIRED') {
    return jsonError(
      'ROUTE_POLICY_REPAIR_REQUIRED',
      'Route policy could not be confirmed effective.',
      503,
      'Repair the route snapshot before retrying.'
    );
  }
  throw error;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
