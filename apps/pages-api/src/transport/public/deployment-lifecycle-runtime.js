import { isManagedWfpWorkerName } from '../../admin-resource-governance.js';
import { createDeploymentPreviousResourceCleanup } from '../../application/deployments/cleanup-previous-resources.js';
import { createUploadedWorkerCompensation } from '../../application/deployments/cleanup-uploaded-worker.js';
import { createDeploymentCompletion } from '../../application/deployments/complete-deployment.js';
import { createDeploymentFailureCompletion } from '../../application/deployments/complete-failed-deployment.js';
import { createDeploymentSucceededWebhook } from '../../application/deployments/deliver-succeeded-webhook.js';
import { createDeploymentFailedWebhook } from '../../application/deployments/deliver-failed-webhook.js';
import { createDeploymentRecord } from '../../application/deployments/deployment-record.js';
import { createRollbackRouteFinalization } from '../../application/deployments/finalize-rollback-route.js';
import { createSuccessfulDeploymentFinalization } from '../../application/deployments/finalize-successful-deployment.js';
import { createSuccessfulRollbackFinalization } from '../../application/deployments/finalize-successful-rollback.js';
import { createCommittedDeploymentReconciliation } from '../../application/deployments/reconcile-committed-deployment.js';
import { createDeploymentActivationFailureRecovery } from '../../application/deployments/recover-activation-failure.js';
import { createFailedDeploymentsRecovery } from '../../application/deployments/recover-failed-deployments.js';
import { createRollbackRouteSnapshotRecovery } from '../../application/deployments/recover-rollback-route-snapshot.js';
import { createDeploymentRouteSnapshotRecovery } from '../../application/deployments/recover-route-snapshot.js';
import { createUnexpectedRequestFailureRecovery } from '../../application/deployments/recover-unexpected-request-failure.js';
import { createDeploymentOwnerTransferRestoration } from '../../application/deployments/restore-owner-transfer.js';
import { createRollbackSite } from '../../application/deployments/rollback-site.js';
import { createDeploymentCleanupTasksPort } from '../../application/ports/deployment-cleanup.js';
import { createDeploymentCommitReconciliationPort } from '../../application/ports/deployment-commit-reconciliation.js';
import { createDeploymentCompletionPort } from '../../application/ports/deployment-completion.js';
import { createDeploymentFailurePort } from '../../application/ports/deployment-failure.js';
import { createDeploymentFailureRecoveryPort } from '../../application/ports/deployment-failure-recovery.js';
import {
  createDeploymentRecoveryPort,
  createRollbackRecoveryPort,
} from '../../application/ports/deployment-recovery.js';
import { createDeploymentRecordsPort } from '../../application/ports/deployment-records.js';
import { createDeploymentWebhookTeamsPort } from '../../application/ports/deployment-webhooks.js';
import { createUnexpectedDeploymentRecoveryPort } from '../../application/ports/unexpected-deployment-recovery.js';
import {
  bindDeploymentTrace,
  createDeploymentTraceContext,
  finishDeploymentStage,
  providerDiagnosticsFromError,
  recordDeploymentStage,
  startDeploymentStage,
} from '../../deployment-trace.js';
import { createDeploymentProvider } from '../../execution-provider.js';
import { nextId } from '../../id.js';
import { createDeploymentWebhookDispatcher } from '../../infrastructure/integrations/webhooks/deployment-webhook-dispatcher.js';
import { createDeploymentFailureRecoveryMarkers } from '../../infrastructure/route-snapshots/deployment-failure-recovery.js';
import { createDeploymentRouteSnapshotRecoveryAdapter } from '../../infrastructure/route-snapshots/deployment-recovery.js';
import { emitSiteDisabledWebhook } from '../../lifecycle-webhooks.js';
import {
  clearRoutePointerIfCurrent,
  deleteDeploymentFailureRecoveryRecord,
  listDeploymentFailureRecoveryRecords,
  writeDeploymentFailureRecoveryRecord,
} from '../../route-snapshot.js';
import {
  logDeploymentRepairRequired,
  logDeploymentStateWriteFailed,
  recordCleanupOutcome,
} from './deployment-diagnostics.js';
import { deploymentOperationFailurePatch } from './deployment-errors.js';
import { traceUnexpectedRequestFailure } from './deployment-request-trace.js';
import {
  createDeploymentRouteSnapshotCommitApplication,
  createDeploymentRouteSnapshotInfrastructure,
  createRollbackActivationPreparationApplication,
  createRollbackRouteCutoverApplication,
  releaseSiteCommitLeaseBestEffort,
} from './deployment-route-runtime.js';
import { createDeploymentRuntimeConfigRestorationApplication } from './deployment-runtime-config.js';
import { ensurePublicWorkerOfficeNetAbsent } from '../shared/public-office-net-application.js';

