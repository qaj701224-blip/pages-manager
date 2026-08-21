import { canonicalRequestHash } from '../../crypto.js';
import { bindDeploymentTrace, recordDeploymentStage, withDeploymentTraceHeader } from '../../deployment-trace.js';
import { jsonError, jsonOk } from '../../http.js';
import { rejectUserExposureMutation } from '../shared/site-input.js';
import {
  clearRequestTraceStage,
  discardReplayRequestTrace,
  finishRequestAuthStageFromResponse,
  finishValidatedRequestTrace,
  queueRequestTraceSuccess,
  setRequestTraceStage,
  traceFailureResponse,
} from './deployment-request-trace.js';
import { readRollbackIntake } from './deployment-intake.js';
import {
  bindExistingDeploymentTrace,
  createDeploymentRecordApplication,
  createRollbackSiteApplication,
  normalizeExposureForDeployment,
  readNow,
  reconcileCommittedDeployment,
  recoverFailedDeploymentsForSite,
  updateDeploymentToFailedAndNotify,
} from './deployment-lifecycle-runtime.js';
import { buildDeploymentFailureDiagnostics } from './deployment-diagnostics.js';
import {
  idempotencyConflict,
  rollbackActivationFailurePatch,
  rollbackOfficeNetOperationError,
  rollbackRouteSnapshotRecoveryError,
  rollbackVersionAvailabilityErrorResponse,
} from './deployment-errors.js';
import { deploymentEnvelope } from './deployment-projection.js';
import {
  createRollbackSiteResolutionApplication,
  createRollbackVersionValidationApplication,
} from './deployment-site-resolution.js';
import { recordSkippedDeploymentStages, traceSucceeded } from './deployment-stage-trace.js';
import {
  deploymentStateWriteFailed,
  rollbackSiteResolutionErrorResponse,
} from '../shared/deployment-responses.js';
import { isPublicOfficeNetFailure } from '../shared/public-office-net-application.js';

