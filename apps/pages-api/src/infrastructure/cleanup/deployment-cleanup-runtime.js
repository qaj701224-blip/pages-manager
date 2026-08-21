import { createWfpClient, readWfpConfig } from '@xd/wfp-client';

import {
  canRunDeploymentCleanupTask,
  createDeploymentCleanupRunner,
} from '../../application/governance/run-deployment-cleanups.js';
import { isManagedWfpWorkerName, isWfpWorkerResource } from '../../admin-resource-governance.js';
import {
  cleanupDeferredLegacyV1WorkerScript,
  resolveDeferredLegacyV1WorkerTarget,
} from '../../legacy-v1/deferred-worker-cleanup.js';

const CLEANUP_TASK_LOCK_SECONDS = 5 * 60;
const CLEANUP_TASK_FAILED_CODE = 'CLEANUP_TASK_FAILED';
const CLEANUP_TASK_FAILED_MESSAGE = 'Cleanup task failed unexpectedly.';

export async function runDueDeploymentCleanups(env, config, store, { limit = 10 } = {}) {
  if (
    typeof store.listDeploymentResourceCleanupTasks !== 'function' ||
    typeof store.getDeploymentResourceCleanupTask !== 'function' ||
    typeof store.markDeploymentResourceCleanupRunning !== 'function' ||
    typeof store.finishDeploymentResourceCleanupTask !== 'function'
  ) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  return createDeploymentCleanupRunnerApplication({ env, config, store }).runDue({
    environment: config.environment,
    limit,
  });
}

export function createDeploymentCleanupRunnerApplication({ env, config, store }) {
  return createDeploymentCleanupRunner({
    tasks: {
      list: (query) => store.listDeploymentResourceCleanupTasks(query),
      get: (id, environment) => store.getDeploymentResourceCleanupTask(id, environment),
    },
    executor: {
      execute: async (task) => {
        const result = await executeDeploymentCleanupTask(env, config, store, task);
        return {
          ok: result.ok,
          outcome: result.ok ? 'succeeded' : result.httpStatus >= 500 ? 'failed' : 'skipped',
          value: result,
        };
      },
    },
    clock: { now: () => readNow(env) },
  });
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

export function unexpectedCleanupTaskError() {
  return cleanupTaskError(
    CLEANUP_TASK_FAILED_CODE,
    CLEANUP_TASK_FAILED_MESSAGE,
    500,
    'Review the cleanup task diagnostics and retry.'
  );
}

function cleanupTaskCanRun(task, env) {
  return canRunDeploymentCleanupTask(task, readNow(env));
}

export function formatDeploymentCleanupTask(task, env) {
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


function isValidV1SitesKvResourceRef(value) {
  return typeof value === 'string' && value === value.toLowerCase() && /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(value);
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
