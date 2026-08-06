const CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const ACTIVE_CLEANUP_STATUSES = new Set(['pending', 'failed', 'running']);
const V1_WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WFP_SLOT_PREFIXES = Object.freeze(['pages-v2-production-slot-', 'pages-v2-staging-slot-']);
const DEFAULT_V1_RESERVED_WORKER_NAMES = Object.freeze([
  'pages-api',
  'pages-api-staging',
  'pages-auth',
  'pages-auth-staging',
  'pages-router',
  'pages-router-staging',
  'pages-console',
  'pages-console-staging',
  'pages-kv-gateway',
  'pages-kv-gateway-staging',
  'pages-manager',
  'pages-manager-staging',
]);

export function buildWorkerOrphanScan({
  workers,
  references,
  environment,
  scannedAt,
  completeness = null,
  scannedCount = null,
  namespaceScriptCount = null,
}) {
  const activeRoutesByWorker = groupBy(references?.activeRoutes || [], (item) => item.workerName);
  const versionsByWorker = groupBy(references?.versions || [], (item) => item.workerName);
  const cleanupTasksByWorker = groupBy(
    (references?.cleanupTasks || []).filter((item) => ACTIVE_CLEANUP_STATUSES.has(item.status)),
    (item) => item.resourceRef
  );
  const items = (workers || [])
    .filter((worker) => isManagedWfpWorkerName(worker?.name, environment))
    .map((worker) => {
      const activeRoutes = (activeRoutesByWorker.get(worker.name) || []).filter((route) =>
        isWfpWorkerResource(route, environment)
      );
      const versions = (versionsByWorker.get(worker.name) || []).filter((version) =>
        isWfpWorkerResource(version, environment)
      );
      const liveVersions = versions.filter((version) => !version.siteDeletedAt);
      const rollbackVersions = liveVersions.filter((version) => version.artifactAvailability === 'active');
      const cleanupTasks = cleanupTasksByWorker.get(worker.name) || [];
      const referencedByActiveRoute = activeRoutes.length > 0;
      const rollbackEligibleVersion = rollbackVersions.length > 0;
      const hasPendingCleanupTask = cleanupTasks.length > 0;
      const orphanReason = classifyOrphanReason({
        referencedByActiveRoute,
        rollbackEligibleVersion,
        hasPendingCleanupTask,
        versions,
      });
      return {
        name: worker.name,
        createdOn: worker.created_on || null,
        modifiedOn: worker.modified_on || null,
        referencedByActiveRoute,
        rollbackEligibleVersion,
        hasPendingCleanupTask,
        orphanCandidate: Boolean(orphanReason),
        orphanReason,
        activeRouteSiteIds: uniqueStrings(activeRoutes.map((route) => route.siteId)),
        rollbackVersionIds: uniqueStrings(rollbackVersions.map((version) => version.id)),
        cleanupTaskIds: uniqueStrings(cleanupTasks.map((task) => task.id)),
      };
    });

  return {
    environment,
    scannedAt,
    completeness,
    scannedCount,
    namespaceScriptCount,
    summary: {
      total: items.length,
      referencedByActiveRoute: countWhere(items, (item) => item.referencedByActiveRoute),
      rollbackEligibleVersion: countWhere(items, (item) => item.rollbackEligibleVersion),
      hasPendingCleanupTask: countWhere(items, (item) => item.hasPendingCleanupTask),
      orphanCandidates: countWhere(items, (item) => item.orphanCandidate),
      orphanReasons: {
        noD1Reference: countWhere(items, (item) => item.orphanReason === 'no_d1_reference'),
        deletedSite: countWhere(items, (item) => item.orphanReason === 'deleted_site'),
        stalePreviousVersion: countWhere(items, (item) => item.orphanReason === 'stale_previous_version'),
      },
    },
    workers: items,
  };
}

