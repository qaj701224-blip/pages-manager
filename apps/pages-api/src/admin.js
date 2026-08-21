import { isConsoleBffRequest, requireConsoleUserSession } from './console-auth.js';
import { sanitizeAuditMetadata } from './audit-sanitizer.js';
import { jsonResponse } from '@xd/worker-kit';
import { accessModeFromVisibility } from '@xd/pages-access-policy';
import {
  deleteConsoleSite,
  deleteSiteSecret,
  deleteSiteVar,
  formatAclEntry,
  putSiteSecret,
  putSiteVar,
  readSiteConfig,
  updateSiteAccess,
} from './console.js';
import { departmentTeamDisplayName } from './department-path.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { formatConsoleUser } from './console-users.js';
import { newId, nextId } from './id.js';
import { handleConsoleAdminWebhooksApi } from './webhooks.js';
import {
  buildSiteOwnerTransferAuditEvent,
  restoreSiteVisibilityAfterSnapshotFailure,
} from './sites.js';
import {
  refreshCurrentRouteSnapshot,
} from './transport/shared/site-route-snapshots.js';
import {
  createSiteOwnershipApplication,
  siteTransferErrorResponse,
} from './transport/shared/site-ownership-application.js';
import { createAdminDashboardQuery } from './application/governance/get-admin-dashboard.js';
import { createDeploymentTraceQuery } from './application/governance/get-deployment-trace.js';
import { createAuditEventsQuery } from './application/governance/list-audit-events.js';
import { createExposureUpdatePreparation } from './application/governance/prepare-exposure-update.js';
import { createExposureOfficeNetVerification } from './application/governance/ensure-exposure-office-net.js';
import { createExposureSnapshotFinalization } from './application/governance/finalize-exposure-snapshot.js';
import { createSiteExposureUpdate } from './application/governance/update-site-exposure.js';
import { createWorkerOrphanScan } from './application/governance/scan-worker-orphans.js';
import { createWorkerOrphanBackfill } from './application/governance/backfill-worker-orphans.js';
import { buildRouteSnapshot, clearRoutePointerIfCurrent, readRouteSnapshotState } from './route-snapshot.js';
import { createDeploymentProvider } from './execution-provider.js';
import { sanitizeDeploymentTraceDiagnostics } from './deployment-trace.js';
import { ensurePublicWorkerOfficeNetAbsent } from './deployments.js';
import { ensureCanChangeTeamAdminRole, ensureCanRemoveTeamMember } from './teams.js';
import { cleanupDeferredLegacyV1WorkerScript, resolveDeferredLegacyV1WorkerTarget } from './legacy-v1/deferred-worker-cleanup.js';
import { createWfpClient, readWfpConfig } from '@xd/wfp-client';
import {
  buildWorkerOrphanScan,
  createV1SitesAdminClient,
  expectedV1WorkerName,
  formatV1SitesInventory,
  formatV1UnregisteredWorkers,
  isManagedWfpWorkerName,
  isManagedV1WorkerName,
  isValidV1SiteScriptName,
  isWfpWorkerResource,
  readV1ReservedWorkerNames,
  readV1SiteRecord,
} from './admin-resource-governance.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';
const TEAM_ROLES = new Set(['viewer', 'publisher', 'admin']);
const NORMAL_WORKER_BULK_DELETE_LIMIT = 100;
const NORMAL_WORKER_BULK_DELETE_CONCURRENCY = 5;
const WFP_ORPHAN_BACKFILL_LIMIT = 100;
const V1_SITE_BULK_RETIRE_LIMIT = 100;
const DEFAULT_WFP_ORPHAN_SCAN_MAX_WORKERS = 10_000;
const CLEANUP_TASK_LOCK_SECONDS = 5 * 60;
const CLEANUP_TASK_FAILED_CODE = 'CLEANUP_TASK_FAILED';
const CLEANUP_TASK_FAILED_MESSAGE = 'Cleanup task failed unexpectedly.';

