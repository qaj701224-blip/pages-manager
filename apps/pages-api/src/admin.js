import { isConsoleBffRequest, requireConsoleUserSession } from './console-auth.js';
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
import { handleConsoleAdminWebhooksApi } from './webhooks.js';
import { buildSiteOwnerTransferAuditEvent, refreshActiveRouteSnapshot } from './sites.js';
import { ensureCanChangeTeamAdminRole, ensureCanRemoveTeamMember } from './teams.js';
import { createWfpClient, readWfpConfig } from '../../../packages/wfp-client/src/index.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';
const TEAM_ROLES = new Set(['viewer', 'publisher', 'admin']);
const NORMAL_WORKER_BULK_DELETE_LIMIT = 100;
const NORMAL_WORKER_BULK_DELETE_CONCURRENCY = 5;
const CLEANUP_TASK_LOCK_SECONDS = 5 * 60;
const CLEANUP_TASK_FAILED_CODE = 'CLEANUP_TASK_FAILED';
const CLEANUP_TASK_FAILED_MESSAGE = 'Cleanup task failed unexpectedly.';

export async function handleConsoleAdminApi(request, env, config, store) {
  if (!isConsoleBffRequest(request)) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${CONSOLE_PREFIX}/admin`)) return null;

  const session = await requireConsoleUserSession(request, env, config, store, { requirePlatformAdmin: true });
  if (session instanceof Response) return session;

  const webhooksResponse = await handleConsoleAdminWebhooksApi(request, env, config, store, session);
  if (webhooksResponse) return webhooksResponse;

  if (url.pathname === `${CONSOLE_PREFIX}/admin/dashboard`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminDashboard(config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/ops`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminOps(config);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/deployment-cleanups`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listDeploymentCleanups(url, env, config, store);
  }

  const cleanupRunMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/deployment-cleanups\/([^/]+)\/run$/);
  if (cleanupRunMatch) {
    if (request.method !== 'POST') return methodNotAllowed();
    return runDeploymentCleanupTask(env, config, store, decodeURIComponent(cleanupRunMatch[1]));
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
    return listAdminSites(config, store);
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
    if (request.method === 'PATCH') return updateSiteAccess(request, env, config, store, session, site.id, { site });
    if (request.method !== 'GET') return methodNotAllowed();
    const aclEntries = typeof store.listSiteAclEntries === 'function' ? await store.listSiteAclEntries(site.id) : [];
    return jsonOk({
      access: {
        visibility: site.route?.visibility || site.defaultVisibility,
        aclEntries: aclEntries.map(formatAclEntry),
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
    if (request.method === 'DELETE') return deleteConsoleSite(env, config, store, site, { force: true });
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

async function getAdminDashboard(config, store) {
  const dashboard = await store.getAdminDashboard({ environment: config.environment });
  return jsonOk({
    dashboard: {
      environment: dashboard.environment,
      counts: dashboard.counts,
      failedDeployments: dashboard.failedDeployments.map(formatAdminDeployment),
    },
  });
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

async function runDeploymentCleanupTask(env, config, store, taskId) {
  if (
    typeof store.getDeploymentResourceCleanupTask !== 'function' ||
    typeof store.markDeploymentResourceCleanupRunning !== 'function' ||
    typeof store.finishDeploymentResourceCleanupTask !== 'function'
  ) {
    return jsonError('CLEANUP_TASKS_UNSUPPORTED', 'Deployment cleanup tasks are unavailable.', 503, 'Retry later.');
  }

  const task = await store.getDeploymentResourceCleanupTask(taskId, config.environment);
  if (!task) return jsonError('CLEANUP_TASK_NOT_FOUND', 'Cleanup task not found.', 404, 'Check the cleanup task id.');
  const result = await executeDeploymentCleanupTask(env, config, store, task);
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
  if (task.resourceType !== 'wfp_user_worker' || !isManagedWfpCleanupResource(task.resourceRef, config.environment)) {
    return cleanupTaskError(
      'CLEANUP_RESOURCE_UNSUPPORTED',
      'Cleanup resource is unsupported.',
      409,
      'Review the cleanup task resource.'
    );
  }

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

function isManagedWfpCleanupResource(workerName, environment) {
  if (typeof workerName !== 'string') return false;
  if (environment === 'staging') return workerName.startsWith('pages-v2-staging-');
  return workerName.startsWith('pages-v2-') && !workerName.startsWith('pages-v2-staging-');
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
  const query = normalizeNullableString(url.searchParams.get('query'));
  const users = await store.listAdminUsers({ environment: config.environment, query });
  return jsonOk({ users: users.map(formatAdminUser) });
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

async function listAdminSites(config, store) {
  const sites = await store.listAdminSites({ environment: config.environment });
  return jsonOk({ sites: sites.map(formatAdminSite) });
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

  const updatedAt = readNow(env);
  const updated = await store.transferSiteOwner(
    site.id,
    {
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      ownerUserId: target.ownerUserId || session.userId,
      updatedAt,
      auditEvent: buildSiteOwnerTransferAuditEvent(env, config, { type: 'user', userId: session.userId }, site, target, {
        source: 'console-admin',
        createdAt: updatedAt,
      }),
    },
    config.environment
  );
  if (!updated) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

  const route = await store.getRouteBySiteId(updated.id, config.environment);
  const snapshotError = await refreshActiveRouteSnapshot(env, store, updated, route, config.environment);
  if (snapshotError) {
    await rollbackAdminSiteOwnerTransfer(store, site, updatedAt, config.environment);
    return snapshotError;
  }

  const refreshed = await getAdminSite(config, store, updated.id);
  if (refreshed instanceof Response) return refreshed;
  return jsonOk({ site: formatAdminSiteDetail(refreshed) });
}

async function rollbackAdminSiteOwnerTransfer(store, previousSite, updatedAt, environment) {
  const previousOwnerType = previousSite.ownerType || 'user';
  const previousOwnerId = previousSite.ownerId || previousSite.ownerUserId;
  const previousOwnerUserId = previousSite.ownerUserId || (previousOwnerType === 'user' ? previousOwnerId : null);
  if (!previousOwnerId) return null;
  return store.transferSiteOwner(
    previousSite.id,
    {
      ownerType: previousOwnerType,
      ownerId: previousOwnerId,
      ownerUserId: previousOwnerUserId,
      defaultVisibility: previousSite.defaultVisibility,
      updatedAt,
    },
    environment
  );
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
  const events = await store.listAuditEvents({ environment: config.environment });
  return jsonOk({ events: events.map(formatAuditEvent) });
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
  const formatted = {
    id: deployment.id,
    siteId: deployment.siteId,
    siteSlug: deployment.siteSlug || null,
    owner: {
      type: deployment.ownerType || 'user',
      id: deployment.ownerId || deployment.ownerUserId || null,
      email: deployment.ownerEmail || null,
      displayName: deployment.ownerDisplayName || null,
      departmentPath: deployment.ownerDepartmentPath || null,
      teamType: deployment.ownerTeamType || null,
    },
    status: deployment.status,
    source: deployment.source || null,
    operation: deployment.operation || null,
    createdAt: deployment.createdAt,
  };
  if (deployment.errorCode) formatted.errorCode = deployment.errorCode;
  if (deployment.errorMessage) formatted.errorMessage = deployment.errorMessage;
  if (deployment.failureStage) formatted.failureStage = deployment.failureStage;
  if (deployment.failureDiagnostics) formatted.failureDiagnostics = deployment.failureDiagnostics;
  return formatted;
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

function formatAuditEvent(event) {
  return {
    id: event.id,
    eventType: event.eventType,
    actorUserId: event.actorUserId || null,
    actorType: event.actorType,
    actor: {
      type: event.actor?.type || event.actorType || null,
      userId: event.actor?.userId || event.actorUserId || null,
      displayName: event.actor?.displayName || null,
      email: event.actor?.email || null,
    },
    decision: event.decision,
    statusCode: event.statusCode ?? null,
    metadata: event.metadata || null,
    createdAt: event.createdAt,
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
