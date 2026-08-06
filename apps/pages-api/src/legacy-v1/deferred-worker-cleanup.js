import { createLegacyV1CloudflareClient } from './cloudflare-client.js';
import { isSafeLegacyV1SiteScriptName, legacyScriptNameForSlug } from './naming.js';

export function resolveDeferredLegacyV1WorkerTarget({ environment, task, site }) {
  if (!task || task.environment !== environment || !site || site.environment !== environment) return null;
  const expectedScriptName = legacyScriptNameForSlug(environment, site.slug);
  if (!expectedScriptName || !isSafeLegacyV1SiteScriptName(environment, site.slug, task.resourceRef)) return null;
  return {
    environment,
    slug: site.slug,
    scriptName: expectedScriptName,
  };
}

export async function cleanupDeferredLegacyV1WorkerScript({ env, target }) {
  if (!target || !isSafeLegacyV1SiteScriptName(target.environment, target.slug, target.scriptName)) {
    throw cleanupFailedError();
  }
  const client = env.V1_CLOUDFLARE_CLIENT || createLegacyV1CloudflareClient(env);
  const routes = await client.listRoutes({ zoneId: env.CF_ZONE_ID_NEW });
  if (!Array.isArray(routes)) throw cleanupFailedError();
  if (routes.some((route) => route?.script === target.scriptName)) {
    return { workerCleanup: 'deferred_shared_route' };
  }
  await client.deleteScript({ accountId: env.CF_ACCOUNT_ID, scriptName: target.scriptName });
  return { workerCleanup: 'deleted' };
}

function cleanupFailedError() {
  const error = new Error('V1_WORKER_CLEANUP_FAILED');
  error.code = 'V1_WORKER_CLEANUP_FAILED';
  return error;
}
