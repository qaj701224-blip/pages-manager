const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const V1_WORKER_PREFIXES = new Map([
  ['production', 'pages-'],
  ['staging', 'pages-staging-'],
]);
const PROTECTED_SCRIPT_NAMES = new Set([
  'pages-api',
  'pages-api-staging',
  'pages-auth',
  'pages-auth-staging',
  'pages-manager',
  'pages-manager-staging',
  'pages-kv-gateway',
  'pages-kv-gateway-staging',
  'pages-router',
  'pages-router-staging',
]);
const PROTECTED_SCRIPT_PREFIXES = ['pages-v2-production-slot-', 'pages-v2-staging-slot-'];

export async function cleanupLegacyV1CloudflareSite({ env, config, target }) {
  validateTarget(target, config?.environment);

  const client = env.V1_CLOUDFLARE_CLIENT || createCloudflareClient(env);
  try {
    const routes = await client.listRoutes({ zoneId: env.CF_ZONE_ID_NEW });
    if (!Array.isArray(routes)) throw cleanupFailedError();

    const exactRoutes = routes.filter((route) => route?.pattern === target.routePattern);
    if (exactRoutes.length > 1) throw cleanupFailedError();
    const exactRoute = exactRoutes[0];
    if (exactRoute) {
      if (exactRoute.script !== target.scriptName || !exactRoute.id) throw cleanupFailedError();
      await client.deleteRoute({ zoneId: env.CF_ZONE_ID_NEW, routeId: exactRoute.id });
    }

    await client.deleteScript({ accountId: env.CF_ACCOUNT_ID, scriptName: target.scriptName });
    return { ok: true };
  } catch (error) {
    if (error?.code === 'V1_TAKEOVER_CLEANUP_FAILED') throw error;
    throw cleanupFailedError();
  }
}

function validateTarget(target, environment) {
  const prefix = V1_WORKER_PREFIXES.get(environment);
  if (!prefix || !target || target.environment !== environment) throw cleanupFailedError();
  const expectedHostname = legacyHostnameForSlug(environment, target.slug);
  if (!expectedHostname || target.hostname !== expectedHostname) throw cleanupFailedError();
  if (typeof target.hostname !== 'string' || !target.hostname.endsWith('.workers.xd.team')) {
    throw cleanupFailedError();
  }
  if (target.routePattern !== `${target.hostname}/*`) throw cleanupFailedError();
  if (!isValidHostnameLabel(target.hostname)) throw cleanupFailedError();
  if (
    typeof target.scriptName !== 'string' ||
    !isLegacyV1ScriptName(target.scriptName, environment) ||
    target.scriptName.includes('/') ||
    PROTECTED_SCRIPT_NAMES.has(target.scriptName) ||
    PROTECTED_SCRIPT_PREFIXES.some((protectedPrefix) => target.scriptName.startsWith(protectedPrefix))
  ) {
    throw cleanupFailedError();
  }
}

function isValidHostnameLabel(hostname) {
  const label = hostname.slice(0, -'.workers.xd.team'.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

function createCloudflareClient(env) {
  const token = String(env.CF_API_TOKEN || '').trim();
  const accountId = String(env.CF_ACCOUNT_ID || '').trim();
  const zoneId = String(env.CF_ZONE_ID_NEW || '').trim();
  const fetchImpl = env.fetch || globalThis.fetch;
  if (!token || !accountId || !zoneId || typeof fetchImpl !== 'function') throw cleanupFailedError();

  return {
    async listRoutes({ zoneId: requestedZoneId }) {
      const routes = [];
      for (let page = 1; page <= 100; page += 1) {
        const payload = await cloudflareFetch(
          `/zones/${encodeURIComponent(requestedZoneId)}/workers/routes?page=${page}&per_page=100`,
          token,
          fetchImpl,
          { includeMetadata: true }
        );
        if (!Array.isArray(payload?.result)) throw cleanupFailedError();
        routes.push(...payload.result);
        const totalPages = Number(payload.result_info?.total_pages || page);
        if (!Number.isInteger(totalPages) || totalPages < page || page >= totalPages) return routes;
      }
      throw cleanupFailedError();
    },
    async deleteRoute({ zoneId: requestedZoneId, routeId }) {
      return cloudflareFetch(
        `/zones/${encodeURIComponent(requestedZoneId)}/workers/routes/${encodeURIComponent(routeId)}`,
        token,
        fetchImpl,
        { method: 'DELETE', acceptNotFound: true }
      );
    },
    async deleteScript({ accountId: requestedAccountId, scriptName }) {
      return cloudflareFetch(
        `/accounts/${encodeURIComponent(requestedAccountId)}/workers/scripts/${encodeURIComponent(scriptName)}?force=true`,
        token,
        fetchImpl,
        { method: 'DELETE', acceptNotFound: true }
      );
    },
  };
}

async function cloudflareFetch(
  path,
  token,
  fetchImpl,
  { method = 'GET', acceptNotFound = false, includeMetadata = false } = {}
) {
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (acceptNotFound && response.status === 404) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) throw cleanupFailedError();
  return includeMetadata ? payload : payload?.result ?? payload;
}

function isLegacyV1ScriptName(scriptName, environment) {
  const prefix = V1_WORKER_PREFIXES.get(environment);
  if (!prefix || !scriptName.startsWith(prefix)) return false;
  return environment !== 'production' || !scriptName.startsWith('pages-staging-');
}

function legacyHostnameForSlug(environment, slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) return null;
  const label = environment === 'staging' ? `${slug}-staging` : slug;
  return `${label}.workers.xd.team`;
}

function cleanupFailedError() {
  const error = new Error('V1_TAKEOVER_CLEANUP_FAILED');
  error.code = 'V1_TAKEOVER_CLEANUP_FAILED';
  return error;
}