export async function rollbackVersion(request, env, config, store, actor, versionId, ctx, trace, authStage) {
  setRequestTraceStage(trace, 'intake', 'read_rollback_request');
  const intake = await readRollbackIntake(request);
  if (!intake.ok) return traceFailureResponse(trace, intake.response, intake.traceFailure);
  queueRequestTraceSuccess(trace, 'intake', 'parse_json');
  setRequestTraceStage(trace, 'payload_validation', 'rollback_validate');

  const { body, idempotencyKey } = intake;
  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  setRequestTraceStage(trace, 'auth_and_site_resolution', 'resolve_rollback_site');
  const resolution = await createRollbackSiteResolutionApplication(store).resolve({
    versionId,
    environment: config.environment,
    actor,
    siteId: body.siteId,
    siteSlug: body.siteSlug,
  });
  if (!resolution.ok) {
    const response = rollbackSiteResolutionErrorResponse(resolution.error);
    await finishRequestAuthStageFromResponse(
      authStage,
      response,
      resolution.error.code === 'ROLLBACK_FORBIDDEN' ? 'authorization_error' : 'site_resolution_error'
    );
    return response;
  }
  const { site, version } = resolution;
  await recoverFailedDeploymentsForSite({ store, env, config, ctx, actor, site });

  setRequestTraceStage(trace, 'payload_validation', 'rollback_validate');
  const versionAvailability = await createRollbackVersionValidationApplication(store).validate({
    version,
    environment: config.environment,
  });
  if (!versionAvailability.ok) return rollbackVersionAvailabilityErrorResponse(versionAvailability.error);
  let currentRoute = await store.getRouteBySiteId(site.id, config.environment);
  const requestHash = await canonicalRequestHash({
    operation: 'rollback',
    versionId,
    siteId: body.siteId || null,
    siteSlug: body.siteSlug || null,
  });
  queueRequestTraceSuccess(trace, 'payload_validation', 'rollback_validate');
  setRequestTraceStage(trace, 'deployment_record', 'create_deployment');
  let deploymentResult;
  try {
    deploymentResult = await createDeploymentRecordApplication(store, env).createPending({
      environment: config.environment,
      actor,
      source: 'api',
      siteId: site.id,
      operation: 'rollback',
      idempotencyKey,
      requestHash,
      traceId: trace?.traceId || null,
      visibility: currentRoute.visibility,
      versionId,
      previousVersionId: currentRoute.activeVersionId,
    });
  } catch {
    await finishValidatedRequestTrace(trace, authStage);
    return traceFailureResponse(trace, deploymentStateWriteFailed(), {
      stage: 'deployment_record',
      operation: 'create_deployment',
      errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
      errorMessage: 'Deployment state could not be persisted.',
      diagnostics: { causeClass: 'deployment_store_error' },
    });
  }

  if (deploymentResult.kind === 'conflict') {
    await finishValidatedRequestTrace(trace, authStage);
    return traceFailureResponse(trace, idempotencyConflict(), {
      stage: 'payload_validation',
      operation: 'idempotency_conflict',
      errorCode: 'IDEMPOTENCY_CONFLICT',
      errorMessage: 'Idempotency-Key conflicts with an existing deployment.',
      diagnostics: { causeClass: 'idempotency_conflict' },
    });
  }
  if (deploymentResult.kind === 'existing') {
    const traceBinding = await bindExistingDeploymentTrace(trace, store, deploymentResult.deployment, config.environment);
    const existingDeployment = traceBinding.deployment;
    discardReplayRequestTrace(trace, authStage);
    if (traceBinding.claimFailed) {
      await recordDeploymentStage(trace, {
        stage: 'deployment_record',
        operation: 'claim_deployment_trace',
        status: 'failed',
        errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
        errorMessage: 'Deployment state could not be persisted.',
        diagnostics: { causeClass: 'deployment_store_error' },
      });
    }
    await traceSucceeded(trace, { stage: 'deployment_record', operation: 'idempotency_replay' });
    clearRequestTraceStage(trace);
    const reconciled = await reconcileCommittedDeployment(store, existingDeployment, config.environment, env, trace);
    return withDeploymentTraceHeader(jsonOk(await deploymentEnvelope(store, reconciled, {}, config.environment)), trace.traceId);
  }

  bindDeploymentTrace(trace, { deploymentId: deploymentResult.deployment.id, siteId: site.id });
  await finishValidatedRequestTrace(trace, authStage);
  await traceSucceeded(trace, { stage: 'deployment_record', operation: 'create_deployment' });
  clearRequestTraceStage(trace);
  await recordSkippedDeploymentStages(trace, [
    ['runtime_config', 'rollback_runtime_config_not_applicable'],
    ['provider_upload', 'rollback_provider_upload_not_applicable'],
    ['provider_verify', 'rollback_provider_verify_not_applicable'],
    ['runtime_config_commit', 'rollback_runtime_config_commit_not_applicable'],
    ['version_create', 'rollback_version_create_not_applicable'],
  ]);

  const finalizeFailedRollback = (patch) =>
    updateDeploymentToFailedAndNotify({
      store,
      env,
      config,
      ctx,
      deploymentId: deploymentResult.deployment.id,
      patch,
      actor,
      site,
      trace,
    });

  const rollbackResult = await createRollbackSiteApplication({ store, env, config, site, trace }).execute({
    environment: config.environment,
    site,
    deployment: deploymentResult.deployment,
    version,
    currentRoute,
    exposure: normalizeExposureForDeployment(currentRoute.exposure),
  });
  if (!rollbackResult.ok && rollbackResult.stage === 'prepare' && rollbackResult.error.reason === 'acquire_failed') {
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, rollbackResult.previousRoute, {
        errorCode: 'SITE_POLICY_LOCKED',
        errorMessage: 'Site policy lock could not be acquired.',
        failureStage: 'rollback_policy_lock',
        errorClass: 'site_policy_lock_error',
      })
    );
    return jsonError(
      'SITE_POLICY_LOCKED',
      'Site policy lock could not be acquired.',
      409,
      'Refresh the site status and retry the rollback.'
    );
  }
  if (!rollbackResult.ok && rollbackResult.stage === 'prepare' && rollbackResult.error.reason === 'lease_unavailable') {
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, rollbackResult.previousRoute, {
        errorCode: 'SITE_POLICY_CONFLICT',
        errorMessage: 'Site policy changed while rollback was preparing.',
        failureStage: 'rollback_policy_lock',
        errorClass: 'site_policy_conflict',
        executionProviderFallback: 'wfp',
      })
    );
    return jsonError(
      'SITE_POLICY_CONFLICT',
      'Site policy changed while rollback was preparing.',
      409,
      'Refresh the site status and retry the rollback.'
    );
  }
  if (!rollbackResult.ok && rollbackResult.stage === 'prepare' && rollbackResult.error.reason === 'route_read_failed') {
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, rollbackResult.previousRoute, {
        errorCode: 'ROLLBACK_ACTIVATION_FAILED',
        errorMessage: 'Rollback route state could not be read.',
        failureStage: 'rollback_activate_route',
        errorClass: 'rollback_route_state_read_error',
      })
    );
    return jsonError(
      'ROLLBACK_ACTIVATION_FAILED',
      'Rollback route state could not be read.',
      503,
      'Retry the rollback with a new Idempotency-Key.'
    );
  }
  if (!rollbackResult.ok && rollbackResult.stage === 'prepare') {
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, rollbackResult.previousRoute, {
        errorCode: 'ROUTE_ACTIVATION_CONFLICT',
        errorMessage: 'Route changed while rollback was activating.',
        failureStage: 'rollback_activate_route',
        errorClass: 'route_activation_conflict',
      })
    );
    return jsonError('ROUTE_ACTIVATION_CONFLICT', 'Route changed while rollback was activating.', 409, 'Retry the rollback.');
  }
  if (!rollbackResult.ok && rollbackResult.stage === 'activate' && rollbackResult.error.reason === 'office_net_failed') {
    const error = rollbackOfficeNetOperationError(rollbackResult.error.officeNetError);
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, rollbackResult.previousRoute, {
        errorCode: error.code,
        errorMessage: error.message,
        failureStage: 'rollback_public_office_net',
        errorClass: 'public_office_net_error',
      })
    );
    return jsonError(error.code, error.message, error.status || 503, error.action);
  }
  if (!rollbackResult.ok && rollbackResult.stage === 'activate' && rollbackResult.error.reason === 'activation_error') {
    const error = rollbackResult.error.cause;
    if (isPublicOfficeNetFailure(error)) {
      await finalizeFailedRollback(
        rollbackActivationFailurePatch(version, rollbackResult.previousRoute, {
          errorCode: error.code,
          errorMessage: error.message,
          failureStage: 'rollback_public_office_net',
          errorClass: 'public_office_net_error',
        })
      );
      return jsonError(error.code, error.message, error.status || 503, error.action);
    }
    const code =
      error?.code === 'SITE_POLICY_CONFLICT' || error?.code === 'ROUTE_ACTIVATION_CONFLICT'
        ? error.code
        : 'ROLLBACK_ACTIVATION_FAILED';
    const message = error?.message || 'Rollback activation failed.';
    const status = code === 'ROLLBACK_ACTIVATION_FAILED' ? 503 : 409;
    const action =
      code === 'ROLLBACK_ACTIVATION_FAILED'
        ? 'Retry the rollback with a new Idempotency-Key.'
        : 'Refresh the site status and retry the rollback.';
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, rollbackResult.previousRoute, {
        errorCode: code,
        errorMessage: message,
        failureStage: 'rollback_activate_route',
        errorClass: code === 'SITE_POLICY_CONFLICT' ? 'site_policy_conflict' : 'rollback_activation_error',
      })
    );
    return jsonError(code, message, status, action);
  }
  if (!rollbackResult.ok && rollbackResult.stage === 'activate') {
    if (rollbackResult.error.reason === 'version_unavailable') {
      await finalizeFailedRollback({
        versionId: version.id,
        previousVersionId: rollbackResult.previousRoute.activeVersionId,
        errorCode: 'ROLLBACK_VERSION_UNAVAILABLE',
        errorMessage: 'Version is no longer available for rollback.',
        failureStage: 'rollback_version_availability',
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: 'rollback_version_availability',
          executionProvider: version.executionProvider || 'wfp',
          deploymentShape: version.deploymentShape,
          plannedVersionId: version.id,
          plannedWorkerName: version.workerName,
          routeActivatedInD1: false,
          routePointerCommitted: false,
          cause: { code: 'ROLLBACK_VERSION_UNAVAILABLE', class: 'version_artifact_unavailable' },
        }),
        completedAt: readNow(env),
      });
      return jsonError(
        'ROLLBACK_VERSION_UNAVAILABLE',
        'Version is not available for rollback.',
        409,
        'Deploy a new version because this version artifact is no longer active.'
      );
    }
    await finalizeFailedRollback({
      versionId: version.id,
      previousVersionId: rollbackResult.previousRoute.activeVersionId,
      errorCode: 'ROUTE_ACTIVATION_CONFLICT',
      errorMessage: 'Route changed while rollback was activating.',
      failureStage: 'rollback_activate_route',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'rollback_activate_route',
        executionProvider: version.executionProvider || 'wfp',
        deploymentShape: version.deploymentShape,
        plannedVersionId: version.id,
        plannedWorkerName: version.workerName,
        routeActivatedInD1: false,
        routePointerCommitted: false,
        cause: { code: 'ROUTE_ACTIVATION_CONFLICT', class: 'route_activation_conflict' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      'ROUTE_ACTIVATION_CONFLICT',
      'Route changed while rollback was activating.',
      409,
      'Check the latest site status and retry the rollback with a new Idempotency-Key.'
    );
  }
  if (!rollbackResult.ok && rollbackResult.stage === 'finalize') {
    const recovery = rollbackResult.error.recovery;
    const { restoredRoute, routePointerCleared, repairRequired } = recovery;
    const restoredOfficeNetError = rollbackRouteSnapshotRecoveryError(recovery.failure);
    const failureError = restoredOfficeNetError;
    const failureCode = failureError?.code || 'ROUTE_SNAPSHOT_WRITE_FAILED';
    const failureStage = failureError ? 'rollback_restore_public_office_net' : 'rollback_write_route_snapshot';
    await finalizeFailedRollback({
      versionId: version.id,
      previousVersionId: rollbackResult.previousRoute.activeVersionId,
      errorCode: failureCode,
      errorMessage: failureError?.message || 'Route snapshot write failed.',
      failureStage,
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: failureStage,
        executionProvider: version.executionProvider || 'wfp',
        deploymentShape: version.deploymentShape,
        plannedVersionId: version.id,
        plannedWorkerName: version.workerName,
        routeActivatedInD1: true,
        routePointerCommitted: false,
        routePointerCleared,
        previousRouteRestored: Boolean(restoredRoute),
        trafficImpact: repairRequired ? (routePointerCleared ? 'site_unavailable' : 'public_route_state_unknown') : undefined,
        operatorAction: repairRequired ? 'repair_route_snapshot' : undefined,
        cause: {
          code: failureCode,
          class: failureError ? 'public_office_net_error' : 'route_snapshot_store_error',
        },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      failureCode,
      failureError?.message || 'Route snapshot could not be written.',
      failureError?.status || 503,
      failureError?.action || 'Retry the rollback with a new Idempotency-Key.'
    );
  }

  const { completed, route } = rollbackResult;

  return jsonOk(await deploymentEnvelope(store, completed, { version, route }), 201);
}
