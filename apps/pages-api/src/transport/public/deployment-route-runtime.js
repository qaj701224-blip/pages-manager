import { createRollbackLeaseAcquisition } from '../../application/deployments/acquire-rollback-lease.js';
import { createAuthorizeDeploymentCommit } from '../../application/deployments/authorize-commit.js';
import { createRollbackRouteCutover } from '../../application/deployments/activate-rollback-route.js';
import { createDeploymentRouteActivation } from '../../application/deployments/activate-route.js';
import { createDeploymentRouteCutover } from '../../application/deployments/activate-route-cutover.js';
import { createDeploymentRouteSnapshotCommit } from '../../application/deployments/commit-route-snapshot.js';
import { createDeploymentVersionCreation } from '../../application/deployments/create-version.js';
import { createRollbackOfficeNetVerification } from '../../application/deployments/ensure-rollback-office-net.js';
import { createRollbackActivationPreparation } from '../../application/deployments/prepare-rollback-activation.js';
import { createDeploymentRouteActivationPreparation } from '../../application/deployments/prepare-route-activation.js';
import { createDeploymentProviderOperations } from '../../application/deployments/provider-operations.js';
import { createRollbackRouteStateRead } from '../../application/deployments/read-rollback-route-state.js';
import { createDeploymentCommitLease } from '../../application/deployments/run-under-commit-lease.js';
import { createDeploymentCommitLeasePort } from '../../application/ports/deployment-commit-lease.js';
import { createDeploymentCompletionPort } from '../../application/ports/deployment-completion.js';
import { createDeploymentProviderPort } from '../../application/ports/deployment-provider.js';
import { createDeploymentRoutesPort } from '../../application/ports/deployment-routes.js';
import { createDeploymentVersionsPort } from '../../application/ports/deployment-versions.js';
import { createRollbackLeasePort } from '../../application/ports/rollback-lease.js';
import { createRollbackOfficeNetVersionsPort } from '../../application/ports/rollback-office-net-versions.js';
import { createRollbackRouteStatePort } from '../../application/ports/rollback-route-state.js';
import { createSiteOwnershipPort } from '../../application/ports/site-ownership.js';
import { runtimeSecretSnapshotRecords } from '../../deployment-runtime-config.js';
import { finishDeploymentStage, recordDeploymentStage, startDeploymentStage } from '../../deployment-trace.js';
import { createDeploymentProvider } from '../../execution-provider.js';
import { nextId } from '../../id.js';
import { createSiteRouteSnapshots } from '../../infrastructure/route-snapshots/site-route-snapshots.js';
import { buildRouteSnapshot, writeRouteSnapshot } from '../../route-snapshot.js';
import {
  createPublicWorkerOfficeNetGuardApplication,
  ensurePublicWorkerOfficeNetAbsent,
} from '../shared/public-office-net-application.js';
import { publicProviderErrorCode } from './deployment-diagnostics.js';
import { deploymentOperationError, rollbackOfficeNetOperationError } from './deployment-errors.js';
import { inactiveRouteVersion } from './deployment-projection.js';

export function createDeploymentProviderApplication({ env, config, store, trace = null }) {
  return createDeploymentProviderOperations({
    providers: createDeploymentProviderPort((site) => createDeploymentProvider(env, config, store, site)),
    uploadTelemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'provider_upload',
              operation: 'provider_upload',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.status === 'succeeded'
                ? { operation: outcome.operation }
                : {
                    error: outcome.cause,
                    errorCode: publicProviderErrorCode(outcome.cause, 'upload'),
                    errorMessage: 'Deployment upload failed.',
                    diagnostics: { causeClass: 'provider_upload_error' },
                  }),
            })
          : undefined,
    },
    verifyTelemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'provider_verify',
              operation: 'provider_verify',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.status === 'failed'
                ? {
                    error: outcome.cause,
                    errorCode: publicProviderErrorCode(null, 'verify'),
                    errorMessage: 'Deployment verification failed.',
                    diagnostics: { causeClass: 'provider_verify_error' },
                  }
                : {}),
            })
          : undefined,
    },
  });
}