async function emitDeploymentFailedWebhook({ application, actor, site, deployment, environment, ctx }) {
  const delivery = Promise.resolve(application.deliver({ actor, site, deployment, environment })).catch(
    () => undefined
  );
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(delivery);
    } catch {
      // Best-effort delivery must not alter the deployment response.
    }
    return;
  }
  await delivery;
}

export async function reconcileCommittedDeployment(store, deployment, environment, env, trace = null) {
  return createCommittedDeploymentReconciliationApplication({ store, env }).reconcile({
    deployment,
    environment,
    trace,
  });
}

async function traceForStoredDeployment(store, deployment, environment, env) {
  if (!deployment?.traceId) return null;
  const trace = createDeploymentTraceContext(null, env, {
    environment,
    operation: deployment.operation,
    store,
    now: env?.now,
  });
  bindDeploymentTrace(trace, {
    traceId: deployment.traceId,
    deploymentId: deployment.id,
    siteId: deployment.siteId,
    attempt: await nextDeploymentTraceAttempt(store, environment, deployment.id),
  });
  return trace;
}

export async function persistIntermediateDeploymentState(store, deploymentId, patch, operation) {
  try {
    return await store.updateDeployment(deploymentId, patch);
  } catch (cause) {
    const error = new Error('Deployment state could not be persisted.', { cause });
    error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
    error.deploymentStateOperation = operation;
    throw error;
  }
}

export async function recordDeploymentStatePersistFailure({ trace, env, deploymentId, operation, stageHandle }) {
  const failure = {
    status: 'failed',
    errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
    errorMessage: 'Deployment state could not be persisted.',
    diagnostics: { causeClass: 'deployment_store_error' },
  };
  if (stageHandle) {
    await finishDeploymentStage(stageHandle, failure);
  } else if (trace) {
    await recordDeploymentStage(trace, {
      stage: 'deployment_state_persist',
      operation,
      ...failure,
    });
  }
  logDeploymentStateWriteFailed(env, {
    traceId: trace?.traceId || null,
    deploymentId,
    operation,
  });
}

export async function updateDeploymentToFailedAndNotify({
  store,
  env,
  config,
  ctx,
  deploymentId,
  patch,
  actor,
  site,
  trace,
}) {
  return createDeploymentFailureCompletionApplication({ store, env, config, ctx, trace }).complete({
    deploymentId,
    environment: config.environment,
    operation: trace?.operation || null,
    siteId: trace?.siteId || null,
    patch,
    actor,
    site,
  });
}

export function normalizeExposureForDeployment(value) {
  return value === 'public' ? 'public' : 'internal';
}

export function createDeploymentRecordApplication(store, env) {
  return createDeploymentRecord({
    deploymentRecords: createDeploymentRecordsPort(store),
    ids: { next: (prefix) => nextId(env, prefix) },
  });
}

function createCommittedDeploymentReconciliationApplication({ store, env }) {
  return createCommittedDeploymentReconciliation({
    state: createDeploymentCommitReconciliationPort(store),
    traces: {
      forDeployment: (deployment, environment) => traceForStoredDeployment(store, deployment, environment, env),
    },
    telemetry: {
      reconciled: (trace) =>
        recordDeploymentStage(trace, {
          stage: 'deployment_state_persist',
          operation: 'reconcile_committed_deployment',
          status: 'compensated',
          diagnostics: {
            causeClass: 'deployment_state_reconciled',
            trafficImpact: 'new_version_active',
          },
        }),
      persistFailed: (input) => recordDeploymentStatePersistFailure({ ...input, env }),
    },
    clock: { now: () => readNow(env) },
  });
}

