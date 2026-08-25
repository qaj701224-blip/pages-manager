import { createDeletedResourceCleanupPort, createSiteLifecyclePort } from '../../application/ports/site-lifecycle.js';
import { createDeleteSite } from '../../application/sites/delete-site.js';
import { createEnqueueDeletedSiteResources } from '../../application/sites/enqueue-deleted-resources.js';
import { isWfpWorkerResource } from '../../admin-resource-governance.js';
import { jsonError } from '../../http.js';
import { nextId } from '../../id.js';
import { emitSiteDeletedWebhook } from '../../lifecycle-webhooks.js';
import { createSiteRouteSnapshotAdapter, routeSnapshotErrorResponse } from './site-route-snapshots.js';

const DEFAULT_REUSE_HOLD_SECONDS = 300;

export function createSiteLifecycleApplication({ store, env, config, ctx }) {
  const clock = { now: () => readNow(env) };
  const enqueueDeletedResources = createEnqueueDeletedSiteResources({
    cleanupTasks: createDeletedResourceCleanupPort(store),
    isManagedResource: isWfpWorkerResource,
    ids: { next: (prefix) => nextId(env, prefix) },
    clock,
  });
  return createDeleteSite({
    siteLifecycle: createSiteLifecyclePort(store),
    routeSnapshots: createSiteRouteSnapshotAdapter({ store, env }),
    enqueueDeletedResources,
    events: {
      siteDeleted: ({ actor, site, previousRoute, route }) =>
        emitSiteDeletedWebhook({ store, env, config, ctx, actor, site, previousRoute, route }),
    },
    clock,
    reuseHoldSeconds: readReuseHoldSeconds(env),
  });
}

export function siteDeleteErrorResponse(error) {
  const code = error?.code || error?.message;
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
  if (code === 'ROUTE_VERSION_NOT_FOUND' || code === 'ROUTE_SNAPSHOT_WRITE_FAILED') {
    return routeSnapshotErrorResponse(error);
  }
  throw error;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function readReuseHoldSeconds(env) {
  const value = Number(env?.HOSTNAME_REUSE_HOLD_SECONDS || DEFAULT_REUSE_HOLD_SECONDS);
  if (!Number.isInteger(value) || value < 0 || value > 86_400) return DEFAULT_REUSE_HOLD_SECONDS;
  return value;
}