export function createDeploymentCommitLeaseApplication(store, env, trace) {
  return createDeploymentCommitLease({
    leases: createDeploymentCommitLeasePort({
      store,
      ids: { next: (prefix) => nextId(env, prefix) },
    }),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'route_policy_lock',
              operation: 'acquire_site_commit_lock',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.status === 'failed'
                ? {
                    errorCode: outcome.cause?.code || 'SITE_POLICY_LOCKED',
                    errorMessage: outcome.cause?.message || 'Site policy lock could not be acquired.',
                    diagnostics: { causeClass: 'site_policy_lock_error' },
                  }
                : {}),
            })
          : undefined,
    },
  });
}

export function createRollbackActivationPreparationApplication(store, env, trace) {
  const leaseAcquisition = createRollbackLeaseAcquisitionApplication(store, env, trace);
  const routeState = createRollbackRouteStateReadApplication(store, trace);
  return createRollbackActivationPreparation({
    leases: {
      acquire: (command) => leaseAcquisition.acquire(command),
      release: releaseSiteCommitLeaseBestEffort,
    },
    routes: {
      read: (command) => routeState.read(command),
    },
  });
}

export function createDeploymentVersionCreationApplication(store, env, trace) {
  return createDeploymentVersionCreation({
    versions: createDeploymentVersionsPort(store),
    runtimeConfig: {
      snapshotSecrets: (secrets) => runtimeSecretSnapshotRecords(env, secrets),
    },
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'version_create',
              operation: 'create_site_version',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.reason === 'version_create_error'
                ? {
                    errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
                    errorMessage: 'Deployment version could not be persisted.',
                    diagnostics: { causeClass: 'version_store_error' },
                  }
                : {}),
            })
          : undefined,
    },
  });
}

export function createDeploymentRouteActivationPreparationApplication(store, env) {
  return createDeploymentRouteActivationPreparation({
    routes: createDeploymentRoutesPort(store),
    deploymentState: createDeploymentCompletionPort(store),
    routeSnapshots: {
      assertConverged: ({ route, environment }) => assertRouteSnapshotConverged(env, store, route, environment),
    },
  });
}

export function createDeploymentCommitAuthorizationApplication(store, env) {
  return createAuthorizeDeploymentCommit({
    sites: createSiteOwnershipPort(store),
    clock: { now: () => readNow(env) },
  });
}

export function createDeploymentRouteCutoverApplication({ store, env, trace, provider }) {
  const officeNet = createPublicWorkerOfficeNetGuardApplication(store, trace);
  return createDeploymentRouteCutover({
    leases: { assertHealthy: assertCommitLeaseHealthy },
    officeNet: {
      ensure: (command) => officeNet.ensure({ ...command, provider }),
    },
    routes: createDeploymentRouteActivationApplication(store, env, trace),
  });
}

export function createRollbackRouteCutoverApplication({ store, env, trace, provider }) {
  const resolveProvider = typeof provider === 'function' ? provider : () => provider;
  return createRollbackRouteCutover({
    routeSnapshots: {
      assertConverged: ({ route, environment }) => assertRouteSnapshotConverged(env, store, route, environment),
    },
    leases: { assertHealthy: assertCommitLeaseHealthy },
    officeNet: {
      verify: (command) =>
        createRollbackOfficeNetVerificationApplication({ store, provider: resolveProvider(), trace }).verify(command),
    },
    routes: createDeploymentRouteActivationApplication(store, env, trace, {
      operation: 'rollback_route_activate',
      conflictMessage: 'Route changed while rollback was activating.',
      failureCode: 'ROLLBACK_ACTIVATION_FAILED',
      failureMessage: 'Rollback activation failed.',
      failureCauseClass: 'rollback_activation_error',
    }),
  });
}

export function createDeploymentRouteSnapshotCommitApplication(store, env, trace, operation) {
  return createDeploymentRouteSnapshotCommit({
    routeSnapshots: createDeploymentRouteSnapshotInfrastructure(store, env),
    leases: { assertHealthy: assertCommitLeaseHealthy },
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'route_snapshot',
              operation,
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.reason === 'snapshot_error'
                ? {
                    errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
                    errorMessage: 'Route snapshot write failed.',
                    diagnostics: { causeClass: 'route_snapshot_store_error' },
                  }
                : {}),
            })
          : undefined,
    },
  });
}