function createDeploymentCompletionApplication({ store, env, trace }) {
  return createDeploymentCompletion({
    deployments: createDeploymentCompletionPort(store),
    telemetry: {
      startPersist(operation) {
        return trace
          ? startDeploymentStage(trace, {
              stage: 'deployment_state_persist',
              operation,
            })
          : null;
      },
      persistSucceeded: (stage) => (stage ? finishDeploymentStage(stage, { status: 'succeeded' }) : undefined),
      persistFailed: ({ stage, ...input }) =>
        recordDeploymentStatePersistFailure({ ...input, trace, env, stageHandle: stage }),
    },
  });
}

function createDeploymentFailureCompletionApplication({ store, env, config, ctx, trace }) {
  const failedWebhook = createDeploymentFailedWebhookApplication({ store, env, config, trace });
  const recoveryMarkers = createDeploymentFailureRecoveryMarkersInfrastructure(env, config);
  return createDeploymentFailureCompletion({
    deployments: createDeploymentFailurePort(store),
    telemetry: {
      startPersist(operation) {
        return trace
          ? startDeploymentStage(trace, {
              stage: 'deployment_state_persist',
              operation,
            })
          : null;
      },
      persistFailed({ deploymentId, stage, operation, cause }) {
        return recordDeploymentStatePersistFailure({
          trace,
          env,
          deploymentId,
          operation,
          stageHandle: stage,
          cause,
        });
      },
      persistSucceeded(stage) {
        return stage ? finishDeploymentStage(stage, { status: 'succeeded' }) : undefined;
      },
      webhookSkipped() {
        return trace
          ? recordDeploymentStage(trace, {
              stage: 'webhook_delivery',
              operation: 'site_failed',
              status: 'skipped',
            })
          : undefined;
      },
    },
    recoveryMarkers,
    repairs: {
      report: (input) => logDeploymentRepairRequired(env, input),
    },
    webhooks: {
      emitFailed: ({ actor, site, deployment }) =>
        emitDeploymentFailedWebhook({
          application: failedWebhook,
          actor,
          site,
          deployment,
          environment: config.environment,
          ctx,
        }),
    },
    clock: { now: () => readNow(env) },
  });
}

function createFailedDeploymentsRecoveryApplication({ store, env, config, ctx }) {
  return createFailedDeploymentsRecovery({
    markers: createDeploymentFailureRecoveryMarkersInfrastructure(env, config),
    deployments: createDeploymentFailureRecoveryPort(store),
    commits: {
      reconcile: (deployment, environment) =>
        reconcileCommittedDeployment(store, deployment, environment, env),
    },
    traces: {
      forDeployment: (deployment, environment) => traceForStoredDeployment(store, deployment, environment, env),
    },
    failures: {
      complete: ({ deploymentId, patch, actor, site, trace }) =>
        updateDeploymentToFailedAndNotify({
          store,
          env,
          config,
          ctx,
          deploymentId,
          patch,
          actor,
          site,
          trace,
        }),
    },
    telemetry: {
      recovered: (trace, { operatorAction }) =>
        recordDeploymentStage(trace, {
          stage: 'deployment_state_persist',
          operation: 'recover_failed_deployment_marker',
          status: 'compensated',
          diagnostics: {
            causeClass: 'deployment_store_recovery',
            operatorAction,
          },
        }),
    },
    repairs: {
      report: (input) => logDeploymentRepairRequired(env, input),
    },
  });
}

function createUnexpectedRequestFailureRecoveryApplication({ store, env, config, ctx }) {
  const recoveryState = createUnexpectedDeploymentRecoveryPort(store);
  return createUnexpectedRequestFailureRecovery({
    requestTrace: {
      failUnexpected: (trace, input) => traceUnexpectedRequestFailure(trace, input),
    },
    deployments: { get: recoveryState.getDeployment },
    commits: {
      reconcile: (deployment, environment, trace) =>
        reconcileCommittedDeployment(store, deployment, environment, env, trace),
    },
    sites: { load: recoveryState.loadSite },
    failures: {
      patch: (operation) =>
        deploymentOperationFailurePatch({
          errorCode: 'DEPLOYMENT_REQUEST_FAILED',
          errorMessage: 'Deployment request could not be processed.',
          operatorAction: operation === 'rollback' ? 'retry_rollback' : 'retry_deploy',
        }),
      complete: ({ deploymentId, patch, actor, site, trace }) =>
        updateDeploymentToFailedAndNotify({
          store,
          env,
          config,
          ctx,
          deploymentId,
          patch,
          actor,
          site,
          trace,
        }),
    },
    logs: {
      stateWriteFailed: (input) => logDeploymentStateWriteFailed(env, input),
    },
    repairs: {
      report: (input) => logDeploymentRepairRequired(env, input),
    },
  });
}