export async function handleConsoleAdminApi(request, env, config, store, ctx) {
  if (!isConsoleBffRequest(request)) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${CONSOLE_PREFIX}/admin`)) return null;

  const session = await requireConsoleUserSession(request, env, config, store, { requirePlatformAdmin: true });
  if (session instanceof Response) return session;

  const webhooksResponse = await handleConsoleAdminWebhooksApi(request, env, config, store, session);
  if (webhooksResponse) return webhooksResponse;

  if (url.pathname === `${CONSOLE_PREFIX}/admin/dashboard`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminDashboard(env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/ops`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminOps(config);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/deployment-cleanups`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listDeploymentCleanups(url, env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/deployment-cleanups/run-due`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return runDueDeploymentCleanupsAdmin(request, env, config, store, session);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/worker-orphan-scan`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return scanAdminWorkerOrphans(env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/worker-orphan-scan/backfill`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return backfillAdminWorkerOrphans(request, env, config, store, session);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/v1-sites`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminV1Sites(env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/v1-sites/bulk-retire`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return bulkRetireAdminV1Sites(request, env, config, store, session);
  }

  const adminV1SiteMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/v1-sites\/([^/]+)$/);
  if (adminV1SiteMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return retireAdminV1Site(env, config, store, session, decodeURIComponent(adminV1SiteMatch[1]));
  }

  const cleanupRunMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/deployment-cleanups\/([^/]+)\/run$/);
  if (cleanupRunMatch) {
    if (request.method !== 'POST') return methodNotAllowed();
    return runDeploymentCleanupTask(env, config, store, session, decodeURIComponent(cleanupRunMatch[1]));
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/normal-workers`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminNormalWorkers(config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/normal-workers/bulk-delete`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return bulkDeleteAdminNormalWorkers(request, env, config, store, session);
  }

  const adminNormalWorkerMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/normal-workers\/([^/]+)$/);
  if (adminNormalWorkerMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return deleteAdminNormalWorker(request, env, config, store, session, decodeURIComponent(adminNormalWorkerMatch[1]));
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/users`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminUsers(url, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/sites`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminSites(url, config, store);
  }

  const adminDeploymentTraceMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/deployments\/([^/]+)\/trace$/);
  if (adminDeploymentTraceMatch) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminDeploymentTrace(config, store, decodeURIComponent(adminDeploymentTraceMatch[1]));
  }

  const adminTraceIdMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/deployment-traces\/([^/]+)$/);
  if (adminTraceIdMatch) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminDeploymentTraceByTraceId(config, store, decodeURIComponent(adminTraceIdMatch[1]));
  }

  const adminSiteVarMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/config\/vars\/([^/]+)$/);
  if (adminSiteVarMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteVarMatch[1]));
    if (site instanceof Response) return site;
    const name = decodeURIComponent(adminSiteVarMatch[2]);
    if (request.method === 'PUT') return putSiteVar(request, env, config, store, session, site.id, name, { site });
    if (request.method === 'DELETE') return deleteSiteVar(env, config, store, session, site.id, name, { site });
    return methodNotAllowed();
  }

  const adminSiteSecretMatch = url.pathname.match(
    /^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/config\/secrets\/([^/]+)$/
  );
  if (adminSiteSecretMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteSecretMatch[1]));
    if (site instanceof Response) return site;
    const name = decodeURIComponent(adminSiteSecretMatch[2]);
    if (request.method === 'PUT') return putSiteSecret(request, env, config, store, session, site.id, name, { site });
    if (request.method === 'DELETE') return deleteSiteSecret(env, config, store, session, site.id, name, { site });
    return methodNotAllowed();
  }

  const adminSiteAccessMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/access$/);
  if (adminSiteAccessMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteAccessMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'PATCH') return updateSiteAccess(request, env, config, store, session, site.id, { site, ctx });
    if (request.method !== 'GET') return methodNotAllowed();
    const aclEntries = typeof store.listSiteAclEntries === 'function' ? await store.listSiteAclEntries(site.id) : [];
    const exposure = site.route?.exposure || site.defaultExposure || 'internal';
    const exposureReason = await readAdminSitePublicExposureReason(env, store, config, site, exposure);
    return jsonOk({
      access: {
        exposure,
        accessMode: site.route?.accessMode || accessModeFromVisibility(site.route?.visibility || site.defaultVisibility),
        visibility: site.route?.visibility || site.defaultVisibility,
        aclEntries: aclEntries.map(formatAclEntry),
        exposureReason,
      },
    });
  }

  const adminSiteExposureMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/exposure$/);
  if (adminSiteExposureMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteExposureMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'PATCH') return updateAdminSiteExposure(request, env, config, store, session, site);
    if (request.method !== 'GET') return methodNotAllowed();
    const route = await store.getRouteBySiteId(site.id, config.environment);
    return jsonOk({
      access: {
        exposure: route?.exposure || site.defaultExposure || 'internal',
        accessMode: route?.accessMode || accessModeFromVisibility(route?.visibility || site.defaultVisibility),
        visibility: route?.visibility || site.defaultVisibility,
      },
    });
  }

  const adminSiteDeploymentsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/deployments$/);
  if (adminSiteDeploymentsMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteDeploymentsMatch[1]));
    if (site instanceof Response) return site;
    if (request.method !== 'GET') return methodNotAllowed();
    const deployments =
      typeof store.listAdminSiteDeployments === 'function'
        ? await store.listAdminSiteDeployments({ environment: config.environment, siteId: site.id })
        : [];
    return jsonOk({ deployments: deployments.map(formatAdminDeployment) });
  }

  const adminSiteConfigMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/config$/);
  if (adminSiteConfigMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteConfigMatch[1]));
    if (site instanceof Response) return site;
    if (request.method !== 'GET') return methodNotAllowed();
    return jsonOk({ config: await readSiteConfig(store, config.environment, site.id) });
  }

  const adminSiteSettingsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/settings$/);
  if (adminSiteSettingsMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteSettingsMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'PATCH') return updateAdminSiteSettings(request, env, config, store, session, site);
    return methodNotAllowed();
  }

  const adminSiteMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)$/);
  if (adminSiteMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'GET') return jsonOk({ site: formatAdminSiteDetail(site) });
    if (request.method === 'DELETE') return deleteConsoleSite(env, config, store, site, { force: true, actor: session, ctx });
    return methodNotAllowed();
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/teams`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminTeams(url, config, store);
  }

  const adminTeamSettingsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/settings$/);
  if (adminTeamSettingsMatch) {
    if (request.method !== 'PATCH') return methodNotAllowed();
    return updateAdminTeamSettings(request, config, store, decodeURIComponent(adminTeamSettingsMatch[1]));
  }

  const adminTeamMemberMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (adminTeamMemberMatch) {
    const teamId = decodeURIComponent(adminTeamMemberMatch[1]);
    const userId = decodeURIComponent(adminTeamMemberMatch[2]);
    if (request.method === 'PATCH') return updateAdminTeamMember(request, config, store, session, teamId, userId);
    if (request.method === 'DELETE') return removeAdminTeamMember(config, store, session, teamId, userId);
    return methodNotAllowed();
  }

  const adminTeamMembersMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/members$/);
  if (adminTeamMembersMatch) {
    const team = await getAdminTeamRecord(config, store, decodeURIComponent(adminTeamMembersMatch[1]));
    if (team instanceof Response) return team;
    if (request.method !== 'GET') return methodNotAllowed();
    const members = typeof store.listTeamMembers === 'function' ? await store.listTeamMembers({ teamId: team.id }) : [];
    return jsonOk({ members: members.map(formatAdminTeamMember) });
  }

  const adminTeamMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)$/);
  if (adminTeamMatch) {
    const teamId = decodeURIComponent(adminTeamMatch[1]);
    if (request.method === 'GET') return getAdminTeam(config, store, teamId);
    if (request.method === 'DELETE') return deleteAdminTeam(config, store, session, teamId);
    return methodNotAllowed();
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/audit`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAuditEvents(config, store);
  }

  const teamMergeMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/merge$/);
  if (teamMergeMatch) {
    if (request.method !== 'POST') return methodNotAllowed();
    return mergeDepartmentTeam(request, config, store, session, decodeURIComponent(teamMergeMatch[1]));
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/platform-admins`) {
    if (request.method === 'GET') return listPlatformAdmins(config, store);
    if (request.method === 'POST') return grantPlatformAdmin(request, config, store, session);
    return methodNotAllowed();
  }

  const platformAdminMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/platform-admins\/([^/]+)$/);
  if (platformAdminMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return revokePlatformAdmin(request, config, store, session, decodeURIComponent(platformAdminMatch[1]));
  }

  return null;
}

async function getAdminDashboard(env, config, store) {
  const dashboard = await createAdminDashboardQueryApplication({ env, store }).get({
    environment: config.environment,
  });
  return jsonOk({ dashboard });
}

function createAdminDashboardQueryApplication({ env, store }) {
  return createAdminDashboardQuery({
    dashboards: { read: (query) => store.getAdminDashboard(query) },
    clock: { now: () => readNow(env) },
  });
}

async function scanAdminWorkerOrphans(env, config, store) {
  if (typeof store.listWorkerOrphanScanReferences !== 'function') {
    return jsonError('WORKER_ORPHAN_SCAN_UNSUPPORTED', 'Worker orphan scan is unavailable.', 503, 'Retry later.');
  }
  const client = createWfpScanAdminClient(env, config);
  if (!client) {
    return jsonError(
      'WORKER_ORPHAN_SCAN_UNSUPPORTED',
      'Worker orphan scan is unavailable.',
      503,
      'Configure Cloudflare WFP inventory access.'
    );
  }
  const result = await createWorkerOrphanScanApplication({ env, store, client }).scan({
    environment: config.environment,
    limit: readWorkerOrphanScanLimit(env),
  });
  if (result.ok) return jsonOk({ scan: result.scan });
  if (result.reason === 'limit_exceeded') {
    return jsonError(
      'WORKER_ORPHAN_SCAN_LIMIT_EXCEEDED',
      'Worker orphan scan exceeds the configured inventory limit.',
      413,
      'Increase PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS or narrow the upstream inventory before retrying.'
    );
  }
  if (result.reason === 'scan_failed') {
    return jsonError(
      'WORKER_ORPHAN_SCAN_FAILED',
      'Worker orphan scan failed.',
      502,
      `Cause: ${cloudflareFailureCause(result.error)}. Check Cloudflare credentials and retry.`
    );
  }
  throw new Error('WORKER_ORPHAN_SCAN_RESULT_INVALID');
}

function createWorkerOrphanScanApplication({ env, store, client }) {
  return createWorkerOrphanScan({
    inventory: { list: (query) => client.listWorkers(query) },
    references: { list: (query) => store.listWorkerOrphanScanReferences(query) },
    projection: { build: buildWorkerOrphanScan },
    clock: { now: () => readNow(env) },
  });
}

function cloudflareFailureCause(error) {
  // Only surface fixed internal error codes; upstream messages may embed resource details.
  const candidates = [error?.code, error?.message];
  const code = candidates.find((value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value));
  const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
  const detail = typeof error?.detail === 'string' && /^[a-zA-Z0-9_,. -]{1,160}$/.test(error.detail) ? ` [${error.detail}]` : '';
  return `${code || 'UNEXPECTED'}${status}${detail}`;
}

function readWorkerOrphanScanLimit(env) {
  const configured = Number(env?.PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS);
  if (!Number.isInteger(configured) || configured < 1) return DEFAULT_WFP_ORPHAN_SCAN_MAX_WORKERS;
  return configured;
}

async function listAdminV1Sites(env, config, store) {
  const client = createV1SitesAdminClient(env);
  if (!client || typeof store.listActiveSiteSlugs !== 'function') {
    return jsonError('V1_SITES_UNSUPPORTED', 'Legacy v1 site inventory is unavailable.', 503, 'Configure v1 inventory access.');
  }
  try {
    const [siteKeys, workers, activeV2Sites] = await Promise.all([
      client.listSites(),
      client.listWorkers(),
      store.listActiveSiteSlugs({ environment: config.environment }),
    ]);
    const reservedWorkerNames = readV1ReservedWorkerNames(env);
    return jsonOk({
      sites: formatV1SitesInventory({
        siteKeys,
        workers,
        activeV2Sites,
        environment: config.environment,
        reservedWorkerNames,
      }),
      unregisteredWorkers: formatV1UnregisteredWorkers({
        siteKeys,
        workers,
        environment: config.environment,
        reservedWorkerNames,
      }),
    });
  } catch (error) {
    return jsonError(
      'V1_SITES_READ_FAILED',
      'Legacy v1 site inventory could not be read.',
      502,
      `Cause: ${cloudflareFailureCause(error)}. Check Cloudflare credentials and retry.`
    );
  }
}

async function retireAdminV1Site(env, config, store, session, siteName) {
  const client = createV1SitesAdminClient(env);
  if (
    !client ||
    typeof client.listSites !== 'function' ||
    client.retirementSupported === false ||
    typeof store.getHostnameClaim !== 'function' ||
    typeof store.releaseHostnameClaim !== 'function'
  ) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: siteName, workerName: null, hostname: null },
      'capability_check',
      'deny',
      503
    );
    return jsonError('V1_SITES_UNSUPPORTED', 'Legacy v1 site retirement is unavailable.', 503, 'Configure v1 inventory access.');
  }

  let siteKeys;
  try {
    siteKeys = await client.listSites();
  } catch {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: siteName, workerName: null, hostname: null },
      'metadata_read',
      'deny',
      502
    );
    return jsonError(
      'V1_SITES_READ_FAILED',
      'Legacy v1 site inventory could not be read.',
      502,
      'Check Cloudflare credentials and retry.'
    );
  }
  const record = findV1SiteRecord(siteKeys, siteName);
  if (!record) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: siteName, workerName: null, hostname: null },
      'metadata_read',
      'deny',
      404
    );
    return v1RetireError(
      'metadata_read',
      'V1_SITE_NOT_FOUND',
      'Legacy v1 site was not found.',
      404,
      'Refresh the v1 site inventory.'
    );
  }
  const result = await retireV1SiteRecord({ env, config, store, session, record, client });
  if (result.status === 'retired') return jsonOk({ result });
  return v1RetireError(result.stage, result.error.code, result.error.message, result.httpStatus, result.error.action, result);
}

async function bulkRetireAdminV1Sites(request, env, config, store, session) {
  const client = createV1SitesAdminClient(env);
  if (
    !client ||
    typeof client.listSites !== 'function' ||
    client.retirementSupported === false ||
    typeof store.getHostnameClaim !== 'function' ||
    typeof store.releaseHostnameClaim !== 'function'
  ) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: null, workerName: null, hostname: null },
      'capability_check',
      'deny',
      503
    );
    return jsonError('V1_SITES_UNSUPPORTED', 'Legacy v1 site retirement is unavailable.', 503, 'Configure v1 inventory access.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: null, workerName: null, hostname: null },
      'request_validation',
      'deny',
      400
    );
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const names = normalizeV1SiteNames(body.names);
  if (!names || names.length === 0 || names.length > V1_SITE_BULK_RETIRE_LIMIT) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: null, workerName: null, hostname: null },
      'request_validation',
      'deny',
      400
    );
  }
  if (!names) {
    return jsonError('V1_SITE_NAMES_INVALID', 'Legacy v1 site names are invalid.', 400, 'Send a non-empty names array.');
  }
  if (names.length === 0) {
    return jsonError('V1_SITE_NAMES_REQUIRED', 'Legacy v1 site names are required.', 400, 'Select at least one site.');
  }
  if (names.length > V1_SITE_BULK_RETIRE_LIMIT) {
    return jsonError('V1_SITE_BATCH_TOO_LARGE', 'Too many legacy v1 sites selected.', 400, 'Select at most 100 sites.');
  }

  let siteKeys;
  try {
    siteKeys = await client.listSites();
  } catch {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: null, workerName: null, hostname: null },
      'metadata_read',
      'deny',
      502
    );
    return jsonError(
      'V1_SITES_READ_FAILED',
      'Legacy v1 site inventory could not be read.',
      502,
      'Check Cloudflare credentials and retry.'
    );
  }
  const records = new Map(
    (siteKeys || [])
      .map((site) => readV1SiteRecord(site))
      .filter(Boolean)
      .map((record) => [record.name, record])
  );
  const results = await mapNormalWorkerDeleteBatch(names, async (name) => {
    const record = records.get(name);
    if (!record) {
      await recordV1RetireAuditSafe(
        store,
        env,
        config,
        session,
        { name, workerName: null, hostname: null },
        'metadata_read',
        'deny',
        404
      );
      return {
        name,
        status: 'failed',
        stage: 'metadata_read',
        httpStatus: 404,
        error: {
          code: 'V1_SITE_NOT_FOUND',
          message: 'Legacy v1 site was not found.',
          action: 'Refresh the v1 site inventory.',
        },
      };
    }
    return retireV1SiteRecord({ env, config, store, session, record, client });
  });

  return jsonOk({
    summary: {
      requested: names.length,
      retired: results.filter((result) => result.status === 'retired').length,
      failed: results.filter((result) => result.status === 'failed').length,
    },
    results: results.map(formatV1RetireResult),
  });
}

async function retireV1SiteRecord({ env, config, store, session, record, client }) {
  const reservedWorkerNames = readV1ReservedWorkerNames(env);
  const resolvedScriptName = await resolveV1RetireScriptName({ record, client, environment: config.environment });
  if (resolvedScriptName.error) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: record.name, workerName: null, hostname: null },
      'metadata_read',
      'deny',
      resolvedScriptName.httpStatus
    );
    return v1RetireFailure(
      record.name,
      'metadata_read',
      resolvedScriptName.error.code,
      resolvedScriptName.error.message,
      resolvedScriptName.httpStatus,
      resolvedScriptName.error.action
    );
  }
  const workerName = resolvedScriptName.workerName;
  const expectedWorkerName = expectedV1WorkerName(record.name, config.environment);
  const earlyBase = { name: record.name, workerName: expectedWorkerName, hostname: null };
  if (reservedWorkerNames.has(expectedWorkerName) || reservedWorkerNames.has(String(workerName || '').toLowerCase())) {
    await recordV1RetireAuditSafe(store, env, config, session, earlyBase, 'platform_reserved', 'deny', 409);
    return v1RetireFailure(
      record.name,
      'platform_reserved',
      'V1_SITE_PLATFORM_RESERVED',
      'Platform-reserved Worker cannot be retired.',
      409,
      'Choose a user-owned v1 site.'
    );
  }
  if (
    !isValidV1SiteScriptName(record.name, workerName, config.environment) ||
    !isManagedV1WorkerName(workerName, config.environment)
  ) {
    await recordV1RetireAuditSafe(store, env, config, session, earlyBase, 'metadata_read', 'deny', 409);
    return v1RetireFailure(
      record.name,
      'metadata_read',
      'V1_SITE_SCRIPT_INVALID',
      'Legacy v1 site script metadata is invalid.',
      409,
      'Refresh the v1 site inventory.'
    );
  }
  const hostname = readV1Hostname(record.url);
  if (!hostname) {
    await recordV1RetireAuditSafe(store, env, config, session, earlyBase, 'route_unbind', 'deny', 409);
    return v1RetireFailure(
      record.name,
      'route_unbind',
      'V1_SITE_ROUTE_UNSAFE',
      'Legacy v1 hostname is missing or unsafe.',
      409,
      'Refresh the v1 site inventory and verify the hostname.'
    );
  }
  if (
    typeof client.deleteWorker !== 'function' ||
    typeof client.unbindRoute !== 'function' ||
    typeof client.deleteSite !== 'function'
  ) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: record.name, workerName, hostname },
      'capability_check',
      'deny',
      503
    );
    return v1RetireFailure(
      record.name,
      'capability_check',
      'V1_SITES_UNSUPPORTED',
      'Legacy v1 site retirement is unavailable.',
      503,
      'Configure Cloudflare account, zone, and KV access.'
    );
  }

  const base = { name: record.name, workerName, hostname };
  let existingClaim;
  try {
    existingClaim = await store.getHostnameClaim(hostname);
  } catch {
    await recordV1RetireAuditSafe(store, env, config, session, base, 'hostname_claim_validation', 'deny', 502);
    return v1RetireFailure(
      record.name,
      'hostname_claim_validation',
      'V1_SITE_HOSTNAME_CLAIM_READ_FAILED',
      'Legacy v1 hostname claim could not be read.',
      502,
      'Check hostname claims and retry.'
    );
  }
  if (existingClaim && !v1HostnameClaimMatches(existingClaim, config, record, workerName)) {
    await recordV1RetireAuditSafe(store, env, config, session, base, 'hostname_claim_validation', 'deny', 409);
    return v1RetireFailure(
      record.name,
      'hostname_claim_validation',
      'V1_SITE_HOSTNAME_CLAIM_UNSAFE',
      'Legacy v1 hostname claim belongs to another resource.',
      409,
      'Review the hostname claim before retrying.'
    );
  }
  try {
    await recordV1RetireAudit(store, env, config, session, base, 'validation', 'allow', 200);
  } catch {
    return v1RetireFailure(
      record.name,
      'audit',
      'V1_SITE_AUDIT_FAILED',
      'V1 site retirement audit could not be written.',
      500,
      'Retry after checking the audit store.'
    );
  }

  try {
    await client.deleteWorker({ workerName });
  } catch (error) {
    await recordV1RetireAuditSafe(store, env, config, session, base, 'worker_delete', 'deny', 502);
    return v1RetireFailure(
      record.name,
      'worker_delete',
      'V1_SITE_WORKER_DELETE_FAILED',
      'Legacy v1 Worker could not be deleted.',
      502,
      `Cause: ${cloudflareFailureCause(error)}. Check Cloudflare credentials and retry.`
    );
  }
  await recordV1RetireAuditSafe(store, env, config, session, base, 'worker_delete', 'allow', 200);

  try {
    await client.unbindRoute({ hostname, expectedScriptName: workerName, environment: config.environment });
  } catch (error) {
    await recordV1RetireAuditSafe(store, env, config, session, base, 'route_unbind', 'deny', 502);
    return v1RetireFailure(
      record.name,
      'route_unbind',
      'V1_SITE_ROUTE_UNBIND_FAILED',
      'Legacy v1 hostname route could not be unbound.',
      502,
      `Cause: ${cloudflareFailureCause(error)}. Verify the exact route and retry.`
    );
  }
  await recordV1RetireAuditSafe(store, env, config, session, base, 'route_unbind', 'allow', 200);

  // The claim must be released before the KV record is deleted: the KV record is the
  // retry anchor for this site, and every failure after its deletion would strand an
  // active claim with no admin-channel recovery path.
  if (existingClaim && !['released', 'held'].includes(existingClaim.status)) {
    let released;
    try {
      released = await store.releaseHostnameClaim({
        environment: config.environment,
        hostname,
        normalizedSlug: record.name,
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: `v1:${config.environment}:${record.name}`,
        ownerRef: workerName,
        source: 'v1_delete',
        status: 'active',
        releaseReason: 'site_retired',
        reuseHoldUntil: addSecondsIso(readNow(env), readReuseHoldSeconds(env)),
        releasedAt: readNow(env),
      });
    } catch {
      released = null;
    }
    if (!released?.ok) {
      await recordV1RetireAuditSafe(store, env, config, session, base, 'hostname_claim_release', 'deny', 502);
      return v1RetireFailure(
        record.name,
        'hostname_claim_release',
        'V1_SITE_HOSTNAME_CLAIM_RELEASE_FAILED',
        'Legacy v1 hostname claim could not be released.',
        502,
        'Check hostname claims and retry.'
      );
    }
  }
  await recordV1RetireAuditSafe(store, env, config, session, base, 'hostname_claim_release', 'allow', 200);

  try {
    await client.deleteSite(record.name);
  } catch (error) {
    await recordV1RetireAuditSafe(store, env, config, session, base, 'kv_delete', 'deny', 502);
    return v1RetireFailure(
      record.name,
      'kv_delete',
      'V1_SITE_KV_DELETE_FAILED',
      'Legacy v1 site metadata could not be deleted.',
      502,
      `Cause: ${cloudflareFailureCause(error)}. Check Cloudflare KV credentials and retry.`
    );
  }
  await recordV1RetireAuditSafe(store, env, config, session, base, 'kv_delete', 'allow', 200);
  return { ...base, status: 'retired' };
}

function v1HostnameClaimMatches(claim, config, record, workerName) {
  return (
    claim.environment === config.environment &&
    claim.ownerSystem === 'v1' &&
    claim.ownerId === `v1:${config.environment}:${record.name}` &&
    (!claim.ownerRef || claim.ownerRef === workerName)
  );
}

async function recordV1RetireAudit(store, env, config, session, site, stage, decision, statusCode) {
  if (typeof store.recordAuditEvent !== 'function') throw new Error('V1_SITE_AUDIT_UNSUPPORTED');
  return store.recordAuditEvent({
    id: nextId(env, 'audit'),
    environment: config.environment,
    eventType: 'admin.v1_site_retire',
    actorUserId: session.user?.userId || session.userId || null,
    actorType: 'platform_admin',
    decision,
    statusCode,
    metadata: {
      siteName: site.name,
      workerName: site.workerName,
      hostname: site.hostname,
      stage,
    },
    createdAt: readNow(env),
  });
}

async function recordV1RetireAuditSafe(store, env, config, session, site, stage, decision, statusCode) {
  try {
    await recordV1RetireAudit(store, env, config, session, site, stage, decision, statusCode);
  } catch {}
}

async function resolveV1RetireScriptName({ record, client, environment }) {
  if (record.scriptName) return { workerName: record.scriptName };
  // v1 stores scriptName only in the KV value body, not in list-key metadata (deploy.js
  // writes a reduced metadata object), so retirement reads the authoritative record here.
  if (typeof client.getSiteRecord === 'function') {
    let value;
    try {
      value = await client.getSiteRecord(record.name);
    } catch {
      return {
        httpStatus: 502,
        error: {
          code: 'V1_SITE_METADATA_READ_FAILED',
          message: 'Legacy v1 site record could not be read.',
          action: 'Check Cloudflare KV credentials and retry.',
        },
      };
    }
    if (!value) {
      return {
        httpStatus: 404,
        error: {
          code: 'V1_SITE_NOT_FOUND',
          message: 'Legacy v1 site was not found.',
          action: 'Refresh the v1 site inventory.',
        },
      };
    }
    if (value.scriptName) return { workerName: value.scriptName };
  }
  // The strict validation below requires scriptName to equal the derived per-site name,
  // so the derived name is the only value a missing field could legally hold.
  return { workerName: expectedV1WorkerName(record.name, environment) };
}

function findV1SiteRecord(siteKeys, name) {
  const normalizedName = normalizeRequiredString(name);
  if (!normalizedName) return null;
  return (siteKeys || []).map((site) => readV1SiteRecord(site)).find((record) => record?.name === normalizedName) || null;
}

function normalizeV1SiteNames(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const names = [];
  for (const item of value) {
    const name = normalizeRequiredString(item);
    if (!name) return null;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatV1RetireResult(result) {
  return {
    name: result.name,
    status: result.status,
    ...(result.workerName ? { workerName: result.workerName } : {}),
    ...(result.hostname ? { hostname: result.hostname } : {}),
    ...(result.stage ? { stage: result.stage } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function v1RetireFailure(name, stage, code, message, httpStatus, action) {
  return {
    name,
    status: 'failed',
    stage,
    httpStatus,
    error: { code, message, action },
  };
}

function v1RetireError(stage, code, message, status, action, result = null) {
  return jsonResponse(
    {
      error: { code, message, stage, ...(action ? { action } : {}) },
      ...(result ? { result: formatV1RetireResult(result) } : {}),
    },
    status,
    { 'Cache-Control': 'no-store' }
  );
}

function readV1Hostname(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith('.workers.xd.team')) return null;
    const label = hostname.slice(0, -'.workers.xd.team'.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
    return hostname;
  } catch {
    return null;
  }
}

function readReuseHoldSeconds(env) {
  const value = Number(env?.HOSTNAME_REUSE_HOLD_SECONDS || 300);
  return Number.isInteger(value) && value >= 0 && value <= 86_400 ? value : 300;
}

function addSecondsIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function getAdminOps(config) {
  const checkedAt = new Date().toISOString();
  return jsonOk({
    ops: [
      {
        id: 'cloudflare',
        label: 'Cloudflare 控制面',
        status: 'unknown',
        checkedAt,
        source: config.environment,
      },
      {
        id: 'console-ip-guard',
        label: 'Console IP Guard',
        status: 'configured',
        checkedAt,
        source: 'pages-console',
      },
    ],
  });
}

async function listAdminNormalWorkers(config, store) {
  if (typeof store.listAdminNormalWorkers !== 'function') {
    return jsonError('NORMAL_WORKERS_UNSUPPORTED', 'Normal Worker management is unavailable.', 503, 'Retry later.');
  }
  const workers = await store.listAdminNormalWorkers({ environment: config.environment });
  return jsonOk({ workers: workers.map(formatAdminNormalWorker) });
}

async function listDeploymentCleanups(url, env, config, store) {
  if (typeof store.listDeploymentResourceCleanupTasks !== 'function') {
    return jsonError('CLEANUP_TASKS_UNSUPPORTED', 'Deployment cleanup tasks are unavailable.', 503, 'Retry later.');
  }
  const status = normalizeNullableString(url.searchParams.get('status'));
  const tasks = await store.listDeploymentResourceCleanupTasks({ environment: config.environment, status });
  return jsonOk({ tasks: tasks.map((task) => formatDeploymentCleanupTask(task, env)) });
}

async function runDueDeploymentCleanupsAdmin(request, env, config, store, session) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 8 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object with a limit.');
  }
  const limit = normalizeCleanupRunDueLimit(body?.limit);
  if (limit === null) {
    return jsonError('CLEANUP_RUN_LIMIT_INVALID', 'Cleanup run limit is invalid.', 400, 'Send an integer limit from 1 to 50.');
  }
  const summary = await runDueDeploymentCleanups(env, config, store, { limit });
  await recordResourceGovernanceAuditSafe(store, env, config, session, {
    eventType: 'admin.cleanup_run_due',
    stage: 'run_due',
    decision: 'allow',
    statusCode: 200,
    metadata: {
      limit,
      processed: summary.processed,
      succeeded: summary.succeeded,
      failed: summary.failed,
      skipped: summary.skipped,
    },
  });
  return jsonOk({ summary });
}

async function backfillAdminWorkerOrphans(request, env, config, store, session) {
  if (
    typeof store.listWorkerOrphanScanReferences !== 'function' ||
    typeof store.createDeploymentResourceCleanupTask !== 'function'
  ) {
    return jsonError('WORKER_ORPHAN_BACKFILL_UNSUPPORTED', 'Worker orphan backfill is unavailable.', 503, 'Retry later.');
  }
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a workerNames array.');
  }
  if (!Array.isArray(body?.workerNames)) {
    return jsonError('WORKER_ORPHAN_NAMES_INVALID', 'Worker names are invalid.', 400, 'Send a workerNames array.');
  }
  const workerNames = normalizeBackfillWorkerNames(body.workerNames);
  if (!workerNames) {
    return jsonError(
      'WORKER_ORPHAN_NAMES_INVALID',
      'Worker names are invalid.',
      400,
      'Each Worker name must be a non-empty string.'
    );
  }
  if (workerNames.length === 0) {
    return jsonError('WORKER_ORPHAN_NAMES_REQUIRED', 'Worker names are required.', 400, 'Select at least one Worker.');
  }
  if (workerNames.length > WFP_ORPHAN_BACKFILL_LIMIT) {
    return jsonError('WORKER_ORPHAN_BATCH_TOO_LARGE', 'Too many Workers selected.', 400, 'Select at most 100 Workers.');
  }

  const client = createWfpScanAdminClient(env, config);
  if (!client) {
    return jsonError(
      'WORKER_ORPHAN_BACKFILL_UNSUPPORTED',
      'Worker orphan backfill is unavailable.',
      503,
      'Configure Cloudflare WFP inventory access.'
    );
  }

  const result = await createWorkerOrphanBackfillApplication({ env, config, store, session, client }).backfill({
    environment: config.environment,
    limit: readWorkerOrphanScanLimit(env),
    workerNames,
  });
  if (result.reason === 'revalidation_failed') {
    return jsonError(
      'WORKER_ORPHAN_BACKFILL_FAILED',
      'Worker orphan backfill could not revalidate resources.',
      502,
      'Retry later.'
    );
  }
  if (result.reason === 'scan_incomplete') {
    return jsonError(
      'WORKER_ORPHAN_SCAN_INCOMPLETE',
      'Worker orphan backfill requires a complete server-side inventory.',
      400,
      'Run a complete orphan scan and retry.'
    );
  }
  if (result.reason === 'limit_exceeded') {
    return jsonError(
      'WORKER_ORPHAN_SCAN_LIMIT_EXCEEDED',
      'Worker orphan scan exceeds the configured inventory limit.',
      413,
      'Increase PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS or narrow the upstream inventory before retrying.'
    );
  }
  if (result.ok) return jsonOk({ summary: result.summary, results: result.results });
  throw new Error('WORKER_ORPHAN_BACKFILL_RESULT_INVALID');
}

function createWorkerOrphanBackfillApplication({ env, config, store, session, client }) {
  return createWorkerOrphanBackfill({
    inventory: { list: (query) => client.listWorkers(query) },
    references: { list: (query) => store.listWorkerOrphanScanReferences(query) },
    workers: {
      isManaged: isManagedWfpWorkerName,
      isResource: isWfpWorkerResource,
    },
    cleanupTasks: { create: (task) => store.createDeploymentResourceCleanupTask(task) },
    audits: {
      record: (input) => recordResourceGovernanceAuditSafe(store, env, config, session, input),
    },
    ids: { next: newId },
    clock: { now: () => readNow(env) },
  });
}

async function recordResourceGovernanceAuditSafe(store, env, config, session, input) {
  if (typeof store.recordAuditEvent !== 'function') return;
  try {
    await store.recordAuditEvent({
      id: nextId(env, 'audit'),
      environment: config.environment,
      eventType: input.eventType,
      actorUserId: session?.user?.userId || session?.userId || null,
      actorType: 'platform_admin',
      decision: input.decision,
      statusCode: input.statusCode,
      metadata: { ...input.metadata, stage: input.stage },
      createdAt: readNow(env),
    });
  } catch {}
}

function normalizeCleanupRunDueLimit(value) {
  if (value === undefined || value === null || value === '') return 10;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) return null;
  return value;
}

function normalizeBackfillWorkerNames(values) {
  const names = [];
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    if (!name || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

async function runDeploymentCleanupTask(env, config, store, session, taskId) {
  if (
    typeof store.getDeploymentResourceCleanupTask !== 'function' ||
    typeof store.markDeploymentResourceCleanupRunning !== 'function' ||
    typeof store.finishDeploymentResourceCleanupTask !== 'function'
  ) {
    await recordResourceGovernanceAuditSafe(store, env, config, session, {
      eventType: 'admin.cleanup_run',
      stage: 'run',
      decision: 'deny',
      statusCode: 503,
      metadata: { taskId, resourceRef: null, outcome: 'failed', result: 'CLEANUP_TASKS_UNSUPPORTED' },
    });
    return jsonError('CLEANUP_TASKS_UNSUPPORTED', 'Deployment cleanup tasks are unavailable.', 503, 'Retry later.');
  }

  let task;
  try {
    task = await store.getDeploymentResourceCleanupTask(taskId, config.environment);
  } catch {
    await recordResourceGovernanceAuditSafe(store, env, config, session, {
      eventType: 'admin.cleanup_run',
      stage: 'run',
      decision: 'deny',
      statusCode: 500,
      metadata: { taskId, resourceRef: null, outcome: 'failed', result: CLEANUP_TASK_FAILED_CODE },
    });
    return jsonError(
      CLEANUP_TASK_FAILED_CODE,
      CLEANUP_TASK_FAILED_MESSAGE,
      500,
      'Review the cleanup task diagnostics and retry.'
    );
  }
  if (!task) {
    await recordResourceGovernanceAuditSafe(store, env, config, session, {
      eventType: 'admin.cleanup_run',
      stage: 'run',
      decision: 'deny',
      statusCode: 404,
      metadata: { taskId, resourceRef: null, outcome: 'failed', result: 'CLEANUP_TASK_NOT_FOUND' },
    });
    return jsonError('CLEANUP_TASK_NOT_FOUND', 'Cleanup task not found.', 404, 'Check the cleanup task id.');
  }
  let result;
  try {
    result = await executeDeploymentCleanupTask(env, config, store, task);
  } catch {
    result = unexpectedCleanupTaskError();
  }
  await recordResourceGovernanceAuditSafe(store, env, config, session, {
    eventType: 'admin.cleanup_run',
    stage: 'run',
    decision: result.ok ? 'allow' : result.httpStatus === 409 ? 'skip' : 'deny',
    statusCode: result.ok ? 200 : result.httpStatus,
    metadata: {
      taskId,
      resourceRef: task.resourceRef,
      outcome: result.ok ? 'succeeded' : result.httpStatus === 409 ? 'skipped' : 'failed',
      result: result.ok ? 'succeeded' : result.error.code,
    },
  });
  if (!result.ok) {
    return jsonError(result.error.code, result.error.message, result.httpStatus, result.error.action);
  }
  return jsonOk({ task: formatDeploymentCleanupTask(result.task, env) });
}

export async function runDueDeploymentCleanups(env, config, store, { limit = 10 } = {}) {
  if (
    typeof store.listDeploymentResourceCleanupTasks !== 'function' ||
    typeof store.getDeploymentResourceCleanupTask !== 'function' ||
    typeof store.markDeploymentResourceCleanupRunning !== 'function' ||
    typeof store.finishDeploymentResourceCleanupTask !== 'function'
  ) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const runnableTasks = await listRunnableDeploymentCleanupTasks(store, config.environment, normalizedLimit);
  const summary = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  for (const task of runnableTasks.filter((item) => cleanupTaskCanRun(item, env)).slice(0, normalizedLimit)) {
    let result;
    try {
      const latest = await store.getDeploymentResourceCleanupTask(task.id, config.environment);
      result = await executeDeploymentCleanupTask(env, config, store, latest);
    } catch {
      result = unexpectedCleanupTaskError();
    }
    summary.processed += 1;
    if (result.ok) summary.succeeded += 1;
    else if (result.httpStatus >= 500) summary.failed += 1;
    else summary.skipped += 1;
  }
  return summary;
}

async function listRunnableDeploymentCleanupTasks(store, environment, limit) {
  const taskGroups = await Promise.all(
    ['pending', 'failed', 'running'].map((status) =>
      store.listDeploymentResourceCleanupTasks({
        environment,
        status,
        limit,
      })
    )
  );
  const tasksById = new Map();
  for (const task of taskGroups.flat()) tasksById.set(task.id, task);
  return [...tasksById.values()].sort(
    (left, right) => left.cleanupAfter.localeCompare(right.cleanupAfter) || left.createdAt.localeCompare(right.createdAt)
  );
}

async function executeDeploymentCleanupTask(env, config, store, task) {
  if (!cleanupTaskCanRun(task, env)) {
    return cleanupTaskError(
      'CLEANUP_TASK_NOT_RUNNABLE',
      'Cleanup task cannot run yet.',
      409,
      'Wait for the drain window or refresh.'
    );
  }
  if (task.resourceType === 'v1_sites_kv_record') {
    return executeV1SitesKvCleanupTask(env, config, store, task);
  }
  if (task.resourceType === 'v1_worker_script') {
    return executeV1WorkerCleanupTask(env, config, store, task);
  }
  if (task.resourceType !== 'wfp_user_worker' || !isManagedWfpWorkerName(task.resourceRef, config.environment)) {
    return cleanupTaskError(
      'CLEANUP_RESOURCE_UNSUPPORTED',
      'Cleanup resource is unsupported.',
      409,
      'Review the cleanup task resource.'
    );
  }

  const ownership = await validateCleanupWfpOwnership(store, config, task);
  if (!ownership.ok) return ownership.error;

  const activeRoute = await findCleanupActiveRoute(store, config, task);
  if (activeRoute) {
    return cleanupTaskError(
      'CLEANUP_RESOURCE_ACTIVE',
      'Cleanup resource is still referenced by an active route.',
      409,
      'Wait for route caches to drain or redeploy before deleting this Worker.'
    );
  }

  const lockedUntil = new Date(Date.parse(readNow(env)) + CLEANUP_TASK_LOCK_SECONDS * 1000).toISOString();
  const running = await store.markDeploymentResourceCleanupRunning({
    id: task.id,
    environment: config.environment,
    lockedUntil,
    updatedAt: readNow(env),
  });
  if (!running || running.status !== 'running') {
    return cleanupTaskError('CLEANUP_TASK_NOT_RUNNABLE', 'Cleanup task cannot run yet.', 409, 'Refresh and retry.');
  }

  let versionMarkedRetiring = null;
  let workerDeleted = false;
  try {
    versionMarkedRetiring = await markCleanupVersionAvailability(store, config, task, 'retiring');
    const activeRouteAfterLock = await findCleanupActiveRoute(store, config, task);
    if (activeRouteAfterLock) {
      if (versionMarkedRetiring) await markCleanupVersionAvailability(store, config, task, 'active');
      await store.finishDeploymentResourceCleanupTask({
        id: task.id,
        environment: config.environment,
        status: 'failed',
        errorCode: 'CLEANUP_RESOURCE_ACTIVE',
        errorMessage: 'Cleanup resource became active before deletion.',
        updatedAt: readNow(env),
      });
      return cleanupTaskError(
        'CLEANUP_RESOURCE_ACTIVE',
        'Cleanup resource is still referenced by an active route.',
        409,
        'Wait for route caches to drain or redeploy before deleting this Worker.'
      );
    }

    try {
      await createWfpCleanupAdminClient(env, config).deleteWorker({ workerName: task.resourceRef });
      workerDeleted = true;
    } catch {
      if (versionMarkedRetiring) await markCleanupVersionAvailability(store, config, task, 'active');
      await store.finishDeploymentResourceCleanupTask({
        id: task.id,
        environment: config.environment,
        status: 'failed',
        errorCode: 'CLEANUP_DELETE_FAILED',
        errorMessage: 'Worker could not be deleted from Cloudflare.',
        updatedAt: readNow(env),
      });
      return cleanupTaskError(
        'CLEANUP_DELETE_FAILED',
        'Worker could not be deleted from Cloudflare.',
        502,
        'Check Cloudflare credentials and retry the cleanup task.'
      );
    }

    try {
      await markCleanupVersionAvailability(store, config, task, 'retired');
      const succeeded = await store.finishDeploymentResourceCleanupTask({
        id: task.id,
        environment: config.environment,
        status: 'succeeded',
        updatedAt: readNow(env),
      });
      return { ok: true, task: succeeded };
    } catch {
      await store.finishDeploymentResourceCleanupTask({
        id: task.id,
        environment: config.environment,
        status: 'failed',
        errorCode: 'CLEANUP_STATE_UPDATE_FAILED',
        errorMessage: 'Cleanup state could not be persisted after Worker deletion.',
        updatedAt: readNow(env),
      });
      return cleanupTaskError(
        'CLEANUP_STATE_UPDATE_FAILED',
        'Cleanup state could not be persisted after Worker deletion.',
        502,
        'Review the cleanup task and retry after checking D1 state.'
      );
    }
  } catch {
    if (versionMarkedRetiring && !workerDeleted) {
      try {
        await markCleanupVersionAvailability(store, config, task, 'active');
      } catch {}
    }
    try {
      await store.finishDeploymentResourceCleanupTask({
        id: task.id,
        environment: config.environment,
        status: 'failed',
        errorCode: CLEANUP_TASK_FAILED_CODE,
        errorMessage: CLEANUP_TASK_FAILED_MESSAGE,
        updatedAt: readNow(env),
      });
    } catch {}
    return unexpectedCleanupTaskError();
  }
}

async function validateCleanupWfpOwnership(store, config, task) {
  try {
    if (typeof store.listWorkerCleanupOwnershipReferences !== 'function') {
      return {
        ok: false,
        error: cleanupTaskError(
          'CLEANUP_RESOURCE_VALIDATION_FAILED',
          'Cleanup resource ownership could not be verified.',
          502,
          'Retry after checking D1 access.'
        ),
      };
    }
    const ownershipReferences = await store.listWorkerCleanupOwnershipReferences({
      workerName: task.resourceRef,
      environment: config.environment,
    });
    const ownershipRecords = [...(ownershipReferences?.routes || []), ...(ownershipReferences?.versions || [])];
    if (
      ownershipRecords.some(
        (record) => record.ownershipEnvironment !== config.environment || !isWfpWorkerResource(record, config.environment)
      )
    ) {
      return {
        ok: false,
        error: cleanupTaskError(
          'CLEANUP_RESOURCE_UNSUPPORTED',
          'Cleanup resource is unsupported.',
          409,
          'Review the cleanup task resource.'
        ),
      };
    }
    if (task.versionId) {
      if (typeof store.getSiteVersion !== 'function') {
        return {
          ok: false,
          error: cleanupTaskError(
            'CLEANUP_RESOURCE_VALIDATION_FAILED',
            'Cleanup resource ownership could not be verified.',
            502,
            'Retry after checking D1 access.'
          ),
        };
      }
      const version = await store.getSiteVersion(task.versionId, config.environment);
      if (!version || version.workerName !== task.resourceRef || !isWfpWorkerResource(version, config.environment)) {
        return {
          ok: false,
          error: cleanupTaskError(
            'CLEANUP_RESOURCE_UNSUPPORTED',
            'Cleanup resource is unsupported.',
            409,
            'Review the cleanup task resource.'
          ),
        };
      }
      return { ok: true };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: cleanupTaskError(
        'CLEANUP_RESOURCE_VALIDATION_FAILED',
        'Cleanup resource ownership could not be verified.',
        502,
        'Retry after checking D1 access.'
      ),
    };
  }
}

async function executeV1WorkerCleanupTask(env, config, store, task) {
  const site = typeof store.getSite === 'function' && task.siteId ? await store.getSite(task.siteId) : null;
  const target = resolveDeferredLegacyV1WorkerTarget({ environment: config.environment, task, site });
  if (!target) {
    return cleanupTaskError(
      'CLEANUP_RESOURCE_UNSUPPORTED',
      'Cleanup resource is unsupported.',
      409,
      'Review the cleanup task resource.'
    );
  }

  const now = readNow(env);
  const lockedUntil = new Date(Date.parse(now) + CLEANUP_TASK_LOCK_SECONDS * 1000).toISOString();
  const running = await store.markDeploymentResourceCleanupRunning({
    id: task.id,
    environment: config.environment,
    lockedUntil,
    updatedAt: now,
  });
  if (!running || running.status !== 'running') {
    return cleanupTaskError('CLEANUP_TASK_NOT_RUNNABLE', 'Cleanup task cannot run yet.', 409, 'Refresh and retry.');
  }

  let result;
  try {
    result = await cleanupDeferredLegacyV1WorkerScript({ env, target });
  } catch {
    await store.finishDeploymentResourceCleanupTask({
      id: task.id,
      environment: config.environment,
      status: 'failed',
      errorCode: 'V1_WORKER_DELETE_FAILED',
      errorMessage: 'Legacy Worker could not be safely deleted from Cloudflare.',
      updatedAt: readNow(env),
    });
    return cleanupTaskError(
      'V1_WORKER_DELETE_FAILED',
      'Legacy Worker could not be safely deleted from Cloudflare.',
      502,
      'Check Cloudflare credentials and route references, then retry the cleanup task.'
    );
  }

  if (result.workerCleanup === 'deferred_shared_route') {
    await store.finishDeploymentResourceCleanupTask({
      id: task.id,
      environment: config.environment,
      status: 'failed',
      errorCode: 'CLEANUP_RESOURCE_ACTIVE',
      errorMessage: 'Legacy Worker is still referenced by a Cloudflare route.',
      updatedAt: readNow(env),
    });
    return cleanupTaskError(
      'CLEANUP_RESOURCE_ACTIVE',
      'Cleanup resource is still referenced by an active route.',
      409,
      'Remove the remaining route reference before deleting this Worker.'
    );
  }

  try {
    const succeeded = await store.finishDeploymentResourceCleanupTask({
      id: task.id,
      environment: config.environment,
      status: 'succeeded',
      updatedAt: readNow(env),
    });
    return { ok: true, task: succeeded };
  } catch {
    try {
      await store.finishDeploymentResourceCleanupTask({
        id: task.id,
        environment: config.environment,
        status: 'failed',
        errorCode: 'CLEANUP_STATE_UPDATE_FAILED',
        errorMessage: 'Cleanup state could not be persisted after Worker deletion.',
        updatedAt: readNow(env),
      });
    } catch {}
    return cleanupTaskError(
      'CLEANUP_STATE_UPDATE_FAILED',
      'Cleanup state could not be persisted after Worker deletion.',
      502,
      'Review the cleanup task and retry after checking D1 state.'
    );
  }
}

async function executeV1SitesKvCleanupTask(env, config, store, task) {
  if (task.environment !== config.environment || !isValidV1SitesKvResourceRef(task.resourceRef)) {
    return cleanupTaskError(
      'CLEANUP_RESOURCE_UNSUPPORTED',
      'Cleanup resource is unsupported.',
      409,
      'Review the cleanup task resource.'
    );
  }
  if (!env?.V1_SITES || typeof env.V1_SITES.delete !== 'function') {
    return cleanupTaskError(
      'CLEANUP_RESOURCE_UNAVAILABLE',
      'Legacy site cleanup is unavailable.',
      503,
      'Check the pages-api KV binding and retry the cleanup task.'
    );
  }

  const now = readNow(env);
  const lockedUntil = new Date(Date.parse(now) + CLEANUP_TASK_LOCK_SECONDS * 1000).toISOString();
  const running = await store.markDeploymentResourceCleanupRunning({
    id: task.id,
    environment: config.environment,
    lockedUntil,
    updatedAt: now,
  });
  if (!running || running.status !== 'running') {
    return cleanupTaskError('CLEANUP_TASK_NOT_RUNNABLE', 'Cleanup task cannot run yet.', 409, 'Refresh and retry.');
  }

  try {
    await env.V1_SITES.delete(task.resourceRef);
  } catch {
    await store.finishDeploymentResourceCleanupTask({
      id: task.id,
      environment: config.environment,
      status: 'failed',
      errorCode: 'V1_SITES_KV_DELETE_FAILED',
      errorMessage: 'Legacy site record could not be deleted from KV.',
      updatedAt: readNow(env),
    });
    return cleanupTaskError(
      'V1_SITES_KV_DELETE_FAILED',
      'Legacy site record could not be deleted from KV.',
      502,
      'Check the pages-api KV binding and retry the cleanup task.'
    );
  }

  try {
    const succeeded = await store.finishDeploymentResourceCleanupTask({
      id: task.id,
      environment: config.environment,
      status: 'succeeded',
      updatedAt: readNow(env),
    });
    return { ok: true, task: succeeded };
  } catch {
    try {
      await store.finishDeploymentResourceCleanupTask({
        id: task.id,
        environment: config.environment,
        status: 'failed',
        errorCode: 'CLEANUP_STATE_UPDATE_FAILED',
        errorMessage: 'Cleanup state could not be persisted after KV deletion.',
        updatedAt: readNow(env),
      });
    } catch {}
    return cleanupTaskError(
      'CLEANUP_STATE_UPDATE_FAILED',
      'Cleanup state could not be persisted after KV deletion.',
      502,
      'Review the cleanup task and retry after checking KV state.'
    );
  }
}

async function findCleanupActiveRoute(store, config, task) {
  if (typeof store.findActiveRouteByWorkerResource !== 'function') return null;
  return store.findActiveRouteByWorkerResource({
    environment: config.environment,
    workerName: task.resourceRef,
    versionId: task.versionId,
  });
}

async function markCleanupVersionAvailability(store, config, task, artifactAvailability) {
  if (typeof store.markSiteVersionArtifactAvailability !== 'function' || !task.versionId) return null;
  return store.markSiteVersionArtifactAvailability({
    id: task.versionId,
    environment: config.environment,
    artifactAvailability,
  });
}

function cleanupTaskError(code, message, httpStatus, action) {
  return { ok: false, httpStatus, error: { code, message, action } };
}

function unexpectedCleanupTaskError() {
  return cleanupTaskError(
    CLEANUP_TASK_FAILED_CODE,
    CLEANUP_TASK_FAILED_MESSAGE,
    500,
    'Review the cleanup task diagnostics and retry.'
  );
}

function cleanupTaskCanRun(task, env) {
  if (!task) return false;
  const now = Date.parse(readNow(env));
  if (Date.parse(task.cleanupAfter) > now) return false;
  if (['pending', 'failed'].includes(task.status)) return true;
  return task.status === 'running' && Boolean(task.lockedUntil) && Date.parse(task.lockedUntil) <= now;
}

function formatDeploymentCleanupTask(task, env) {
  return {
    id: task.id,
    environment: task.environment,
    resourceType: task.resourceType,
    resourceRef: task.resourceRef,
    siteId: task.siteId || null,
    versionId: task.versionId || null,
    deploymentId: task.deploymentId || null,
    cleanupReason: task.cleanupReason,
    status: task.status,
    cleanupAfter: task.cleanupAfter,
    attemptCount: task.attemptCount,
    lastErrorCode: task.lastErrorCode || null,
    lastErrorMessage: task.lastErrorMessage || null,
    lockedUntil: task.lockedUntil || null,
    canRun: cleanupTaskCanRun(task, env),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function createWfpCleanupAdminClient(env, config) {
  if (env.WFP_RESOURCE_ADMIN_CLIENT) return env.WFP_RESOURCE_ADMIN_CLIENT;
  const wfpConfig = readWfpConfig(env, { environment: config.environment });
  const fetchImpl = env.fetch || globalThis.fetch;
  const client = createWfpClient({ ...wfpConfig, fetch: fetchImpl });
  return {
    async deleteWorker({ workerName }) {
      try {
        return await client.deleteUserWorker(workerName);
      } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
    },
  };
}

function createWfpScanAdminClient(env, config) {
  if (env.WFP_RESOURCE_ADMIN_CLIENT) {
    return typeof env.WFP_RESOURCE_ADMIN_CLIENT.listWorkers === 'function' ? env.WFP_RESOURCE_ADMIN_CLIENT : null;
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.WFP_DISPATCH_NAMESPACE) return null;
  try {
    const wfpConfig = readWfpConfig(env, { environment: config.environment });
    const client = createWfpClient({ ...wfpConfig, fetch: env.fetch || globalThis.fetch });
    return {
      listWorkers: (options) => client.listUserWorkers(options),
    };
  } catch {
    return null;
  }
}

function isValidV1SitesKvResourceRef(value) {
  return typeof value === 'string' && value === value.toLowerCase() && /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(value);
}

async function deleteAdminNormalWorker(request, env, config, store, session, slotId) {
  if (typeof store.listAdminNormalWorkers !== 'function' || typeof store.retireIdleNormalWorker !== 'function') {
    return jsonError('NORMAL_WORKERS_UNSUPPORTED', 'Normal Worker management is unavailable.', 503, 'Retry later.');
  }

  let body = {};
  try {
    body = await readJsonBody(request, { maxBytes: 8 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const reason = normalizeNullableString(body.reason) || 'legacy normal worker retired by admin';
  const workers = await store.listAdminNormalWorkers({ environment: config.environment });
  const worker = workers.find((item) => item.id === slotId);
  if (!worker) return jsonError('NORMAL_WORKER_NOT_FOUND', 'Normal Worker not found.', 404, 'Check the worker id.');

  const result = await deleteAdminNormalWorkerRecord({ env, config, store, session, worker, reason });
  return normalWorkerDeleteResultResponse(result);
}

async function bulkDeleteAdminNormalWorkers(request, env, config, store, session) {
  if (typeof store.listAdminNormalWorkers !== 'function' || typeof store.retireIdleNormalWorker !== 'function') {
    return jsonError('NORMAL_WORKERS_UNSUPPORTED', 'Normal Worker management is unavailable.', 503, 'Retry later.');
  }

  let body = {};
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  if (!Array.isArray(body.ids)) {
    return jsonError('NORMAL_WORKER_IDS_INVALID', 'Normal Worker ids are invalid.', 400, 'Send a non-empty ids array.');
  }
  const ids = normalizeNormalWorkerIds(body.ids);
  if (!ids) {
    return jsonError('NORMAL_WORKER_IDS_INVALID', 'Normal Worker ids are invalid.', 400, 'Each id must be a non-empty string.');
  }
  if (ids.length === 0) {
    return jsonError('NORMAL_WORKER_IDS_REQUIRED', 'Normal Worker ids are required.', 400, 'Select at least one Worker.');
  }
  if (ids.length > NORMAL_WORKER_BULK_DELETE_LIMIT) {
    return jsonError('NORMAL_WORKER_BATCH_TOO_LARGE', 'Too many Normal Workers selected.', 400, 'Select at most 100 Workers.');
  }

  const reason = normalizeNullableString(body.reason) || 'legacy normal workers retired by admin';
  const workers = await store.listAdminNormalWorkers({ environment: config.environment });
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const results = await mapNormalWorkerDeleteBatch(ids, async (id) => {
    const worker = workerById.get(id);
    if (!worker) {
      return {
        id,
        status: 'failed',
        error: normalWorkerNotFoundError(),
      };
    }
    return deleteAdminNormalWorkerRecord({ env, config, store, session, worker, reason });
  });

  return jsonOk({
    summary: summarizeNormalWorkerDeleteResults(ids.length, results),
    results: results.map(formatNormalWorkerBatchResult),
  });
}

async function mapNormalWorkerDeleteBatch(ids, mapper) {
  const results = new Array(ids.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(NORMAL_WORKER_BULK_DELETE_CONCURRENCY, ids.length) }, async () => {
    while (nextIndex < ids.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(ids[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function deleteAdminNormalWorkerRecord({ env, config, store, session, worker, reason }) {
  const formatted = formatAdminNormalWorker(worker);
  if (!formatted.canDelete) {
    return {
      id: worker.id,
      status: 'failed',
      httpStatus: 409,
      worker: formatted,
      error: normalWorkerActiveError(),
    };
  }

  try {
    await createNormalWorkerAdminClient(env).deleteWorker({ workerName: worker.workerName });
  } catch (error) {
    if (isNormalWorkerDeleteBlocked(error)) {
      const pending =
        typeof store.markNormalWorkerDeletePending === 'function'
          ? await store.markNormalWorkerDeletePending({
              id: worker.id,
              environment: config.environment,
              actorUserId: session.user.userId,
              reason,
              updatedAt: readNow(env),
            })
          : null;
      if (!pending) {
        return {
          id: worker.id,
          status: 'failed',
          httpStatus: 409,
          worker: formatted,
          error: normalWorkerActiveError(),
        };
      }
      return {
        id: worker.id,
        status: 'delete_pending',
        httpStatus: 202,
        worker: formatAdminNormalWorker(pending),
        warning: normalWorkerDeletePendingWarning(),
      };
    }
    return {
      id: worker.id,
      status: 'failed',
      httpStatus: 502,
      worker: formatted,
      error: normalWorkerDeleteFailedError(),
    };
  }

  let retired;
  try {
    retired = await store.retireIdleNormalWorker({
      id: worker.id,
      environment: config.environment,
      actorUserId: session.user.userId,
      reason,
      updatedAt: readNow(env),
    });
  } catch {
    return {
      id: worker.id,
      status: 'failed',
      httpStatus: 409,
      worker: formatted,
      error: normalWorkerStateInconsistentError(),
    };
  }
  if (!retired) {
    return {
      id: worker.id,
      status: 'failed',
      httpStatus: 409,
      worker: formatted,
      error: normalWorkerStateInconsistentError(),
    };
  }
  return {
    id: worker.id,
    status: 'retired',
    httpStatus: 200,
    worker: formatAdminNormalWorker(retired),
  };
}

async function listAdminUsers(url, config, store) {
  const result = await store.listAdminUsers({
    environment: config.environment,
    query: normalizeNullableString(url.searchParams.get('query')),
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
    admin: url.searchParams.get('admin'),
    status: url.searchParams.get('status'),
  });
  return jsonOk({
    users: result.users.map(formatAdminUser),
    pagination: {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    },
  });
}

function formatAdminNormalWorker(worker) {
  const activeRoute = worker.activeRoute || null;
  const lifecycle = activeRoute
    ? 'active'
    : worker.status === 'retired'
      ? 'retired'
      : isNormalWorkerDeletableStatus(worker.status)
        ? 'idle'
        : worker.status;
  return {
    id: worker.id,
    environment: worker.environment,
    slotNumber: worker.slotNumber,
    workerName: worker.workerName,
    bindingName: worker.bindingName,
    status: worker.status,
    lifecycle,
    canDelete: lifecycle === 'idle',
    activeRoute: activeRoute
      ? {
          siteId: activeRoute.siteId,
          routeId: activeRoute.routeId,
          activeVersionId: activeRoute.activeVersionId,
          hostname: activeRoute.hostname,
        }
      : null,
    updatedAt: worker.updatedAt,
  };
}

function isNormalWorkerDeletableStatus(status) {
  return ['available', 'assigned', 'cleanup_pending', 'disabled', 'delete_pending'].includes(status);
}

function normalWorkerDeleteResultResponse(result) {
  if (result.status === 'failed') {
    return jsonError(result.error.code, result.error.message, result.httpStatus, result.error.action);
  }
  return jsonOk(
    {
      worker: result.worker,
      ...(result.warning ? { warning: result.warning } : {}),
    },
    result.httpStatus
  );
}

function formatNormalWorkerBatchResult(result) {
  return {
    id: result.id,
    status: result.status,
    ...(result.worker ? { worker: result.worker } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function summarizeNormalWorkerDeleteResults(requested, results) {
  return {
    requested,
    retired: results.filter((result) => result.status === 'retired').length,
    pending: results.filter((result) => result.status === 'delete_pending').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
}

function normalizeNormalWorkerIds(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const ids = [];
  for (const item of value) {
    const id = normalizeRequiredString(item);
    if (!id) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createNormalWorkerAdminClient(env) {
  if (env.NORMAL_WORKER_ADMIN_CLIENT) return env.NORMAL_WORKER_ADMIN_CLIENT;
  const accountId = normalizeRequiredString(env.CF_ACCOUNT_ID);
  const apiToken = normalizeRequiredString(env.CF_API_TOKEN);
  const fetchImpl = env.fetch || globalThis.fetch;
  if (!accountId || !apiToken || typeof fetchImpl !== 'function') {
    throw new Error('NORMAL_WORKER_ADMIN_CLIENT_UNAVAILABLE');
  }
  return {
    async deleteWorker({ workerName }) {
      const url = new URL(
        `accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
        'https://api.cloudflare.com/client/v4/'
      );
      const response = await fetchImpl(url.toString(), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (response.status === 404) return null;
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) throw normalWorkerDeleteError(response, payload);
      return payload?.result || payload;
    },
  };
}

