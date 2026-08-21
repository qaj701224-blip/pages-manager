import { createSiteOwnershipPort } from '../../application/ports/site-ownership.js';
import { createTransferSiteOwner } from '../../application/sites/transfer-owner.js';
import { jsonError } from '../../http.js';
import { createSiteRouteSnapshotAdapter, routeSnapshotErrorResponse } from './site-route-snapshots.js';

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
  if (code === 'SITE_NOT_FOUND') return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (code === 'ROUTE_VERSION_NOT_FOUND' || code === 'ROUTE_SNAPSHOT_WRITE_FAILED') {
    return routeSnapshotErrorResponse(error);
  }
  throw error;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