function createDeploymentPreviousResourceCleanupApplication({ store, env, provider, trace }) {
  return createDeploymentPreviousResourceCleanup({
    provider,
    cleanupTasks: createDeploymentCleanupTasksPort(store),
    clock: { now: () => readNow(env) },
    ids: { next: (prefix) => nextId(env, prefix) },
    managedWorkers: { isManaged: isManagedWfpWorkerName },
    telemetry: {
      record: (outcome, context) => recordCleanupOutcome(trace, outcome, context),
    },
    config: {
      cleanupDrainSeconds: env?.WFP_WORKER_CLEANUP_DRAIN_SECONDS || env?.WFP_CLEANUP_DRAIN_SECONDS || 300,
    },
  });
}

export function createUploadedWorkerCompensationApplication({ store, provider, trace }) {
  return createUploadedWorkerCompensation({
    routes: {
      get: (siteId, environment) => store.getRouteBySiteId(siteId, environment),
    },
    workers: {
      delete: typeof provider?.delete === 'function' ? provider.delete.bind(provider) : null,
    },
    diagnostics: { fromError: providerDiagnosticsFromError },
    telemetry: {
      record: (outcome, context) => recordCleanupOutcome(trace, outcome, context),
    },
  });
}

export function createDeploymentActivationFailureRecoveryApplication({ store, env, provider, trace }) {
  return createDeploymentActivationFailureRecovery({
    workers: createUploadedWorkerCompensationApplication({ store, provider, trace }),
    runtimeConfig: createDeploymentRuntimeConfigRestorationApplication(store, env),
    ownerTransfers: createDeploymentOwnerTransferRestorationApplication(store),
  });
}

export function createSuccessfulDeploymentFinalizationApplication({ store, env, config, ctx, provider, trace }) {
  return createSuccessfulDeploymentFinalization({
    completion: createDeploymentCompletionApplication({ store, env, trace }),
    cleanup: createDeploymentPreviousResourceCleanupApplication({ store, env, provider, trace }),
    webhooks: createDeploymentSucceededWebhookApplication({ store, env, config, trace }),
    lifecycle: {
      emitDisabled: (command) => emitSiteDisabledWebhook({ store, env, config, ctx, ...command }),
    },
    taskScheduler: {
      schedule: (task) => {
        if (ctx && typeof ctx.waitUntil === 'function') return ctx.waitUntil(task);
        return task;
      },
    },
    clock: { now: () => readNow(env) },
  });
}

function createSuccessfulRollbackFinalizationApplication({ store, env, trace }) {
  return createSuccessfulRollbackFinalization({
    completion: createDeploymentCompletionApplication({ store, env, trace }),
    telemetry: {
      webhookSkipped: () =>
        recordDeploymentStage(trace, {
          stage: 'webhook_delivery',
          operation: 'rollback_no_webhook',
          status: 'skipped',
        }),
    },
    clock: { now: () => readNow(env) },
  });
}

function createRollbackRouteFinalizationApplication({ store, env, provider, trace }) {
  return createRollbackRouteFinalization({
    routeSnapshots: createDeploymentRouteSnapshotCommitApplication(store, env, trace, 'rollback_route_snapshot'),
    recovery: createRollbackRouteSnapshotRecoveryApplication({ store, env, provider, trace }),
    leases: { release: releaseSiteCommitLeaseBestEffort },
    completion: createSuccessfulRollbackFinalizationApplication({ store, env, trace }),
  });
}