function normalWorkerDeleteError(response, payload) {
  const error = new Error('NORMAL_WORKER_DELETE_FAILED');
  error.status = response.status;
  error.code = response.status === 409 ? 'NORMAL_WORKER_DELETE_BLOCKED' : 'NORMAL_WORKER_DELETE_FAILED';
  error.cloudflareErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  return error;
}

function isNormalWorkerDeleteBlocked(error) {
  return error?.code === 'NORMAL_WORKER_DELETE_BLOCKED' || error?.status === 409;
}

function normalWorkerActiveError() {
  return {
    code: 'NORMAL_WORKER_ACTIVE',
    message: 'Normal Worker is still referenced by an active route.',
    action: 'Migrate or redeploy the site to WFP before deleting this Worker.',
  };
}

function normalWorkerDeleteFailedError() {
  return {
    code: 'NORMAL_WORKER_DELETE_FAILED',
    message: 'Normal Worker could not be deleted from Cloudflare.',
    action: 'Check Cloudflare credentials and retry.',
  };
}

function normalWorkerDeletePendingWarning() {
  return {
    code: 'NORMAL_WORKER_DELETE_PENDING',
    message: 'Normal Worker is idle, but Cloudflare deletion is waiting for stale router bindings to drain.',
    action: 'Retry after the next manual router deploy removes stale service bindings.',
  };
}

