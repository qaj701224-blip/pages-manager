import { buildSiteOwnerTransferAuditEvent } from '../../application/sites/build-owner-transfer-audit-event.js';
import { decisionRequiresWorker } from '../../deployment-plan.js';
import { jsonError, jsonOk } from '../../http.js';
import { nextId } from '../../id.js';
import { deploymentStateWriteFailed } from '../shared/deployment-responses.js';
import { isPublicOfficeNetFailure, publicOfficeNetOperationError } from '../shared/public-office-net-application.js';
import {
  buildDeploymentFailureDiagnostics,
  deploymentStoreErrorCause,
} from './deployment-diagnostics.js';
import {
  deploymentOperationError,
  deploymentOperationFailurePatch,
  siteNotFound,
} from './deployment-errors.js';
import { readDeploySiteRequest } from './deploy-site-intake.js';
import { startDeploySite } from './deploy-site-start.js';
import { prepareDeploymentUpload } from './deployment-upload-stage.js';
import {
  createDeploymentActivationFailureRecoveryApplication,
  createDeploymentRouteSnapshotRecoveryApplication,
  createSuccessfulDeploymentFinalizationApplication,
  createUploadedWorkerCompensationApplication,
  persistIntermediateDeploymentState,
  readNow,
  recordDeploymentStatePersistFailure,
  updateDeploymentToFailedAndNotify,
} from './deployment-lifecycle-runtime.js';
import { deploymentEnvelope } from './deployment-projection.js';
import { validateDeploymentRuntimeConfigSnapshot } from './deployment-runtime-config.js';
import {
  createDeploymentCommitLeaseApplication,
  createDeploymentRouteActivationPreparationApplication,
  createDeploymentRouteCutoverApplication,
  createDeploymentRouteSnapshotCommitApplication,
  createDeploymentVersionCreationApplication,
} from './deployment-route-runtime.js';