export function createRollbackSiteApplication({ store, env, config, site, trace }) {
  let provider = null;
  const executionProvider = () => {
    provider ||= createDeploymentProvider(env, config, store, site);
    return provider;
  };
  return createRollbackSite({
    preparation: createRollbackActivationPreparationApplication(store, env, trace),
    cutover: {
      activate: (command) =>
        createRollbackRouteCutoverApplication({ store, env, trace, provider: executionProvider }).activate(command),
    },
    versions: {
      get: (versionId, environment) => store.getSiteVersion(versionId, environment),
    },
    finalization: {
      finalize: (command) =>
        createRollbackRouteFinalizationApplication({ store, env, trace, provider: executionProvider() }).finalize(command),
    },
    leases: { release: releaseSiteCommitLeaseBestEffort },
  });
}

export function createDeploymentRouteSnapshotRecoveryApplication({ store, env, trace = null }) {
  return createDeploymentRouteSnapshotRecovery({
    routes: createDeploymentRecoveryPort(store),
    runtimeConfig: createDeploymentRuntimeConfigRestorationApplication(store, env),
    ownerTransfers: createDeploymentOwnerTransferRestorationApplication(store),
    routeSnapshots: createDeploymentRouteSnapshotRecoveryAdapter({
      store,
      routeSnapshots: createDeploymentRouteSnapshotInfrastructure(store, env),
      routePointers: { clearIfCurrent: (pointer) => clearRoutePointerIfCurrent(env, pointer) },
    }),
    telemetry: {
      record: (result) =>
        trace
          ? recordDeploymentStage(trace, {
              stage: 'cleanup_or_compensation',
              operation: 'restore_route_after_snapshot_failure',
              status: result.repairRequired ? 'failed' : 'compensated',
              ...(result.repairRequired
                ? {
                    errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
                    errorMessage: 'Route snapshot compensation failed.',
                  }
                : {}),
              diagnostics: {
                causeClass: result.repairRequired
                  ? 'route_snapshot_compensation_error'
                  : 'route_snapshot_compensated',
                routePointerCommitted: false,
                trafficImpact: result.repairRequired
                  ? result.routePointerCleared
                    ? 'site_unavailable'
                    : 'public_route_state_unknown'
                  : 'old_version_retained',
                cleanupStatus: result.repairRequired ? 'failed' : 'succeeded',
                operatorAction: result.repairRequired ? 'repair_route_snapshot' : undefined,
              },
            })
          : undefined,
    },
    repairs: {
      report: (input) => logDeploymentRepairRequired(env, input),
    },
  });
}

function createDeploymentOwnerTransferRestorationApplication(store) {
  return createDeploymentOwnerTransferRestoration({
    owners: {
      restore: ({ siteId, environment, owner }) =>
        typeof store?.transferSiteOwner === 'function' ? store.transferSiteOwner(siteId, owner, environment) : null,
    },
  });
}

function createRollbackRouteSnapshotRecoveryApplication({ store, env, provider, trace = null }) {
  return createRollbackRouteSnapshotRecovery({
    routes: createRollbackRecoveryPort(store),
    officeNet: {
      ensure: (command) => ensurePublicWorkerOfficeNetAbsent(provider, { store, ...command }),
    },
    routeSnapshots: createDeploymentRouteSnapshotRecoveryAdapter({
      store,
      routeSnapshots: createDeploymentRouteSnapshotInfrastructure(store, env),
      routePointers: { clearIfCurrent: (pointer) => clearRoutePointerIfCurrent(env, pointer) },
    }),
    telemetry: {
      record: (result) =>
        trace
          ? recordDeploymentStage(trace, {
              stage: 'cleanup_or_compensation',
              operation: 'rollback_restore_route_after_snapshot_failure',
              status: result.repairRequired ? 'failed' : 'compensated',
              ...(result.repairRequired
                ? {
                    errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
                    errorMessage: 'Rollback route snapshot compensation failed.',
                  }
                : {}),
              diagnostics: {
                causeClass: result.repairRequired
                  ? 'route_snapshot_compensation_error'
                  : 'route_snapshot_compensated',
                routePointerCommitted: false,
                trafficImpact: result.repairRequired
                  ? result.routePointerCleared
                    ? 'site_unavailable'
                    : 'public_route_state_unknown'
                  : 'old_version_retained',
                cleanupStatus: result.repairRequired ? 'failed' : 'succeeded',
                operatorAction: result.repairRequired ? 'repair_route_snapshot' : undefined,
              },
            })
          : undefined,
    },
    repairs: {
      report: (input) => logDeploymentRepairRequired(env, input),
    },
    clock: { now: () => readNow(env) },
  });
}