function normalWorkerNotFoundError() {
  return {
    code: 'NORMAL_WORKER_NOT_FOUND',
    message: 'Normal Worker not found.',
    action: 'Check the worker id.',
  };
}

function normalWorkerStateInconsistentError() {
  return {
    code: 'NORMAL_WORKER_STATE_INCONSISTENT',
    message: 'Normal Worker was deleted from Cloudflare, but D1 state was not retired.',
    action: 'Retry deletion to finish D1 synchronization before the next manual router deploy.',
  };
}

async function listAdminSites(url, config, store) {
  const exposure = normalizeNullableString(url.searchParams.get('exposure'));
  if (exposure && exposure !== 'public' && exposure !== 'internal') {
    return jsonError('SITE_EXPOSURE_INVALID', 'Site exposure filter is invalid.', 400, 'Use public or internal.');
  }
  const sites = await store.listAdminSites({ environment: config.environment, exposure });
  return jsonOk({ sites: sites.map(formatAdminSite) });
}

async function updateAdminSiteExposure(request, env, config, store, session, site) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const exposure = typeof body?.exposure === 'string' ? body.exposure.trim() : '';
  if (exposure !== 'public' && exposure !== 'internal') {
    return jsonError('SITE_EXPOSURE_INVALID', 'Site exposure is invalid.', 400, 'Use internal or public.');
  }
  const reason = normalizeNullableString(body?.reason);
  if (exposure === 'public' && !reason) {
    return jsonError(
      'SITE_EXPOSURE_REASON_REQUIRED',
      'A reason is required to enable public exposure.',
      400,
      'Provide a reason.'
    );
  }
  if (reason && reason.length > 500) {
    return jsonError('SITE_EXPOSURE_REASON_INVALID', 'Exposure reason is too long.', 400, 'Use at most 500 characters.');
  }

  const result = await createSiteExposureUpdateApplication({ store, env, config }).execute({
    environment: config.environment,
    actorUserId: session.userId,
    site,
    exposure,
    reason,
  });
  if (result.ok) {
    return jsonOk({
      access: {
        ...result.access,
        aclEntries: result.access.aclEntries.map(formatAclEntry),
      },
      auditStatus: result.auditStatus,
    });
  }
  if (result.reason === 'required_audit_failed') {
    return jsonError(
      'SITE_EXPOSURE_AUDIT_REQUIRED',
      'Exposure operation was not started because its required audit record could not be written.',
      503,
      'Retry after checking the audit store.'
    );
  }
  if (result.reason === 'site_not_found') {
    return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  }
  if (result.reason === 'public_route_inactive') {
    return jsonError(
      'SITE_PUBLIC_ROUTE_INACTIVE',
      'The site has no active route to expose publicly.',
      409,
      'Deploy an active version before enabling public exposure.'
    );
  }
  if (result.reason === 'repair_required') {
    return adminExposureErrorResponse(Object.assign(new Error('ROUTE_POLICY_REPAIR_REQUIRED'), {
      code: 'ROUTE_POLICY_REPAIR_REQUIRED',
      cause: result.error,
    }));
  }
  return adminExposureErrorResponse(result.error);
}

