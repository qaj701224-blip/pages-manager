import { createLegacyV1CloudflareClient } from './cloudflare-client.js';
import { isSafeLegacyV1SiteScriptName, legacyHostnameForSlug } from './naming.js';

export async function detachLegacyV1CloudflareRoute({ env, config, target }) {
  validateTarget(target, config?.environment);

  const client = resolveClient(env);
  try {
    const routes = await client.listRoutes({ zoneId: env.CF_ZONE_ID_NEW });
    if (!Array.isArray(routes)) throw cleanupFailedError();

    const exactRoutes = routes.filter((route) => route?.pattern === target.routePattern);
    if (exactRoutes.length > 1) throw cleanupFailedError();
    const exactRoute = exactRoutes[0];
    if (exactRoute) {
      if (exactRoute.script !== target.scriptName || !exactRoute.id) throw cleanupFailedError();
    }
    const hasOtherScriptRoutes = routes.some((route) => route !== exactRoute && route?.script === target.scriptName);

    if (exactRoute) await client.deleteRoute({ zoneId: env.CF_ZONE_ID_NEW, routeId: exactRoute.id });
    return {
      routePattern: target.routePattern,
      scriptName: target.scriptName,
      routeDetached: Boolean(exactRoute),
      hasOtherScriptRoutes,
    };
  } catch (error) {
    if (error?.code === 'V1_TAKEOVER_CLEANUP_FAILED') throw error;
    throw cleanupFailedError();
  }
}

export async function restoreLegacyV1CloudflareRoute({ env, config, target, cleanupPlan }) {
  validateTarget(target, config?.environment);
  validateCleanupPlan(target, cleanupPlan);
  if (!cleanupPlan.routeDetached) return { routeRestore: 'not_needed' };

  const client = resolveClient(env);
  try {
    const routes = await client.listRoutes({ zoneId: env.CF_ZONE_ID_NEW });
    if (!Array.isArray(routes)) throw cleanupFailedError();
    const exactRoutes = routes.filter((route) => route?.pattern === target.routePattern);
    if (exactRoutes.length > 1) throw cleanupFailedError();
    if (exactRoutes.length === 1) {
      if (exactRoutes[0]?.script !== target.scriptName) throw cleanupFailedError();
      return { routeRestore: 'already_restored' };
    }
    await client.createRoute({
      zoneId: env.CF_ZONE_ID_NEW,
      pattern: target.routePattern,
      script: target.scriptName,
    });
    return { routeRestore: 'restored' };
  } catch (error) {
    if (error?.code === 'V1_TAKEOVER_CLEANUP_FAILED') throw error;
    throw cleanupFailedError();
  }
}

export async function cleanupLegacyV1WorkerScript({ env, config, target, cleanupPlan }) {
  validateTarget(target, config?.environment);
  validateCleanupPlan(target, cleanupPlan);

  if (cleanupPlan.hasOtherScriptRoutes) return { workerCleanup: 'deferred_shared_route' };
  const client = resolveClient(env);
  try {
    await client.deleteScript({ accountId: env.CF_ACCOUNT_ID, scriptName: target.scriptName });
    return { workerCleanup: 'deleted' };
  } catch {
    return { workerCleanup: 'deferred_delete_failed' };
  }
}

function resolveClient(env) {
  try {
    return env.V1_CLOUDFLARE_CLIENT || createLegacyV1CloudflareClient(env);
  } catch {
    throw cleanupFailedError();
  }
}

function validateCleanupPlan(target, cleanupPlan) {
  if (
    !cleanupPlan ||
    cleanupPlan.routePattern !== target.routePattern ||
    cleanupPlan.scriptName !== target.scriptName ||
    typeof cleanupPlan.routeDetached !== 'boolean' ||
    typeof cleanupPlan.hasOtherScriptRoutes !== 'boolean'
  ) {
    throw cleanupFailedError();
  }
}

function validateTarget(target, environment) {
  if (!target || target.environment !== environment) throw cleanupFailedError();
  const expectedHostname = legacyHostnameForSlug(environment, target.slug);
  if (!expectedHostname || target.hostname !== expectedHostname) throw cleanupFailedError();
  if (typeof target.hostname !== 'string' || !target.hostname.endsWith('.workers.xd.team')) {
    throw cleanupFailedError();
  }
  if (target.routePattern !== `${target.hostname}/*`) throw cleanupFailedError();
  if (!isValidHostnameLabel(target.hostname)) throw cleanupFailedError();
  if (!isSafeLegacyV1SiteScriptName(environment, target.slug, target.scriptName)) {
    throw cleanupFailedError();
  }
}

function isValidHostnameLabel(hostname) {
  const label = hostname.slice(0, -'.workers.xd.team'.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

function cleanupFailedError() {
  const error = new Error('V1_TAKEOVER_CLEANUP_FAILED');
  error.code = 'V1_TAKEOVER_CLEANUP_FAILED';
  return error;
}
