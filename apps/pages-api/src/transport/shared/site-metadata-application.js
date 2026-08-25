import { createSiteMetadataPort } from '../../application/ports/site-metadata.js';
import { createReconcileSiteMetadataRouting, createUpdateSiteMetadata } from '../../application/sites/update-site-metadata.js';
import { hostnameForSiteSlug } from '../../domain/sites/creation.js';
import { nextId } from '../../id.js';
import { logSiteMetadataEvent } from '../../site-metadata-diagnostics.js';
import { createSiteRouteSnapshotAdapter } from './site-route-snapshots.js';

const DEFAULT_REUSE_HOLD_SECONDS = 300;

export function createSiteMetadataApplication({ store, env, config }) {
  const update = createUpdateSiteMetadata({
    siteMetadata: createSiteMetadataPort(store),
    routeSnapshots: createSiteRouteSnapshotAdapter({ store, env }),
    hostnameForSlug: (slug) => hostnameForSiteSlug(slug, config),
    ids: { next: (prefix) => nextId(env, prefix) },
    clock: { now: () => readNow(env) },
    reuseHoldSeconds: readReuseHoldSeconds(env),
  });
  return async (command) => {
    const tracedCommand = { ...command, traceId: command.traceId || nextId(env, 'smt') };
    try {
      const result = await update(tracedCommand);
      logSiteMetadataEvent(env, {
        operation: metadataUpdateOperation(tracedCommand.patch),
        outcome: result.routingStatus,
        environment: tracedCommand.environment,
        traceId: tracedCommand.traceId,
        siteId: tracedCommand.siteId,
        slugRevision: result.site?.slugRevision,
      });
      return result;
    } catch (error) {
      const errorCode = error?.code || error?.message;
      logSiteMetadataEvent(env, {
        operation: metadataUpdateOperation(tracedCommand.patch),
        outcome: errorCode === 'SITE_SLUG_CONFLICT' || errorCode === 'SITE_METADATA_CONFLICT' ? 'conflict' : 'failed',
        environment: tracedCommand.environment,
        traceId: tracedCommand.traceId,
        siteId: tracedCommand.siteId,
        errorCode,
      });
      throw error;
    }
  };
}

export async function runSiteMetadataRoutingReconciliation(env, config, store, { limit = 50 } = {}) {
  const traceId = nextId(env, 'smr');
  const reconcile = createReconcileSiteMetadataRouting({
    siteMetadata: createSiteMetadataPort(store),
    routeSnapshots: createSiteRouteSnapshotAdapter({ store, env }),
    clock: { now: () => readNow(env) },
    reuseHoldSeconds: readReuseHoldSeconds(env),
    telemetry: { record: (event) => logSiteMetadataEvent(env, event) },
  });
  try {
    const summary = await reconcile({ environment: config.environment, limit, traceId });
    logSiteMetadataEvent(env, {
      operation: 'reconcile_batch',
      outcome: 'completed',
      environment: config.environment,
      traceId,
      ...summary,
    });
    return summary;
  } catch (error) {
    logSiteMetadataEvent(env, {
      operation: 'reconcile_batch',
      outcome: 'failed',
      environment: config.environment,
      traceId,
      errorCode: error?.code || error?.message,
    });
    throw error;
  }
}

function metadataUpdateOperation(patch) {
  const hasTitle = Boolean(patch && typeof patch === 'object' && Object.hasOwn(patch, 'title'));
  const hasSlug = Boolean(patch && typeof patch === 'object' && Object.hasOwn(patch, 'slug'));
  if (hasTitle && hasSlug) return 'update_title_and_slug';
  if (hasSlug) return 'update_slug';
  return 'update_title';
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