function createExposureUpdatePreparationApplication({ store, env }) {
  return createExposureUpdatePreparation({
    audits: { record: (event) => store.recordAuditEvent(event) },
    ids: { next: newId },
    clock: { now: () => readNow(env) },
  });
}

function createSiteExposureUpdateApplication({ store, env, config }) {
  return createSiteExposureUpdate({
    preparation: createExposureUpdatePreparationApplication({ store, env }),
    leases: {
      run: ({ environment, siteId }, work) => store.withSiteCommitLock(environment, siteId, work),
    },
    sites: { get: (siteId, environment) => store.getAdminSiteById(siteId, environment) },
    routes: { get: (siteId, environment) => store.getRouteBySiteId(siteId, environment) },
    versions: { get: (versionId, environment) => store.getSiteVersion(versionId, environment) },
    officeNet: {
      ensure: (command) =>
        createExposureOfficeNetVerificationApplication({ env, config, store, site: command.site }).ensure(command),
    },
    policies: { update: (command) => store.updateSiteAccessPolicy(command) },
    snapshots: {
      finalize: (command) => createExposureSnapshotFinalizationApplication({ store, env }).finalize(command),
    },
    audits: { record: (event) => store.recordAuditEvent(event) },
    telemetry: {
      auditUnconfirmed: ({ operationId, siteId, environment, cause }) =>
        globalThis.console?.warn?.(
          'SITE_EXPOSURE_AUDIT_UNCONFIRMED',
          JSON.stringify({
            operationId,
            siteId,
            environment,
            errorCode: safeAdminExposureAuditWarningCode(cause),
          })
        ),
    },
    clock: { now: () => readNow(env) },
  });
}

