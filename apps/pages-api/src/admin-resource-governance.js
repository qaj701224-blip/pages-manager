const CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const ACTIVE_CLEANUP_STATUSES = new Set(['pending', 'failed', 'running']);

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
      const activeRoutes = activeRoutesByWorker.get(worker.name) || [];
      const versions = versionsByWorker.get(worker.name) || [];
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

export function formatV1SitesInventory({ siteKeys, workers, activeV2Sites, environment }) {
  const managedWorkers = new Map(
    (workers || []).filter((worker) => isManagedV1WorkerName(worker?.name, environment)).map((worker) => [worker.name, worker])
  );
  const activeV2Slugs = new Set((activeV2Sites || []).map((site) => site.slug));
  return (siteKeys || [])
    .filter((site) => typeof site?.name === 'string' && site.name !== '')
    .map((site) => {
      const metadata = isPlainObject(site.metadata) ? site.metadata : {};
      const expectedWorkerName = v1WorkerName(site.name, environment);
      const worker = managedWorkers.get(expectedWorkerName) || null;
      return {
        name: site.name,
        url: nullableString(metadata.url),
        preset: nullableString(metadata.preset),
        ipRestrict: typeof metadata.ipRestrict === 'boolean' ? metadata.ipRestrict : null,
        updatedAt: nullableString(metadata.updatedAt),
        workerName: worker?.name || null,
        workerModifiedOn: worker?.modified_on || null,
        migratedCandidate: activeV2Slugs.has(site.name),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createV1SitesAdminClient(env = {}) {
  if (env.V1_SITES_ADMIN_CLIENT) return env.V1_SITES_ADMIN_CLIENT;
  const accountId = nullableString(env.CF_ACCOUNT_ID);
  const apiToken = nullableString(env.CF_API_TOKEN);
  const namespaceId = nullableString(env.PAGES_V1_SITES_KV_NAMESPACE_ID);
  const fetchImpl = env.fetch || globalThis.fetch;
  if (!accountId || !apiToken || !namespaceId || typeof fetchImpl !== 'function') return null;

  return {
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
  };
}

export function isManagedWfpWorkerName(workerName, environment) {
  if (typeof workerName !== 'string') return false;
  if (environment === 'staging') return workerName.startsWith('pages-v2-staging-');
  return workerName.startsWith('pages-v2-') && !workerName.startsWith('pages-v2-staging-');
}

export function isManagedV1WorkerName(workerName, environment) {
  if (typeof workerName !== 'string' || workerName.startsWith('pages-v2-')) return false;
  if (environment === 'staging') return workerName.startsWith('pages-staging-');
  return workerName.startsWith('pages-') && !workerName.startsWith('pages-staging-');
}

function classifyOrphanReason({ referencedByActiveRoute, rollbackEligibleVersion, hasPendingCleanupTask, versions }) {
  if (referencedByActiveRoute || rollbackEligibleVersion || hasPendingCleanupTask) return null;
  if (versions.length === 0) return 'no_d1_reference';
  if (versions.every((version) => Boolean(version.siteDeletedAt))) return 'deleted_site';
  return 'stale_previous_version';
}

function v1WorkerName(siteName, environment) {
  return environment === 'staging' ? `pages-staging-${siteName}` : `pages-${siteName}`;
}

async function requestCloudflare(fetchImpl, apiToken, url) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false || !payload) {
    const error = new Error('CLOUDFLARE_RESOURCE_INVENTORY_FAILED');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function readInventoryListResult(payload) {
  if (Array.isArray(payload?.result)) return payload.result;
  throw invalidInventoryResponse();
}

function readInventoryCursor(payload) {
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