export function createDeploymentRouteSnapshotInfrastructure(store, env) {
  return createSiteRouteSnapshots({
    store,
    buildSnapshot: buildRouteSnapshot,
    writeSnapshot: (snapshot) => writeRouteSnapshot(env, snapshot),
  });
}

export async function releaseSiteCommitLeaseBestEffort(lease) {
  if (!lease || typeof lease.release !== 'function') return false;
  try {
    return await lease.release();
  } catch {
    return false;
  }
}

function createRollbackOfficeNetVerificationApplication({ store, provider, trace = null }) {
  return createRollbackOfficeNetVerification({
    versions: createRollbackOfficeNetVersionsPort(store),
    officeNet: {
      ensure: (command) => ensurePublicWorkerOfficeNetAbsent(provider, { store, ...command }),
    },
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'office_net',
              operation: 'rollback_verify_public_office_net_absent',
            })
          : null,
      finish: (stage, outcome) => {
        if (!stage) return undefined;
        const error = outcome.error ? rollbackOfficeNetOperationError(outcome.error) : outcome.cause;
        return finishDeploymentStage(stage, {
          status: outcome.status,
          ...(outcome.status === 'failed'
            ? {
                error,
                errorCode: error?.code || 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
                errorMessage: error?.message || 'Public Worker OfficeNet verification failed.',
                diagnostics: { causeClass: 'public_office_net_error' },
              }
            : {}),
        });
      },
    },
  });
}

function createRollbackLeaseAcquisitionApplication(store, env, trace) {
  return createRollbackLeaseAcquisition({
    leases: createRollbackLeasePort({
      store,
      acquireRenewable: acquireRenewableSiteCommitLease,
      ids: { next: (prefix) => nextId(env, prefix) },
      options: {
        ...(Number.isFinite(env?.SITE_COMMIT_LOCK_RENEW_INTERVAL_MS)
          ? { renewIntervalMs: env.SITE_COMMIT_LOCK_RENEW_INTERVAL_MS }
          : {}),
        ...(Number.isFinite(env?.SITE_COMMIT_LOCK_TIMEOUT_MS) ? { timeoutMs: env.SITE_COMMIT_LOCK_TIMEOUT_MS } : {}),
      },
    }),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'route_policy_lock',
              operation: 'rollback_policy_lock',
            })
          : null,
      finish: (stage, outcome) => {
        if (!stage) return undefined;
        if (outcome.reason === 'acquire_failed') {
          return finishDeploymentStage(stage, {
            status: 'failed',
            errorCode: 'SITE_POLICY_LOCKED',
            errorMessage: 'Site policy lock could not be acquired.',
            diagnostics: { causeClass: 'site_policy_lock_error' },
          });
        }
        if (outcome.reason === 'lease_unavailable') {
          return finishDeploymentStage(stage, {
            status: 'failed',
            errorCode: 'SITE_POLICY_CONFLICT',
            errorMessage: 'Site policy changed while rollback was preparing.',
            diagnostics: { causeClass: 'site_policy_conflict' },
          });
        }
        return finishDeploymentStage(stage, { status: outcome.status });
      },
    },
  });
}

function createRollbackRouteStateReadApplication(store, trace = null) {
  return createRollbackRouteStateRead({
    routes: createRollbackRouteStatePort(store),
    telemetry: {
      failed: (error) => {
        if (!trace) return undefined;
        const routeReadFailed = error.reason === 'route_read_failed';
        return recordDeploymentStage(trace, {
          stage: 'route_activate',
          operation: routeReadFailed ? 'rollback_route_state_read' : 'rollback_route_activate',
          status: 'failed',
          errorCode: routeReadFailed ? 'ROLLBACK_ACTIVATION_FAILED' : 'ROUTE_ACTIVATION_CONFLICT',
          errorMessage: routeReadFailed
            ? 'Rollback route state could not be read.'
            : 'Route changed while rollback was activating.',
          diagnostics: {
            causeClass: routeReadFailed ? 'rollback_route_state_read_error' : 'route_activation_conflict',
          },
        });
      },
    },
  });
}