function createExposureOfficeNetVerificationApplication({ env, config, store, site }) {
  let provider = null;
  return createExposureOfficeNetVerification({
    officeNet: {
      ensure: (command) => {
        provider ||= createDeploymentProvider(env, config, store, site);
        return ensurePublicWorkerOfficeNetAbsent(provider, { store, ...command });
      },
    },
    audits: { record: (event) => store.recordAuditEvent(event) },
    telemetry: {
      auditUnconfirmed: ({ operationId, siteId, environment, stage, cause }) =>
        globalThis.console?.warn?.(
          'SITE_EXPOSURE_STAGE_AUDIT_UNCONFIRMED',
          JSON.stringify({
            operationId,
            siteId,
            environment,
            stage,
            errorCode: safeAdminExposureAuditWarningCode(cause),
          })
        ),
    },
  });
}

function createExposureSnapshotFinalizationApplication({ store, env }) {
  return createExposureSnapshotFinalization({
    snapshots: {
      commit: ({ site, route, environment }) => writeAdminExposureSnapshot(env, store, site, route, environment),
      clearFailed: async ({ site, route, version, aclEntries }) => {
        const state = await readRouteSnapshotState(
          env,
          buildRouteSnapshot({ site, route, version, aclEntries })
        );
        if (state.pointer) await clearRoutePointerIfCurrent(env, state.pointer);
      },
    },
    policies: {
      restore: ({ siteId, currentSite, currentRoute, committedRoute, environment }) =>
        restoreSiteVisibilityAfterSnapshotFailure(
          store,
          siteId,
          currentSite,
          currentRoute,
          committedRoute,
          environment
        ),
    },
    sites: { get: (siteId, environment) => store.getAdminSiteById(siteId, environment) },
    routes: { get: (siteId, environment) => store.getRouteBySiteId(siteId, environment) },
    versions: { get: (versionId, environment) => store.getSiteVersion(versionId, environment) },
    aclEntries: { list: (siteId) => store.listSiteAclEntries(siteId) },
    audits: { record: (event) => store.recordAuditEvent(event) },
  });
}

