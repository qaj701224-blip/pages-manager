import {
  expectedV1WorkerName,
  isManagedV1WorkerName,
  isValidV1SiteScriptName,
  readV1SiteRecord,
} from './domain/governance/v1-sites.js';
import {
  createV1SitesAdminClient as createInfrastructureV1SitesAdminClient,
} from './infrastructure/integrations/legacy-v1/sites-admin-client.js';

export { expectedV1WorkerName, isManagedV1WorkerName, isValidV1SiteScriptName, readV1SiteRecord };

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
      // The live version's artifact is trivially active; "rollback eligible" only means
      // something for workers that are not the current route target.
      const rollbackEligibleVersion = !referencedByActiveRoute && rollbackVersions.length > 0;
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
        // Legacy API 已墓碑化，该 token 不再具备任何部署/删除能力，仅作平台管理员可见的
        // 归属标记；除本响应外不得写入审计、日志或其它输出。
        token: nullableString(metadata.token),
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

export function createV1SitesAdminClient(env = {}) {
  return createInfrastructureV1SitesAdminClient({
    client: env.V1_SITES_ADMIN_CLIENT,
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    namespaceId: env.PAGES_V1_SITES_KV_NAMESPACE_ID,
    zoneId: nullableString(env.PAGES_V1_ZONE_ID) || env.CF_ZONE_ID_NEW,
    environment: env.PUBLIC_ENVIRONMENT || env.PAGES_ENV || 'production',
    fetch: env.fetch || globalThis.fetch,
  });
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

function classifyOrphanReason({ referencedByActiveRoute, rollbackEligibleVersion, hasPendingCleanupTask, versions }) {
  void rollbackEligibleVersion;
  if (referencedByActiveRoute || hasPendingCleanupTask) return null;
  if (versions.length === 0) return 'no_d1_reference';
  if (versions.every((version) => Boolean(version.siteDeletedAt))) return 'deleted_site';
  return 'stale_previous_version';
}

function classifyV1ScriptName({ siteName, scriptName, environment }) {
  if (!scriptName) return 'script_name_missing';
  if (!V1_WORKER_NAME_RE.test(scriptName)) return 'script_name_invalid';
  return scriptName === expectedV1WorkerName(siteName, environment) ? 'valid' : 'script_name_mismatch';
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