function createDeploymentRouteActivationApplication(store, env, trace = null, profile = {}) {
  const operation = profile.operation || 'activate_route';
  const conflictMessage = profile.conflictMessage || 'Route changed while deployment was activating.';
  const failureCode = profile.failureCode || 'ROUTE_ACTIVATION_FAILED';
  const failureMessage = profile.failureMessage || 'Route activation failed.';
  const failureCauseClass = profile.failureCauseClass || 'route_activation_error';
  return createDeploymentRouteActivation({
    routes: createDeploymentRoutesPort(store),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'route_activate',
              operation,
            })
          : null,
      finish: (stage, outcome) => {
        if (!stage) return undefined;
        if (outcome.reason === 'cas_conflict') {
          return finishDeploymentStage(stage, {
            status: 'failed',
            errorCode: 'ROUTE_ACTIVATION_CONFLICT',
            errorMessage: conflictMessage,
            diagnostics: { causeClass: 'route_activation_conflict' },
          });
        }
        if (outcome.reason === 'route_error') {
          return finishDeploymentStage(stage, {
            status: 'failed',
            error: outcome.cause,
            errorCode: outcome.cause?.code || failureCode,
            errorMessage: outcome.cause?.message || failureMessage,
            diagnostics: { causeClass: failureCauseClass },
          });
        }
        return finishDeploymentStage(stage, { status: outcome.status });
      },
    },
    clock: { now: () => readNow(env) },
  });
}

async function acquireRenewableSiteCommitLease(store, environment, siteId, options) {
  const acquireOptions = { ...options };
  delete acquireOptions.bestEffortRelease;
  const lease = await store.acquireSiteCommitLock(environment, siteId, acquireOptions);
  if (!lease) return null;
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(
    () => {
      controller.abort(deploymentOperationError('SITE_COMMIT_TIMEOUT'));
    },
    options.timeoutMs || 45 * 1000
  );
  let currentLease = lease;
  let renewal = Promise.resolve();
  let renewalError = null;
  const renew = () => {
    renewal = renewal
      .then(async () => {
        const renewed = await store.renewSiteCommitLock(environment, siteId, currentLease.lockId, {
          fencingToken: currentLease.fencingToken,
          leaseMs: options.leaseMs,
        });
        if (!renewed) throw deploymentOperationError('SITE_POLICY_LOCKED');
        currentLease = renewed;
      })
      .catch((error) => {
        renewalError = error;
        controller.abort(error);
        throw error;
      });
    renewal.catch(() => {});
  };
  const timer = globalThis.setInterval(renew, options.renewIntervalMs || 20 * 1000);
  return {
    ...currentLease,
    get fencingToken() {
      return currentLease.fencingToken;
    },
    assertHealthy() {
      if (renewalError) throw renewalError;
      if (controller.signal.aborted) {
        throw controller.signal.reason || deploymentOperationError('SITE_POLICY_LOCKED');
      }
    },
    signal: controller.signal,
    async release() {
      globalThis.clearInterval(timer);
      globalThis.clearTimeout(timeout);
      try {
        await renewal;
      } catch {
        // Preserve the operation error; renewal loss is already reflected in the signal.
      }
      return releaseSiteCommitLockBestEffort(store, environment, siteId, currentLease.lockId);
    },
  };
}

async function releaseSiteCommitLockBestEffort(store, environment, siteId, lockId) {
  if (!lockId || typeof store?.releaseSiteCommitLock !== 'function') return false;
  try {
    return await store.releaseSiteCommitLock(environment, siteId, lockId);
  } catch {
    return false;
  }
}

function assertCommitLeaseHealthy(lease) {
  if (typeof lease?.assertHealthy === 'function') return lease.assertHealthy();
  if (lease?.signal?.aborted) {
    throw lease.signal.reason || deploymentOperationError('SITE_POLICY_LOCKED');
  }
}

async function assertRouteSnapshotConverged(env, store, route, environment) {
  if (!env?.ROUTE_SNAPSHOTS || typeof env.ROUTE_SNAPSHOTS.get !== 'function') return;
  const version = route.activeVersionId
    ? await store.getSiteVersion(route.activeVersionId, environment)
    : inactiveRouteVersion(route);
  if (!version && route.routeStatus === 'active') {
    throw deploymentOperationError('ROUTE_ACTIVATION_CONFLICT', {
      message: 'The active route version could not be verified before activation.',
    });
  }
  // KV is eventually consistent. The site commit lock and the RoutePointerDO
  // stale-pointer check protect this activation; an exact KV read here would
  // turn a cached old/null pointer into a false activation conflict.
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