async function writeAdminExposureSnapshot(env, store, site, route, environment) {
  let writeResult;
  try {
    writeResult = await refreshCurrentRouteSnapshot(env, store, site, route, environment);
  } catch (error) {
    return { error };
  }
  if (writeResult) {
    const error = new Error('ROUTE_POLICY_REPAIR_REQUIRED');
    error.code = writeResult.error?.code || 'ROUTE_POLICY_REPAIR_REQUIRED';
    error.cause = writeResult;
    return { error };
  }

  return { committed: true };
}

function safeAdminExposureAuditWarningCode(error) {
  return error?.code === 'AUDIT_WRITE_FAILED' ? 'AUDIT_WRITE_FAILED' : 'UNKNOWN';
}

async function readAdminSitePublicExposureReason(env, store, config, site, exposure) {
  if (exposure !== 'public' || typeof store.getLatestAdminSitePublicExposureReason !== 'function') return null;
  try {
    const lockBefore = await readAdminSiteCommitLock(store, config, site);
    if (isActiveAdminSiteCommitLock(lockBefore, readNow(env))) return null;
    const reason = await store.getLatestAdminSitePublicExposureReason({
      environment: config.environment,
      siteId: site.id,
      currentExposure: exposure,
    });
    const lockAfter = await readAdminSiteCommitLock(store, config, site);
    if (isActiveAdminSiteCommitLock(lockAfter, readNow(env)) || adminSiteCommitLockChanged(lockBefore, lockAfter)) return null;
    return reason;
  } catch (error) {
    globalThis.console?.warn?.(
      'SITE_EXPOSURE_REASON_READ_UNCONFIRMED',
      JSON.stringify({
        environment: config.environment,
        siteId: site.id,
        errorCode: safeAdminExposureAuditWarningCode(error),
      })
    );
    return null;
  }
}

async function readAdminSiteCommitLock(store, config, site) {
  if (typeof store.getSiteCommitLock !== 'function') return null;
  return store.getSiteCommitLock(config.environment, site.id);
}

function isActiveAdminSiteCommitLock(lock, now) {
  return Date.parse(lock?.expiresAt || '') > Date.parse(now);
}

function adminSiteCommitLockChanged(before, after) {
  return (
    (before?.lockId || null) !== (after?.lockId || null) ||
    Number(before?.fencingToken || 0) !== Number(after?.fencingToken || 0) ||
    (before?.updatedAt || null) !== (after?.updatedAt || null)
  );
}

function adminExposureErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'SITE_POLICY_LOCKED' || code === 'SITE_POLICY_CONFLICT') {
    return jsonError(
      'SITE_POLICY_CONFLICT',
      'Site policy changed while exposure was being updated.',
      409,
      'Refresh the site and retry.'
    );
  }
  if (code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' || code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED') {
    return jsonError(code, error.message, 503, error.action);
  }
  if (code === 'SITE_EXPOSURE_AUDIT_FAILED') {
    return jsonError(
      code,
      'Site exposure is effective, but the final audit record could not be confirmed.',
      503,
      'Refresh the site status and retry the exposure operation to reconcile its audit trail.'
    );
  }
  if (code === 'ROUTE_POLICY_REPAIR_REQUIRED' || code === 'ROUTE_SNAPSHOT_WRITE_FAILED') {
    return jsonError(
      'ROUTE_POLICY_REPAIR_REQUIRED',
      'Route policy could not be confirmed effective.',
      503,
      'Repair the route snapshot before retrying.'
    );
  }
  return jsonError(
    'SITE_EXPOSURE_UPDATE_FAILED',
    'Site exposure could not be updated.',
    503,
    'Retry after checking the site policy state.'
  );
}

async function getAdminSite(config, store, siteId) {
  if (typeof store.getAdminSiteById === 'function') {
    const site = await store.getAdminSiteById(siteId, config.environment);
    if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
    return site;
  }
  const sites = await store.listAdminSites({ environment: config.environment });
  const site = sites.find((item) => item.id === siteId);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  return site;
}