export function formatV1SitesInventory({ siteKeys, workers, activeV2Sites, environment, reservedWorkerNames = new Set() }) {
  const managedWorkers = new Map(
    (workers || []).filter((worker) => isManagedV1WorkerName(worker?.name, environment)).map((worker) => [worker.name, worker])
  );
  const activeV2Slugs = new Set((activeV2Sites || []).map((site) => site.slug));
  return (siteKeys || [])
    .filter((site) => typeof site?.name === 'string' && site.name !== '')
    .map((site) => {
      const metadata = isPlainObject(site.metadata) ? site.metadata : {};
      const expectedWorkerName = expectedV1WorkerName(site.name, environment);
      const metadataWorkerName = nullableString(metadata.scriptName);
      const worker =
        managedWorkers.get(metadataWorkerName || expectedWorkerName) ||
        managedWorkers.get(expectedWorkerName) ||
        null;
      // scriptName lives in the KV value body, not in list-key metadata; a missing field is
      // normal and retirement re-reads the authoritative record, so only a present-but-wrong
      // value blocks here. A missing Worker does not block either: the retire chain treats
      // already-deleted resources as idempotent successes and still cleans route/KV/claim.
      const scriptNameStatus = metadataWorkerName
        ? classifyV1ScriptName({ siteName: site.name, scriptName: metadataWorkerName, environment })
        : 'valid';
      const platformReserved = reservedWorkerNames.has(expectedWorkerName) || reservedWorkerNames.has(metadataWorkerName);
      const retireBlockedReason = platformReserved
        ? 'platform_reserved'
        : scriptNameStatus !== 'valid'
          ? scriptNameStatus
          : null;
      const formatted = {
        name: site.name,
        url: nullableString(metadata.url),
        preset: nullableString(metadata.preset),
        ipRestrict: typeof metadata.ipRestrict === 'boolean' ? metadata.ipRestrict : null,
        updatedAt: nullableString(metadata.updatedAt),
        workerName: worker?.name || null,
        workerModifiedOn: worker?.modified_on || null,
        migratedCandidate: activeV2Slugs.has(site.name),
        canRetire: retireBlockedReason === null,
      };
      if (platformReserved) formatted.platformReserved = true;
      if (retireBlockedReason) formatted.retireBlockedReason = retireBlockedReason;
      if (platformReserved) formatted.classification = 'platform_reserved';
      return formatted;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function formatV1UnregisteredWorkers({ siteKeys, workers, environment, reservedWorkerNames }) {
  const registeredWorkerNames = new Set(
    (siteKeys || [])
      .flatMap((site) => {
        if (typeof site?.name !== 'string' || site.name === '') return [];
        const metadata = isPlainObject(site.metadata) ? site.metadata : {};
        return [expectedV1WorkerName(site.name, environment), nullableString(metadata.scriptName)].filter(Boolean);
      })
  );
  const reserved = reservedWorkerNames || new Set();
  return (workers || [])
    .filter((worker) => isManagedV1WorkerName(worker?.name, environment))
    .filter((worker) => !registeredWorkerNames.has(worker.name))
    .map((worker) => {
      const platformReserved = reserved.has(worker.name);
      return {
        workerName: worker.name,
        modifiedOn: worker.modified_on || null,
        classification: platformReserved ? 'platform_reserved' : 'unknown',
        platformReserved,
        canRetire: false,
        retireBlockedReason: platformReserved ? 'platform_reserved' : 'unknown_worker',
      };
    })
    .sort((left, right) => left.workerName.localeCompare(right.workerName));
}

export function readV1ReservedWorkerNames(env = {}) {
  const names = new Set(DEFAULT_V1_RESERVED_WORKER_NAMES);
  for (const value of String(env.PAGES_V1_RESERVED_WORKER_NAMES || '').split(',')) {
    const normalized = nullableString(value)?.toLowerCase();
    if (!normalized) continue;
    if (!V1_WORKER_NAME_RE.test(normalized)) {
      globalThis.console?.warn?.('V1_RESERVED_WORKER_NAME_INVALID');
      continue;
    }
    names.add(normalized);
  }
  return names;
}

export function readV1SiteRecord(site) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return null;
  const metadata = isPlainObject(site.metadata) ? site.metadata : {};
  const name = nullableString(site.name);
  const scriptName = nullableString(metadata.scriptName);
  const url = nullableString(metadata.url);
  if (!name) return null;
  return { name, metadata, scriptName, url };
}

export function createV1SitesAdminClient(env = {}) {
  if (env.V1_SITES_ADMIN_CLIENT) return env.V1_SITES_ADMIN_CLIENT;
  const accountId = nullableString(env.CF_ACCOUNT_ID);
  const apiToken = nullableString(env.CF_API_TOKEN);
  const namespaceId = nullableString(env.PAGES_V1_SITES_KV_NAMESPACE_ID);
  const configuredZoneId = nullableString(env.PAGES_V1_ZONE_ID);
  const fetchImpl = env.fetch || globalThis.fetch;
  if (!accountId || !apiToken || !namespaceId || typeof fetchImpl !== 'function') return null;

  return {
    retirementSupported: Boolean(configuredZoneId),
    async listSites() {
      const sites = [];
      let cursor = '';
      const seenCursors = new Set();
      do {
        const namespace = encodeURIComponent(namespaceId);
        const url = new URL(
          `${CF_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${namespace}/keys`
        );
        url.searchParams.set('limit', '1000');
        if (cursor) url.searchParams.set('cursor', cursor);
        const payload = await requestCloudflare(fetchImpl, apiToken, url.toString());
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
      const namespace = encodeURIComponent(namespaceId);
      const account = encodeURIComponent(accountId);
      const url = `${CF_API_BASE_URL}/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}`;
      // KV value reads return the stored JSON directly, without the Cloudflare envelope.
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiToken}` } });
      if (response.status === 404) return null;
      if (!response.ok) throw invalidInventoryResponse();
      const value = await response.json().catch(() => null);
      if (!isPlainObject(value)) throw invalidInventoryResponse();
      // Whitelist the fields retirement needs; the stored value also carries the site token.
      return { scriptName: nullableString(value.scriptName) };
    },

    async listWorkers() {
      const url = `${CF_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/workers/scripts`;
      const payload = await requestCloudflare(fetchImpl, apiToken, url);
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
        return await requestCloudflare(fetchImpl, apiToken, workerScriptUrl(accountId, workerName), {
          method: 'DELETE',
        });
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw error;
      }
    },

    async unbindRoute({
      hostname,
      expectedScriptName,
      environment = env.PUBLIC_ENVIRONMENT || env.PAGES_ENV || 'production',
      zoneId = configuredZoneId,
    }) {
      const normalizedHostname = nullableString(hostname)?.toLowerCase();
      if (!isExactV1Hostname(normalizedHostname)) throw invalidV1Route();
      if (!isManagedV1WorkerName(expectedScriptName, environment)) {
        throw invalidV1Route();
      }
      if (!nullableString(zoneId)) throw new Error('V1_SITE_RETIRE_UNSUPPORTED');
      let routesPayload;
      try {
        routesPayload = await requestCloudflare(
          fetchImpl,
          apiToken,
          `${CF_API_BASE_URL}/zones/${encodeURIComponent(zoneId)}/workers/routes`
        );
      } catch (error) {
        throw invalidV1Route('route list read failed', error);
      }
      if (!Array.isArray(routesPayload?.result)) throw invalidV1Route('route list malformed');
      const exact = routesPayload.result.find((route) => route?.pattern === `${normalizedHostname}/*`);
      // Wildcard-hostname routes are shared infrastructure (the v2 router claims the whole
      // domain suffix); only extra routes targeting exactly this hostname are per-site residue.
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
          apiToken,
          `${CF_API_BASE_URL}/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(exact.id)}`,
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
          apiToken,
          `${CF_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}` +
            `/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(name)}`,
          { method: 'DELETE' }
        );
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw error;
      }
    },
  };
}

export function isManagedWfpWorkerName(workerName, environment) {
  if (typeof workerName !== 'string') return false;
  if (WFP_SLOT_PREFIXES.some((prefix) => workerName.startsWith(prefix))) return false;
  if (environment === 'staging') return workerName.startsWith('pages-v2-staging-');
  return workerName.startsWith('pages-v2-') && !workerName.startsWith('pages-v2-staging-');
}

export function isWfpWorkerResource(record, environment) {
  if (!record || !isManagedWfpWorkerName(record.workerName, environment)) return false;
  if (record.executionProvider === 'normal-worker-slot' || record.dispatchType === 'service-binding') return false;
  return record.executionProvider === 'wfp' || record.dispatchType === 'dispatch-namespace';
}

export function isManagedV1WorkerName(workerName, environment) {
  if (typeof workerName !== 'string' || workerName.startsWith('pages-v2-')) return false;
  if (environment === 'staging') return workerName.startsWith('pages-staging-');
  return workerName.startsWith('pages-') && !workerName.startsWith('pages-staging-');
}

function classifyOrphanReason({ referencedByActiveRoute, rollbackEligibleVersion, hasPendingCleanupTask, versions }) {
  void rollbackEligibleVersion;
  if (referencedByActiveRoute || hasPendingCleanupTask) return null;
  if (versions.length === 0) return 'no_d1_reference';
  if (versions.every((version) => Boolean(version.siteDeletedAt))) return 'deleted_site';
  return 'stale_previous_version';
}

export function expectedV1WorkerName(siteName, environment) {
  return environment === 'staging' ? `pages-staging-${siteName}` : `pages-${siteName}`;
}

export function isValidV1SiteScriptName(siteName, scriptName, environment) {
  return V1_WORKER_NAME_RE.test(scriptName || '') && scriptName === expectedV1WorkerName(siteName, environment);
}

function classifyV1ScriptName({ siteName, scriptName, environment }) {
  if (!scriptName) return 'script_name_missing';
  if (!V1_WORKER_NAME_RE.test(scriptName)) return 'script_name_invalid';
  return scriptName === expectedV1WorkerName(siteName, environment) ? 'valid' : 'script_name_mismatch';
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

function groupBy(items, keyOf) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const values = grouped.get(key) || [];
    values.push(item);
    grouped.set(key, values);
  }
  return grouped;
}

function countWhere(items, predicate) {
  return items.filter(predicate).length;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
}

function nullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