export function createDeploymentSucceededWebhookApplication({ store, env, config, trace }) {
  return createDeploymentSucceededWebhook({
    teams: createDeploymentWebhookTeamsPort(store),
    webhooks: createDeploymentWebhookDispatcher({ store, env, config }),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'webhook_delivery',
              operation: 'site_deployed',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.status === 'failed'
                ? {
                    errorCode: 'WEBHOOK_DELIVERY_FAILED',
                    errorMessage: 'Webhook delivery failed.',
                    diagnostics: { causeClass: outcome.causeClass },
                  }
                : {}),
            })
          : undefined,
    },
    clock: { now: () => readNow(env) },
    ids: { next: (prefix) => nextId(env, prefix) },
  });
}

function createDeploymentFailedWebhookApplication({ store, env, config, trace }) {
  return createDeploymentFailedWebhook({
    teams: createDeploymentWebhookTeamsPort(store),
    webhooks: createDeploymentWebhookDispatcher({ store, env, config }),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'webhook_delivery',
              operation: 'site_failed',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.status === 'failed'
                ? {
                    errorCode: 'WEBHOOK_DELIVERY_FAILED',
                    errorMessage: 'Webhook delivery failed.',
                    diagnostics: { causeClass: outcome.causeClass },
                  }
                : {}),
            })
          : undefined,
    },
    clock: { now: () => readNow(env) },
    ids: { next: (prefix) => nextId(env, prefix) },
  });
}

function createDeploymentFailureRecoveryMarkersInfrastructure(env, config) {
  return createDeploymentFailureRecoveryMarkers({
    markers: env?.ROUTE_SNAPSHOTS,
    environment: config.environment,
    durableRecords: {
      write: (input) =>
        writeDeploymentFailureRecoveryRecord(env, {
          environment: config.environment,
          ...input,
        }),
      list: (input) =>
        listDeploymentFailureRecoveryRecords(env, {
          environment: config.environment,
          ...input,
        }),
      delete: (input) =>
        deleteDeploymentFailureRecoveryRecord(env, {
          environment: config.environment,
          ...input,
        }),
    },
    clock: { now: () => readNow(env) },
  });
}

export function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

export async function recoverUnexpectedRequestFailure({ trace, store, env, config, ctx, actor, fallbackOperation }) {
  return createUnexpectedRequestFailureRecoveryApplication({ store, env, config, ctx }).recover({
    trace,
    actor,
    environment: config.environment,
    fallbackOperation,
  });
}

export async function recoverFailedDeploymentsForSite({ store, env, config, ctx, actor, site }) {
  return createFailedDeploymentsRecoveryApplication({ store, env, config, ctx }).recover({
    site,
    actor,
    environment: config.environment,
  });
}

export async function bindExistingDeploymentTrace(trace, store, deployment, environment) {
  let existing = deployment;
  let claimFailed = false;
  if (!existing.traceId && typeof store.claimDeploymentTrace === 'function') {
    try {
      existing =
        (await store.claimDeploymentTrace({
          id: existing.id,
          environment,
          traceId: trace.traceId,
        })) || existing;
    } catch {
      claimFailed = true;
    }
  }
  const attempt = await nextDeploymentTraceAttempt(store, environment, existing.id);
  bindDeploymentTrace(trace, {
    traceId: existing.traceId || trace.traceId,
    deploymentId: existing.id,
    siteId: existing.siteId,
    attempt,
  });
  return { claimFailed, deployment: existing };
}

async function nextDeploymentTraceAttempt(store, environment, deploymentId) {
  if (typeof store.listDeploymentEvents !== 'function') return 2;
  try {
    const events = await store.listDeploymentEvents({ environment, deploymentId });
    return Math.max(1, ...events.map((event) => Number(event.attempt) || 1)) + 1;
  } catch {
    return 2;
  }
}