async function updateAdminSiteSettings(request, env, config, store, session, site) {
  if (typeof store.transferSiteOwner !== 'function') {
    return jsonError('SITE_TRANSFER_UNSUPPORTED', 'Site transfer is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const target = await resolveAdminSiteOwnerTarget(store, config, body);
  if (target instanceof Response) return target;
  const currentVisibility = site.route?.visibility || site.defaultVisibility;
  if (target.ownerType === 'team' && currentVisibility === 'owner') return teamOwnerVisibilityUnsupported();

  let updated;
  try {
    const result = await createSiteOwnershipApplication({ store, env })({
      environment: config.environment,
      site,
      target: { ...target, ownerUserId: target.ownerUserId || session.userId },
      buildAuditEvent: (updatedAt) =>
        buildSiteOwnerTransferAuditEvent(
          env,
          config,
          { type: 'user', userId: session.userId },
          site,
          target,
          { source: 'console-admin', createdAt: updatedAt }
        ),
      compensateSnapshotFailure: true,
    });
    updated = result.site;
  } catch (error) {
    return siteTransferErrorResponse(error);
  }

  const refreshed = await getAdminSite(config, store, updated.id);
  if (refreshed instanceof Response) return refreshed;
  return jsonOk({ site: formatAdminSiteDetail(refreshed) });
}

async function resolveAdminSiteOwnerTarget(store, config, body) {
  const ownerType = body?.ownerType === 'team' || body?.ownerType === 'user' ? body.ownerType : '';
  if (!ownerType) {
    return jsonError('SITE_TRANSFER_INVALID', 'Site transfer target is invalid.', 400, 'Use ownerType user or team.');
  }

  if (ownerType === 'user') {
    const ownerId = normalizeRequiredString(body.ownerId || body.userId);
    if (!ownerId) return jsonError('SITE_TRANSFER_INVALID', 'Site transfer target is invalid.', 400, 'Choose a user.');
    const user = typeof store.getUser === 'function' ? await store.getUser(ownerId) : null;
    if (!user?.id || user.employeeStatus !== 'active') {
      return jsonError('SITE_TRANSFER_FORBIDDEN', 'Target user is not active.', 403, 'Choose an active user.');
    }
    return {
      ownerType: 'user',
      ownerId: user.id,
      ownerUserId: user.id,
    };
  }

  const teamId = normalizeRequiredString(body.teamId || body.ownerId);
  if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
  const team = typeof store.getTeam === 'function' ? await store.getTeam(teamId) : null;
  if (!team || team.environment !== config.environment || team.deletedAt || team.status !== 'active') {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  return {
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: team.createdByUserId || null,
  };
}

async function listAdminTeams(url, config, store) {
  const teamType = normalizeNullableString(url.searchParams.get('teamType'));
  const statusFilter = normalizeNullableString(url.searchParams.get('status'));
  const status = statusFilter === 'all' ? null : statusFilter || 'active';
  const teams = await store.listAdminTeams({
    environment: config.environment,
    teamType,
    status,
  });
  return jsonOk({ teams: teams.map(formatAdminTeam) });
}

async function getAdminTeam(config, store, teamId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;
  return jsonOk({ team: formatAdminTeam(team) });
}

async function getAdminTeamRecord(config, store, teamId) {
  const team = await store.getTeam(teamId);
  if (!team || team.environment !== config.environment || team.deletedAt) {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  return team;
}

async function updateAdminTeamMember(request, config, store, session, teamId, userId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const role = typeof body.role === 'string' ? body.role : '';
  if (!TEAM_ROLES.has(role)) {
    return jsonError('TEAM_ROLE_INVALID', 'Team role is invalid.', 400, 'Use viewer, publisher, or admin.');
  }

  const user = await store.getUser(userId);
  if (!user) return jsonError('USER_NOT_FOUND', 'User not found.', 404, 'Pick a user that has signed in to XD Cell.');

  const lastAdminError = await ensureCanChangeTeamAdminRole(store, team.id, userId, role);
  if (lastAdminError) return lastAdminError;

  const member = await store.addTeamMember({
    teamId: team.id,
    userId,
    role,
    membershipSource: 'manual',
    actorUserId: session.userId,
  });
  return jsonOk({ member: formatAdminTeamMember(member) });
}

async function removeAdminTeamMember(config, store, session, teamId, userId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;

  const lastAdminError = await ensureCanRemoveTeamMember(store, team.id, userId);
  if (lastAdminError) return lastAdminError;

  const member = await store.removeTeamMember({ teamId: team.id, userId, actorUserId: session.userId });
  if (!member) return jsonError('TEAM_MEMBER_NOT_FOUND', 'Team member not found.', 404, 'Check the user id.');
  return jsonOk({ member: formatAdminTeamMember(member) });
}

async function updateAdminTeamSettings(request, config, store, teamId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;
  if (team.teamType === 'department') {
    return jsonError(
      'DEPARTMENT_TEAM_SETTINGS_READONLY',
      'Department team settings are read-only.',
      403,
      'Use admin team merge tooling if the department path changed.'
    );
  }
  if (typeof store.updateTeamSettings !== 'function') {
    return jsonError('TEAM_SETTINGS_UNSUPPORTED', 'Team settings are unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const updated = await store.updateTeamSettings({
    teamId,
    name: body.name,
    description: body.description,
  });
  return jsonOk({ team: formatAdminTeam(updated) });
}

async function deleteAdminTeam(config, store, session, teamId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;
  if (team.teamType === 'department') {
    return jsonError(
      'DEPARTMENT_TEAM_DELETE_FORBIDDEN',
      'Department teams cannot be deleted from admin team settings.',
      403,
      'Use platform admin team merge tooling.'
    );
  }

  try {
    const deleted = await store.deleteCustomTeam({ teamId, actorUserId: session.userId });
    if (!deleted) return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
    return jsonOk({ team: formatAdminTeam(deleted) });
  } catch (error) {
    if (String(error?.message || error).includes('TEAM_HAS_BLOCKING_ASSETS')) {
      return jsonError(
        'TEAM_HAS_BLOCKING_ASSETS',
        'Team still owns sites or active access keys.',
        409,
        'Delete or transfer team sites and revoke team access keys first.'
      );
    }
    throw error;
  }
}

async function mergeDepartmentTeam(request, config, store, session, sourceTeamId) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const targetTeamId = normalizeRequiredString(body.targetTeamId);
  if (!targetTeamId) {
    return jsonError('TEAM_MERGE_TARGET_REQUIRED', 'Target team id is required.', 400, 'Choose a target department team.');
  }

  try {
    const merge = await store.mergeDepartmentTeams({
      sourceTeamId,
      targetTeamId,
      actorUserId: session.userId,
      reason: normalizeNullableString(body.reason),
      environment: config.environment,
    });
    return jsonOk({
      merge: {
        sourceTeam: formatAdminTeam(merge.sourceTeam),
        targetTeam: formatAdminTeam(merge.targetTeam),
        counts: merge.counts,
      },
    });
  } catch (error) {
    return adminMergeErrorResponse(error);
  }
}

async function listAuditEvents(config, store) {
  const events = await createAuditEventsQueryApplication(store).list({ environment: config.environment });
  return jsonOk({ events });
}

function createAuditEventsQueryApplication(store) {
  return createAuditEventsQuery({
    audits: { list: (query) => store.listAuditEvents(query) },
    metadata: { sanitize: sanitizeAuditMetadata },
  });
}

async function listPlatformAdmins(config, store) {
  const admins = await store.listPlatformAdmins({ environment: config.environment });
  return jsonOk({ admins: admins.map(formatPlatformAdmin) });
}

async function grantPlatformAdmin(request, config, store, session) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const userId = normalizeRequiredString(body.userId);
  if (!userId) return jsonError('PLATFORM_ADMIN_USER_REQUIRED', 'User id is required.', 400, 'Choose a user to grant.');

  const user = await store.getUser(userId);
  if (!user) return jsonError('ADMIN_USER_NOT_FOUND', 'User was not found.', 404, 'Choose an existing user.');

  const admin = await store.grantPlatformAdmin({
    environment: config.environment,
    userId,
    grantedByUserId: session.userId,
    grantReason: normalizeNullableString(body.reason),
  });
  return jsonOk({ admin: formatPlatformAdmin(admin) });
}

async function revokePlatformAdmin(request, config, store, session, userId) {
  let body = {};
  if (request.headers.get('Content-Type')) {
    try {
      body = await readJsonBody(request, { maxBytes: 16 * 1024 });
    } catch {
      return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
    }
  }

  const normalizedUserId = normalizeRequiredString(userId);
  if (!normalizedUserId)
    return jsonError('PLATFORM_ADMIN_USER_REQUIRED', 'User id is required.', 400, 'Choose a user to revoke.');

  let admin;
  try {
    admin = await store.revokePlatformAdmin({
      environment: config.environment,
      userId: normalizedUserId,
      revokedByUserId: session.userId,
      revokeReason: normalizeNullableString(body.reason),
    });
  } catch (error) {
    if (String(error?.message || error).includes('PLATFORM_ADMIN_LAST_ACTIVE')) {
      return jsonError(
        'PLATFORM_ADMIN_LAST_ACTIVE',
        'Platform must keep at least one active administrator.',
        409,
        'Grant another platform administrator before revoking this user.'
      );
    }
    throw error;
  }
  if (!admin) return jsonError('PLATFORM_ADMIN_NOT_FOUND', 'Platform admin was not found.', 404, 'Check the user id.');
  return jsonOk({ admin: formatPlatformAdmin(admin) });
}

function formatPlatformAdmin(admin) {
  return {
    environment: admin.environment,
    userId: admin.userId,
    grantedByUserId: admin.grantedByUserId,
    grantReason: admin.grantReason || null,
    revokedAt: admin.revokedAt || null,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
    ...(admin.revokedByUserId ? { revokedByUserId: admin.revokedByUserId } : {}),
    ...(admin.revokeReason ? { revokeReason: admin.revokeReason } : {}),
  };
}

function formatAdminDeployment(deployment) {
  const ownerState = deployment.ownerState === 'not_created' ? 'not_created' : 'persisted';
  const actor = deployment.actor || {};
  const formatted = {
    id: deployment.id,
    siteId: deployment.siteId,
    siteSlug: deployment.siteSlug || null,
    owner: {
      state: ownerState,
      type: ownerState === 'not_created' ? null : deployment.ownerType || 'user',
      id: ownerState === 'not_created' ? null : deployment.ownerId || deployment.ownerUserId || null,
      email: ownerState === 'not_created' ? null : deployment.ownerEmail || null,
      displayName: ownerState === 'not_created' ? null : deployment.ownerDisplayName || null,
      departmentPath: ownerState === 'not_created' ? null : deployment.ownerDepartmentPath || null,
      teamType: ownerState === 'not_created' ? null : deployment.ownerTeamType || null,
    },
    actor: {
      type: actor.type ?? deployment.actorType ?? null,
      id: actor.id ?? deployment.actorId ?? null,
      userId: actor.userId ?? deployment.actorUserId ?? null,
      email: actor.email ?? null,
      displayName: actor.displayName ?? null,
    },
    status: deployment.status,
    source: deployment.source || null,
    operation: deployment.operation || null,
    createdAt: deployment.createdAt,
  };
  if (deployment.traceId) formatted.traceId = deployment.traceId;
  if (deployment.errorCode) formatted.errorCode = deployment.errorCode;
  if (deployment.errorMessage) formatted.errorMessage = deployment.errorMessage;
  if (deployment.failureStage) formatted.failureStage = deployment.failureStage;
  if (deployment.failureDiagnostics) formatted.failureDiagnostics = deployment.failureDiagnostics;
  return formatted;
}

async function getAdminDeploymentTrace(config, store, deploymentId) {
  const result = await createDeploymentTraceQueryApplication(store).byDeployment({
    environment: config.environment,
    deploymentId,
  });
  if (!result.ok) {
    return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  }
  return jsonOk(result.value);
}

async function getAdminDeploymentTraceByTraceId(config, store, traceId) {
  const result = await createDeploymentTraceQueryApplication(store).byTraceId({
    environment: config.environment,
    traceId,
  });
  return result.ok ? jsonOk(result.value) : deploymentTraceNotFound();
}

function deploymentTraceNotFound() {
  return jsonError('DEPLOYMENT_TRACE_NOT_FOUND', 'Deployment trace not found.', 404, 'Check the deployment trace id.');
}

function createDeploymentTraceQueryApplication(store) {
  const listDeploymentEvents = (query, fallback) =>
    typeof store.listDeploymentEvents === 'function' ? store.listDeploymentEvents(query) : fallback;
  return createDeploymentTraceQuery({
    deployments: { get: (id, environment) => store.getDeployment(id, environment) },
    events: {
      listByDeployment: (query) => listDeploymentEvents(query, []),
      listByTrace: (query) => listDeploymentEvents(query, null),
    },
    diagnostics: { sanitize: sanitizeDeploymentTraceDiagnostics },
  });
}

function formatAdminUser(user) {
  return {
    id: user.id,
    email: user.email,
    realname: user.realname || null,
    employeeStatus: user.employeeStatus,
    departmentPath: user.departmentPath || null,
    isPlatformAdmin: Boolean(user.isPlatformAdmin),
    lastLoginAt: user.lastLoginAt || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function formatAdminSite(site) {
  return {
    id: site.id,
    slug: site.slug,
    hostname: site.route?.hostname || null,
    owner: {
      type: site.ownerType || 'user',
      id: site.ownerId || site.ownerUserId,
      email: site.ownerEmail || null,
      displayName: site.ownerDisplayName || null,
      departmentPath: site.ownerDepartmentPath || null,
      teamType: site.ownerTeamType || null,
    },
    deploymentShape: site.deploymentShape ?? null,
    exposure: site.route?.exposure || site.defaultExposure || 'internal',
    visibility: site.route?.visibility || site.defaultVisibility,
    status: site.route?.routeStatus || 'active',
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function formatAdminSiteDetail(site) {
  return {
    ...formatAdminSite(site),
    access: {
      exposure: site.route?.exposure || site.defaultExposure || 'internal',
      accessMode: site.route?.accessMode || accessModeFromVisibility(site.route?.visibility || site.defaultVisibility),
      visibility: site.route?.visibility || site.defaultVisibility,
    },
    permissions: {
      role: 'admin',
      canManage: true,
      canManageAccess: true,
    },
  };
}

function formatAdminTeam(team) {
  return {
    id: team.id,
    name: departmentTeamDisplayName(team),
    description: team.description || null,
    teamType: team.teamType,
    departmentPath: team.departmentPath || null,
    status: team.status,
    mergedIntoTeamId: team.mergedIntoTeamId || null,
    mergedAt: team.mergedAt || null,
    mergedByUserId: team.mergedByUserId || null,
    mergeReason: team.mergeReason || null,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function formatAdminTeamMember(member) {
  return {
    teamId: member.teamId,
    userId: member.userId,
    user: member.user ? formatConsoleUser(member.user) : null,
    role: member.role,
    membershipSource: member.membershipSource,
    departmentPath: member.departmentPath || null,
    removedAt: member.removedAt || null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

function adminMergeErrorResponse(error) {
  const code = String(error?.message || '').split(':', 1)[0];
  if (code === 'TEAM_NOT_FOUND') return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check team ids.');
  if (code === 'TEAM_MERGE_TARGET_INVALID') {
    return jsonError(
      'TEAM_MERGE_TARGET_INVALID',
      'Source and target team must be different.',
      400,
      'Choose another target team.'
    );
  }
  if (code === 'TEAM_MERGE_ENVIRONMENT_MISMATCH') {
    return jsonError(
      'TEAM_MERGE_ENVIRONMENT_MISMATCH',
      'Teams are not in the same environment.',
      400,
      'Choose a team in the same environment.'
    );
  }
  if (code === 'TEAM_MERGE_DEPARTMENT_REQUIRED') {
    return jsonError('TEAM_MERGE_DEPARTMENT_REQUIRED', 'Only department teams can be merged.', 400, 'Choose department teams.');
  }
  if (code === 'TEAM_MERGE_SOURCE_INACTIVE' || code === 'TEAM_MERGE_TARGET_INACTIVE') {
    return jsonError(code, 'Team cannot be merged in its current state.', 409, 'Refresh teams and retry.');
  }
  throw error;
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}

function teamOwnerVisibilityUnsupported() {
  return jsonError(
    'SITE_VISIBILITY_INVALID',
    'Team-owned sites cannot use owner visibility.',
    400,
    'Use internal, org, acl, or disabled for team-owned sites.'
  );
}

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function normalizeNullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}
