import { isManagedV1WorkerName } from '../../../domain/governance/v1-sites.js';

const CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

export function createV1SitesAdminClient({
  client,
  accountId,
  apiToken,
  namespaceId,
  zoneId,
  environment = 'production',
  fetch: fetchImpl,
} = {}) {
  if (client) return client;

  const normalizedAccountId = nullableString(accountId);
  const normalizedApiToken = nullableString(apiToken);
  const normalizedNamespaceId = nullableString(namespaceId);
  const normalizedZoneId = nullableString(zoneId);
  if (!normalizedAccountId || !normalizedApiToken || !normalizedNamespaceId || typeof fetchImpl !== 'function') {
    return null;
  }

  return {
    retirementSupported: Boolean(normalizedZoneId),
    async listSites() {
      const sites = [];
      let cursor = '';
      const seenCursors = new Set();
      do {
        const namespace = encodeURIComponent(normalizedNamespaceId);
        const url = new URL(
          `${CF_API_BASE_URL}/accounts/${encodeURIComponent(normalizedAccountId)}/storage/kv/namespaces/${namespace}/keys`
        );
        url.searchParams.set('limit', '1000');
        if (cursor) url.searchParams.set('cursor', cursor);
        const payload = await requestCloudflare(fetchImpl, normalizedApiToken, url.toString());
        const pageSites = readInventoryListResult(payload);
        sites.push(...pageSites);
        const nextCursor = readInventoryCursor(payload);
        if (nextCursor && seenCursors.has(nextCursor)) throw invalidInventoryResponse();
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      return sites;
    },

    async getSiteRecord(name) {
      const key = nullableString(name);
      if (!key) return null;
      const namespace = encodeURIComponent(normalizedNamespaceId);
      const account = encodeURIComponent(normalizedAccountId);
      const url = `${CF_API_BASE_URL}/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`;
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${normalizedApiToken}` } });
      if (response.status === 404) return null;
      if (!response.ok) throw invalidInventoryResponse();
      const value = await response.json().catch(() => null);
      if (!isPlainObject(value)) throw invalidInventoryResponse();
      return { scriptName: nullableString(value.scriptName) };
    },

    async listWorkers() {
      const url = `${CF_API_BASE_URL}/accounts/${encodeURIComponent(normalizedAccountId)}/workers/scripts`;
      const payload = await requestCloudflare(fetchImpl, normalizedApiToken, url);
      return readInventoryListResult(payload)
        .map((worker) => ({
          name: worker?.id || worker?.name,
          created_on: worker?.created_on || null,
          modified_on: worker?.modified_on || null,
        }))
        .filter((worker) => typeof worker.name === 'string' && worker.name !== '');
    },

    async deleteWorker({ workerName }) {
      try {
        return await requestCloudflare(
          fetchImpl,
          normalizedApiToken,
          workerScriptUrl(normalizedAccountId, workerName),
          { method: 'DELETE' }
        );
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw error;
      }
    },

    async unbindRoute({
      hostname,
      expectedScriptName,
      environment: targetEnvironment = environment,
      zoneId: requestedZoneId = normalizedZoneId,
    }) {
      const normalizedHostname = nullableString(hostname)?.toLowerCase();
      const targetZoneId = nullableString(requestedZoneId);
      if (!isExactV1Hostname(normalizedHostname)) throw invalidV1Route();
      if (!isManagedV1WorkerName(expectedScriptName, targetEnvironment)) throw invalidV1Route();
      if (!targetZoneId) throw new Error('V1_SITE_RETIRE_UNSUPPORTED');
      let routesPayload;
      try {
        routesPayload = await requestCloudflare(
          fetchImpl,
          normalizedApiToken,
          `${CF_API_BASE_URL}/zones/${encodeURIComponent(targetZoneId)}/workers/routes`
        );
      } catch (error) {
        throw invalidV1Route('route list read failed', error);
      }
      if (!Array.isArray(routesPayload?.result)) throw invalidV1Route('route list malformed');
      const exact = routesPayload.result.find((route) => route?.pattern === `${normalizedHostname}/*`);
      const hostnameResidue = routesPayload.result.find(
        (route) => route !== exact && routeHostnameEquals(route?.pattern, normalizedHostname)
      );
      if (hostnameResidue) throw invalidV1Route('extra route targets this hostname');
      if (!exact) return null;
      if (typeof exact.id !== 'string' || !exact.id) throw invalidV1Route('route id invalid');
      if (exact.script !== expectedScriptName) throw invalidV1Route('route script mismatch');
      try {
        return await requestCloudflare(
          fetchImpl,
          normalizedApiToken,
          `${CF_API_BASE_URL}/zones/${encodeURIComponent(targetZoneId)}/workers/routes/${encodeURIComponent(exact.id)}`,
          { method: 'DELETE' }
        );
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw error;
      }
    },

    async deleteSite(name) {
      try {
        return await requestCloudflare(
          fetchImpl,
          normalizedApiToken,
          `${CF_API_BASE_URL}/accounts/${encodeURIComponent(normalizedAccountId)}` +
            `/storage/kv/namespaces/${encodeURIComponent(normalizedNamespaceId)}/values/${encodeURIComponent(name)}`,
          { method: 'DELETE' }
        );
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw error;
      }
    },
  };
}

async function requestCloudflare(fetchImpl, apiToken, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: { Authorization: `Bearer ${apiToken}`, ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 204) return { success: true, result: null };
  if (!response.ok || payload?.success !== true || !payload || typeof payload !== 'object') {
    const error = new Error('CLOUDFLARE_RESOURCE_INVENTORY_FAILED');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function workerScriptUrl(accountId, workerName) {
  const normalized = nullableString(workerName);
  if (!normalized) throw new Error('V1_SITE_SCRIPT_INVALID');
  return (
    `${CF_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}` +
    `/workers/scripts/${encodeURIComponent(normalized)}?force=true`
  );
}

function isExactV1Hostname(hostname) {
  if (typeof hostname !== 'string' || !hostname.endsWith('.workers.xd.team')) return false;
  const label = hostname.slice(0, -'.workers.xd.team'.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

function routeHostnameEquals(pattern, hostname) {
  if (typeof pattern !== 'string') return false;
  return pattern.split('/', 1)[0].toLowerCase() === hostname;
}

function invalidV1Route(detail, cause) {
  const error = new Error('V1_SITE_ROUTE_UNSAFE');
  if (detail) error.detail = detail;
  if (Number.isInteger(cause?.status)) error.status = cause.status;
  return error;
}

function readInventoryListResult(payload) {
  if (Array.isArray(payload?.result)) return payload.result;
  throw invalidInventoryResponse();
}

function readInventoryCursor(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload || {}, 'result_info')) return '';
  if (!isPlainObject(payload.result_info)) throw invalidInventoryResponse();
  const rawCursor = payload?.result_info?.cursor;
  if (rawCursor === undefined || rawCursor === null || rawCursor === '') return '';
  if (typeof rawCursor !== 'string' || !rawCursor.trim()) throw invalidInventoryResponse();
  return rawCursor.trim();
}

function invalidInventoryResponse() {
  return new Error('CLOUDFLARE_RESOURCE_INVENTORY_INVALID');
}

function nullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
