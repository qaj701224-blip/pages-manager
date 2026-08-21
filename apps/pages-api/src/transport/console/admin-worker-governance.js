import { createWfpClient, readWfpConfig } from '@xd/wfp-client';

import { createWorkerOrphanBackfill } from '../../application/governance/backfill-worker-orphans.js';
import { createAdminDashboardQuery } from '../../application/governance/get-admin-dashboard.js';
import { createNormalWorkersQuery } from '../../application/governance/list-normal-workers.js';
import { createNormalWorkerRetirement } from '../../application/governance/retire-normal-workers.js';
import { createWorkerOrphanScan } from '../../application/governance/scan-worker-orphans.js';
import {
  buildWorkerOrphanScan,
  isManagedWfpWorkerName,
  isWfpWorkerResource,
} from '../../admin-resource-governance.js';
import { jsonError, jsonOk, readJsonBody } from '../../http.js';
import { newId, nextId } from '../../id.js';
import {
  createDeploymentCleanupRunnerApplication,
  formatDeploymentCleanupTask,
  runDueDeploymentCleanups,
  unexpectedCleanupTaskError,
} from '../../infrastructure/cleanup/deployment-cleanup-runtime.js';
import { createNormalWorkerAdminClient } from '../../infrastructure/providers/normal-worker-admin-client.js';
import {
  cloudflareFailureCause,
  normalizeNullableString,
  normalizeRequiredString,
  readNow,
} from './admin-support.js';

const NORMAL_WORKER_BULK_DELETE_LIMIT = 100;
const WFP_ORPHAN_BACKFILL_LIMIT = 100;
const DEFAULT_WFP_ORPHAN_SCAN_MAX_WORKERS = 10_000;
const CLEANUP_TASK_FAILED_CODE = 'CLEANUP_TASK_FAILED';
const CLEANUP_TASK_FAILED_MESSAGE = 'Cleanup task failed unexpectedly.';

export async function getAdminDashboard(env, config, store) {
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

export async function scanAdminWorkerOrphans(env, config, store) {
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

function readWorkerOrphanScanLimit(env) {
  const configured = Number(env?.PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS);
  if (!Number.isInteger(configured) || configured < 1) return DEFAULT_WFP_ORPHAN_SCAN_MAX_WORKERS;
  return configured;
}


export function getAdminOps(config) {
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

export async function listAdminNormalWorkers(config, store) {
  if (typeof store.listAdminNormalWorkers !== 'function') {
    return jsonError('NORMAL_WORKERS_UNSUPPORTED', 'Normal Worker management is unavailable.', 503, 'Retry later.');
  }
  const workers = await createNormalWorkersQuery({
    workers: { list: (query) => store.listAdminNormalWorkers(query) },
  }).list({ environment: config.environment });
  return jsonOk({ workers });
}

export async function listDeploymentCleanups(url, env, config, store) {
  if (typeof store.listDeploymentResourceCleanupTasks !== 'function') {
    return jsonError('CLEANUP_TASKS_UNSUPPORTED', 'Deployment cleanup tasks are unavailable.', 503, 'Retry later.');
  }
  const status = normalizeNullableString(url.searchParams.get('status'));
  const tasks = await store.listDeploymentResourceCleanupTasks({ environment: config.environment, status });
  return jsonOk({ tasks: tasks.map((task) => formatDeploymentCleanupTask(task, env)) });
}

export async function runDueDeploymentCleanupsAdmin(request, env, config, store, session) {
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

export async function backfillAdminWorkerOrphans(request, env, config, store, session) {
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

export async function runDeploymentCleanupTask(env, config, store, session, taskId) {
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

  const run = await createDeploymentCleanupRunnerApplication({ env, config, store }).runOne({
    id: taskId,
    environment: config.environment,
  });
  if (!run.ok && run.reason === 'task_read_failed') {
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
  if (!run.ok && run.reason === 'task_not_found') {
    await recordResourceGovernanceAuditSafe(store, env, config, session, {
      eventType: 'admin.cleanup_run',
      stage: 'run',
      decision: 'deny',
      statusCode: 404,
      metadata: { taskId, resourceRef: null, outcome: 'failed', result: 'CLEANUP_TASK_NOT_FOUND' },
    });
    return jsonError('CLEANUP_TASK_NOT_FOUND', 'Cleanup task not found.', 404, 'Check the cleanup task id.');
  }
  if (!run.ok) throw new Error('CLEANUP_RUN_RESULT_INVALID');
  const task = run.task;
  const result = run.execution.unexpected ? unexpectedCleanupTaskError() : run.execution.value;
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

export async function deleteAdminNormalWorker(request, env, config, store, session, slotId) {
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
  const result = await createNormalWorkerRetirementApplication(env, store).retire({
    id: slotId,
    environment: config.environment,
    actorUserId: session.user.userId,
    reason,
  });
  return normalWorkerDeleteResultResponse(result);
}

export async function bulkDeleteAdminNormalWorkers(request, env, config, store, session) {
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
  const result = await createNormalWorkerRetirementApplication(env, store).retireBatch({
    ids,
    environment: config.environment,
    actorUserId: session.user.userId,
    reason,
  });

  return jsonOk({
    summary: result.summary,
    results: result.results.map(formatNormalWorkerBatchResult),
  });
}

function createNormalWorkerRetirementApplication(env, store) {
  return createNormalWorkerRetirement({
    workers: {
      list: (query) => store.listAdminNormalWorkers(query),
      retire: (command) => store.retireIdleNormalWorker(command),
      ...(typeof store.markNormalWorkerDeletePending === 'function'
        ? { markDeletePending: (command) => store.markNormalWorkerDeletePending(command) }
        : {}),
    },
    provider: {
      deleteWorker: (command) =>
        createNormalWorkerAdminClient({
          client: env.NORMAL_WORKER_ADMIN_CLIENT,
          accountId: env.CF_ACCOUNT_ID,
          apiToken: env.CF_API_TOKEN,
          fetch: env.fetch || globalThis.fetch,
        }).deleteWorker(command),
    },
    clock: { now: () => readNow(env) },
  });
}


function normalWorkerDeleteResultResponse(result) {
  if (result.status === 'failed') {
    const failure = normalWorkerDeleteFailure(result.errorCode);
    return jsonError(failure.error.code, failure.error.message, failure.httpStatus, failure.error.action);
  }
  return jsonOk(
    {
      worker: result.worker,
      ...(result.status === 'delete_pending' ? { warning: normalWorkerDeletePendingWarning() } : {}),
    },
    result.status === 'delete_pending' ? 202 : 200
  );
}

function formatNormalWorkerBatchResult(result) {
  const failure = result.status === 'failed' ? normalWorkerDeleteFailure(result.errorCode) : null;
  return {
    id: result.id,
    status: result.status,
    ...(result.worker ? { worker: result.worker } : {}),
    ...(result.status === 'delete_pending' ? { warning: normalWorkerDeletePendingWarning() } : {}),
    ...(failure ? { error: failure.error } : {}),
  };
}

function normalWorkerDeleteFailure(code) {
  if (code === 'NORMAL_WORKER_NOT_FOUND') return { httpStatus: 404, error: normalWorkerNotFoundError() };
  if (code === 'NORMAL_WORKER_ACTIVE') return { httpStatus: 409, error: normalWorkerActiveError() };
  if (code === 'NORMAL_WORKER_STATE_INCONSISTENT') {
    return { httpStatus: 409, error: normalWorkerStateInconsistentError() };
  }
  return { httpStatus: 502, error: normalWorkerDeleteFailedError() };
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