export async function createDeployment(request, env, config, store, actor, ctx, trace, authStage) {
  const intake = await readDeploySiteRequest({ request, config, trace });
  if (!intake.ok) return intake.response;
  const {
    decision,
    workerRuntimeVarsProvided,
    requestedRuntimeVars,
    artifactBundle,
    assetManifest,
    assetFiles,
    canonicalContentHash,
  } = intake.input;
  const started = await startDeploySite({ input: intake.input, env, config, store, actor, ctx, trace, authStage });
  if (!started.ok) return started.response;
  let { site } = started;
  const { siteId, deployment } = started;
  let ownerTransfer = null;
  const prepared = await prepareDeploymentUpload({
    site,
    siteId,
    deployment,
    decision,
    workerRuntimeVarsProvided,
    requestedRuntimeVars,
    artifactBundle,
    assetManifest,
    assetFiles,
    canonicalContentHash,
    env,
    config,
    store,
    actor,
    ctx,
    trace,
  });
  if (!prepared.ok) return prepared.response;
  site = prepared.site;
  const {
    runtimeVars,
    runtimeVarRecords,
    originalRuntimeVarRecords,
    runtimeSecrets,
    versionId,
    provider,
    uploaded,
    workerName,
    committedRuntimeVarRecords,
    uploadExposure,
  } = prepared;
  const finalizeFailedDeployment = (patch) =>
    updateDeploymentToFailedAndNotify({
      store,
      env,
      config,
      ctx,
      deploymentId: deployment.id,
      patch,
      actor,
      site,
      trace,
    });

  let version;
  let previousRoute;
  let route;
  let ownerTransferRollbackSite = null;
  let ownerTransferApplied = false;
  let activationSnapshotFailureResponse = null;
  let routePolicyLockFailed = false;
  try {
    await persistIntermediateDeploymentState(store, deployment.id, { status: 'verified' }, 'persist_verified_deployment');
    previousRoute = await store.getRouteBySiteId(siteId, config.environment);
    const preActivationRuntimeSnapshotError = decisionRequiresWorker(decision)
      ? await validateDeploymentRuntimeConfigSnapshot(store, {
          environment: config.environment,
          siteId,
          expectedVars: runtimeVarRecords,
          expectedSecrets: runtimeSecrets,
        })
      : null;
    if (preActivationRuntimeSnapshotError) {
      const recovery = await createDeploymentActivationFailureRecoveryApplication({ store, env, provider, trace }).recover({
        site,
        worker: {
          uploaded,
          originalFailure: { stage: 'runtime_config', code: preActivationRuntimeSnapshotError.code },
          trafficImpact: 'old_version_retained',
        },
        runtimeConfig: {
          environment: config.environment,
          siteId,
          restoreVars: originalRuntimeVarRecords,
          expectedVars: committedRuntimeVarRecords,
          actorId: actor.userId,
          enabled: workerRuntimeVarsProvided,
        },
        ownerTransfer: {
          siteId,
          previousSite: ownerTransferRollbackSite,
          environment: config.environment,
          enabled: ownerTransferApplied,
        },
      });
      site = recovery.site;
      await finalizeFailedDeployment({
        errorCode: preActivationRuntimeSnapshotError.code,
        errorMessage: preActivationRuntimeSnapshotError.message,
        failureStage: 'runtime_config_pre_activation',
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: 'runtime_config_pre_activation',
          executionProvider: uploaded.executionProvider || provider.executionProvider || 'wfp',
          deploymentShape: decision.deploymentShape,
          plannedVersionId: versionId,
          plannedWorkerName: workerName,
          uploadCompleted: true,
          verifyCompleted: true,
          routePointerCommitted: false,
          uploadedWorkerCleanup: 'attempted',
          cause: { code: preActivationRuntimeSnapshotError.code, class: 'runtime_config_changed' },
        }),
        completedAt: readNow(env),
      });
      return jsonError(
        preActivationRuntimeSnapshotError.code,
        preActivationRuntimeSnapshotError.message,
        preActivationRuntimeSnapshotError.status,
        preActivationRuntimeSnapshotError.action
      );
    }
    if (site.pendingOwnerTransfer) {
      ownerTransferRollbackSite = site;
      const transferResult = await applyPendingDeployOwnerTransfer(store, actor, config, env, site, site.pendingOwnerTransfer);
      if (transferResult instanceof Response) {
        const recovery = await createDeploymentActivationFailureRecoveryApplication({ store, env, provider, trace }).recover({
          site,
          worker: {
            uploaded,
            originalFailure: { stage: 'auth_and_site_resolution', code: 'SITE_TRANSFER_FAILED' },
            trafficImpact: 'old_version_retained',
          },
          runtimeConfig: {
            environment: config.environment,
            siteId,
            restoreVars: originalRuntimeVarRecords,
            expectedVars: committedRuntimeVarRecords,
            actorId: actor.userId,
            enabled: workerRuntimeVarsProvided,
          },
          ownerTransfer: {
            siteId,
            previousSite: ownerTransferRollbackSite,
            environment: config.environment,
            enabled: ownerTransferApplied,
          },
        });
        site = recovery.site;
        await finalizeFailedDeployment(
          deploymentOperationFailurePatch({
            errorCode: 'SITE_TRANSFER_FAILED',
            errorMessage: 'Site owner transfer failed.',
          })
        );
        return transferResult;
      }
      ownerTransferApplied = true;
      site = transferResult.site;
      ownerTransfer = transferResult.ownerTransfer;
    }
    const versionResult = await createDeploymentVersionCreationApplication(store, env, trace).create({
      versionId,
      siteId,
      deploymentId: deployment.id,
      workerName,
      uploaded,
      executionProvider: provider.executionProvider,
      decision,
      contentHash: canonicalContentHash,
      artifactBundle,
      assetManifest,
      runtimeVars,
      runtimeVarRecords,
      runtimeSecrets,
      actorId: actor.userId,
    });
    if (!versionResult.ok) throw versionResult.error.cause;
    version = versionResult.version;
    await persistIntermediateDeploymentState(
      store,
      deployment.id,
      {
        status: 'activating',
        versionId: version.id,
      },
      'persist_activating_deployment'
    );
    const commitLeaseApplication = createDeploymentCommitLeaseApplication(store, env, trace);
    const routeActivationPreparation = createDeploymentRouteActivationPreparationApplication(store, env);
    const routeCutoverApplication = createDeploymentRouteCutoverApplication({ store, env, trace, provider });
    const routeSnapshotApplication = createDeploymentRouteSnapshotCommitApplication(
      store,
      env,
      trace,
      'write_route_snapshot'
    );
    const commitResult = await commitLeaseApplication.run(
      { environment: config.environment, siteId },
      async (activationLease) => {
        const routeBeforeActivation = previousRoute;
        const activationPreparation = await routeActivationPreparation.prepare({
          deploymentId: deployment.id,
          environment: config.environment,
          siteId,
          site,
          routeBeforeActivation,
          uploadExposure,
          ownerTransferApplied,
        });
        if (activationPreparation.latestRoute) previousRoute = activationPreparation.latestRoute;
        if (!activationPreparation.ok) {
          throw activationPreparation.error.reason === 'exposure_changed'
            ? deploymentOperationError('ROUTE_ACTIVATION_CONFLICT', {
                message: 'Site exposure changed while deployment was uploading.',
                action: 'Retry the deployment so Worker bindings match the latest site exposure.',
              })
            : deploymentOperationError(activationPreparation.error.code);
        }
        const activation = activationPreparation.activation;
        const activationResult = await routeCutoverApplication.activate({
          environment: config.environment,
          siteId,
          version,
          lease: activationLease,
          activation,
          deploymentShape: decision.deploymentShape,
        });
        if (!activationResult.ok && activationResult.kind === 'office_net_failed') {
          throw publicOfficeNetOperationError(activationResult.error);
        }
        const activatedRoute = activationResult.ok ? activationResult.route : null;
        if (!activatedRoute) return null;
        const snapshotResult = await routeSnapshotApplication.commit({
          site,
          route: activatedRoute,
          version,
          lease: activationLease,
        });
        if (!snapshotResult.ok) {
          const recovery = await createDeploymentRouteSnapshotRecoveryApplication({ store, env, trace }).recover({
            siteId,
            deploymentId: deployment.id,
            environment: config.environment,
            site,
            previousRoute,
            failedRoute: activatedRoute,
            runtimeConfig: {
              environment: config.environment,
              siteId,
              restoreVars: originalRuntimeVarRecords,
              expectedVars: committedRuntimeVarRecords,
              actorId: actor.userId,
              enabled: workerRuntimeVarsProvided,
            },
            ownerTransfer: {
              previousSite: ownerTransferRollbackSite,
              enabled: ownerTransferApplied,
            },
          });
          site = recovery.site;
          const { restoredRoute, restoredSnapshotWritten, routePointerCleared, repairRequired } = recovery;
          if (restoredSnapshotWritten) {
            await createUploadedWorkerCompensationApplication({ store, provider, trace }).cleanupIfInactive({
              uploaded,
              siteId,
              versionId: version.id,
              environment: config.environment,
              originalFailure: { stage: 'route_snapshot', code: 'ROUTE_SNAPSHOT_WRITE_FAILED' },
              trafficImpact: repairRequired ? 'public_route_state_unknown' : 'old_version_retained',
            });
          }
          await finalizeFailedDeployment({
            versionId: version.id,
            errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
            errorMessage: 'Route snapshot write failed.',
            failureStage: 'write_route_snapshot',
            failureDiagnostics: buildDeploymentFailureDiagnostics({
              stage: 'write_route_snapshot',
              executionProvider: version.executionProvider || uploaded.executionProvider || provider.executionProvider || 'wfp',
              deploymentShape: decision.deploymentShape,
              plannedVersionId: version.id,
              plannedWorkerName: version.workerName,
              uploadCompleted: true,
              verifyCompleted: true,
              routeActivatedInD1: true,
              routePointerCommitted: false,
              previousRouteRestored: Boolean(restoredRoute),
              uploadedWorkerCleanup: restoredSnapshotWritten ? 'attempted' : 'skipped',
              routePointerCleared,
              trafficImpact: repairRequired
                ? routePointerCleared
                  ? 'site_unavailable'
                  : 'public_route_state_unknown'
                : undefined,
              operatorAction: repairRequired ? 'repair_route_snapshot' : undefined,
              cause: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', class: 'route_snapshot_store_error' },
            }),
            completedAt: readNow(env),
          });
          activationSnapshotFailureResponse = jsonError(
            'ROUTE_SNAPSHOT_WRITE_FAILED',
            'Route snapshot could not be written.',
            503,
            'Retry the deployment with a new Idempotency-Key.'
          );
          return null;
        }
        return activatedRoute;
      }
    );
    if (!commitResult.ok) {
      routePolicyLockFailed = true;
      if (commitResult.error.reason === 'capability_unavailable') {
        throw deploymentOperationError(commitResult.error.code);
      }
      throw commitResult.error.cause;
    }
    route = commitResult.value;
  } catch (error) {
    const recovery = await createDeploymentActivationFailureRecoveryApplication({ store, env, provider, trace }).recover({
      site,
      worker: {
        uploaded,
        originalFailure: error?.deploymentStateOperation
          ? { stage: 'deployment_state_persist', code: 'DEPLOYMENT_STATE_WRITE_FAILED' }
          : isPublicOfficeNetFailure(error)
            ? { stage: 'office_net', code: error.code }
            : routePolicyLockFailed
              ? { stage: 'route_policy_lock', code: error?.code || 'SITE_POLICY_LOCKED' }
            : error?.code === 'SITE_POLICY_LOCKED' || error?.code === 'ROUTE_ACTIVATION_CONFLICT'
              ? { stage: 'route_activate', code: error.code }
              : { stage: 'version_create', code: 'DEPLOYMENT_STATE_WRITE_FAILED' },
        trafficImpact: 'old_version_retained',
      },
      runtimeConfig: {
        environment: config.environment,
        siteId,
        restoreVars: originalRuntimeVarRecords,
        expectedVars: committedRuntimeVarRecords,
        actorId: actor.userId,
        enabled: workerRuntimeVarsProvided,
      },
      ownerTransfer: {
        siteId,
        previousSite: ownerTransferRollbackSite,
        environment: config.environment,
        enabled: ownerTransferApplied,
      },
    });
    site = recovery.site;
    if (isPublicOfficeNetFailure(error)) {
      await finalizeFailedDeployment({
        versionId: version?.id || null,
        errorCode: error.code,
        errorMessage: error.message,
        failureStage: 'activate_public_office_net',
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: 'activate_public_office_net',
          executionProvider: version?.executionProvider || uploaded?.executionProvider || provider.executionProvider || 'wfp',
          deploymentShape: decision.deploymentShape,
          plannedVersionId: version?.id || versionId,
          plannedWorkerName: version?.workerName || workerName,
          uploadCompleted: true,
          verifyCompleted: true,
          routeActivatedInD1: false,
          routePointerCommitted: false,
          uploadedWorkerCleanup: 'attempted',
          cause: { code: error.code, class: 'public_office_net_error' },
        }),
        completedAt: readNow(env),
      });
      return jsonError(
        error.code,
        error.message,
        error.status || 503,
        error.action || 'Check the active Worker settings and retry the deployment.'
      );
    }
    if (error?.code === 'SITE_POLICY_LOCKED' || error?.code === 'ROUTE_ACTIVATION_CONFLICT') {
      const failureStage = routePolicyLockFailed ? 'route_policy_lock' : 'activate_route';
      await finalizeFailedDeployment({
        versionId: version?.id || null,
        errorCode: error.code,
        errorMessage: error.message,
        failureStage,
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: failureStage,
          executionProvider: version?.executionProvider || uploaded?.executionProvider || provider.executionProvider || 'wfp',
          deploymentShape: decision.deploymentShape,
          plannedVersionId: version?.id || versionId,
          plannedWorkerName: version?.workerName || workerName,
          uploadCompleted: true,
          verifyCompleted: true,
          routeActivatedInD1: false,
          routePointerCommitted: false,
          uploadedWorkerCleanup: 'attempted',
          cause: {
            code: error.code,
            class: routePolicyLockFailed ? 'site_policy_lock_error' : 'route_activation_conflict',
          },
        }),
        completedAt: readNow(env),
      });
      return jsonError(error.code, error.message, error.status || 409, error.action);
    }
    await recordDeploymentStatePersistFailure({
      trace,
      env,
      deploymentId: deployment.id,
      operation: error?.deploymentStateOperation || 'persist_activation_state',
      cause: error,
    });
    await finalizeFailedDeployment(
      {
        versionId: version?.id,
        errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
        errorMessage: 'Deployment state could not be persisted.',
        failureStage: 'persist_deployment_state',
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: 'persist_deployment_state',
          executionProvider: 'unknown',
          plannedVersionId: version?.id,
          routePointerCommitted: false,
          cause: deploymentStoreErrorCause(),
        }),
        completedAt: readNow(env),
      }
    );
    return deploymentStateWriteFailed();
  }
  if (activationSnapshotFailureResponse) return activationSnapshotFailureResponse;
  if (!route) {
    const latestRoute = await store.getRouteBySiteId(siteId, config.environment);
    const runtimeConfigChanged =
      decisionRequiresWorker(decision) &&
      latestRoute &&
      previousRoute &&
      latestRoute.routeGeneration === previousRoute.routeGeneration &&
      latestRoute.policyVersion === previousRoute.policyVersion &&
      latestRoute.activeVersionId === previousRoute.activeVersionId &&
      (latestRoute.runtimeConfigGeneration || 0) !== (previousRoute.runtimeConfigGeneration || 0);
    if (runtimeConfigChanged) {
      const recovery = await createDeploymentActivationFailureRecoveryApplication({ store, env, provider, trace }).recover({
        site,
        worker: {
          uploaded,
          originalFailure: { stage: 'runtime_config', code: 'RUNTIME_CONFIG_CHANGED' },
          trafficImpact: 'old_version_retained',
        },
        runtimeConfig: {
          environment: config.environment,
          siteId,
          restoreVars: originalRuntimeVarRecords,
          expectedVars: committedRuntimeVarRecords,
          actorId: actor.userId,
          enabled: workerRuntimeVarsProvided,
        },
        ownerTransfer: {
          siteId,
          previousSite: ownerTransferRollbackSite,
          environment: config.environment,
          enabled: ownerTransferApplied,
        },
      });
      site = recovery.site;
      await finalizeFailedDeployment({
        versionId: version.id,
        errorCode: 'RUNTIME_CONFIG_CHANGED',
        errorMessage: 'Runtime configuration changed while deployment was activating.',
        failureStage: 'runtime_config_activation',
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: 'runtime_config_activation',
          executionProvider: version.executionProvider || uploaded.executionProvider || provider.executionProvider || 'wfp',
          deploymentShape: decision.deploymentShape,
          plannedVersionId: version.id,
          plannedWorkerName: version.workerName,
          uploadCompleted: true,
          verifyCompleted: true,
          routeActivatedInD1: false,
          routePointerCommitted: false,
          uploadedWorkerCleanup: 'attempted',
          cause: { code: 'RUNTIME_CONFIG_CHANGED', class: 'runtime_config_changed' },
        }),
        completedAt: readNow(env),
      });
      return jsonError(
        'RUNTIME_CONFIG_CHANGED',
        'Runtime configuration changed while deployment was activating.',
        409,
        'Retry the deployment with a new Idempotency-Key.'
      );
    }
    const recovery = await createDeploymentActivationFailureRecoveryApplication({ store, env, provider, trace }).recover({
      site,
      worker: {
        uploaded,
        originalFailure: { stage: 'route_activate', code: 'ROUTE_ACTIVATION_CONFLICT' },
        trafficImpact: 'old_version_retained',
      },
      runtimeConfig: {
        environment: config.environment,
        siteId,
        restoreVars: originalRuntimeVarRecords,
        expectedVars: committedRuntimeVarRecords,
        actorId: actor.userId,
        enabled: workerRuntimeVarsProvided,
      },
      ownerTransfer: {
        siteId,
        previousSite: ownerTransferRollbackSite,
        environment: config.environment,
        enabled: ownerTransferApplied,
      },
    });
    site = recovery.site;
    await finalizeFailedDeployment({
      versionId: version.id,
      errorCode: 'ROUTE_ACTIVATION_CONFLICT',
      errorMessage: 'Route changed while deployment was activating.',
      failureStage: 'activate_route',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'activate_route',
        executionProvider: version.executionProvider || uploaded.executionProvider || provider.executionProvider || 'wfp',
        deploymentShape: decision.deploymentShape,
        plannedVersionId: version.id,
        plannedWorkerName: version.workerName,
        uploadCompleted: true,
        verifyCompleted: true,
        routeActivatedInD1: false,
        routePointerCommitted: false,
        uploadedWorkerCleanup: 'attempted',
        cause: { code: 'ROUTE_ACTIVATION_CONFLICT', class: 'route_activation_conflict' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      'ROUTE_ACTIVATION_CONFLICT',
      'Route changed while deployment was activating.',
      409,
      'Check the latest site status and retry the deployment with a new Idempotency-Key.'
    );
  }
  const completed = await createSuccessfulDeploymentFinalizationApplication({
    store,
    env,
    config,
    ctx,
    provider,
    trace,
  }).finalize({
    deployment,
    version,
    actor,
    site,
    previousRoute,
    route,
    environment: config.environment,
  });

  return jsonOk(await deploymentEnvelope(store, completed, { version, route, decision, ownerTransfer }), 201);
}

async function applyPendingDeployOwnerTransfer(store, actor, config, env, site, transfer) {
  const updatedAt = readNow(env);
  const auditEvent = buildSiteOwnerTransferAuditEvent({
    id: nextId(env, 'aud'),
    environment: config.environment,
    actor,
    site,
    target: { ownerType: 'team', ownerId: transfer.ownerId },
    source: 'deploy',
    createdAt: updatedAt,
  });
  const updated = await store.transferSiteOwner(
    site.id,
    {
      ownerType: 'team',
      ownerId: transfer.ownerId,
      ownerUserId: actor.userId || site.ownerUserId,
      defaultVisibility: transfer.visibility || undefined,
      updatedAt,
      auditEvent,
    },
    config.environment
  );
  if (!updated) return siteNotFound('Check the site id.');

  return {
    site: updated,
    ownerTransfer: auditEvent.metadata,
  };
}
