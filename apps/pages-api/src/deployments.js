import { canonicalRequestHash } from './crypto.js';
import { runtimeConfigHashInput } from './deployment-runtime-config.js';
import { canonicalDeploymentContentHash, decisionRequiresAssets, decisionRequiresWorker } from './deployment-plan.js';
import {
  bindDeploymentTrace,
  recordDeploymentStage,
  withDeploymentTraceHeader,
} from './deployment-trace.js';
import { validateAssetFiles } from './deployment-upload.js';
import { isSiteVisibility } from './domain/sites/access-policy.js';
import { actorCanDeploySite, actorCanReadSite } from './domain/sites/authorization.js';
import { jsonError, jsonOk } from './http.js';
import { nextId } from './id.js';
import { normalizeWorkerBundle } from './execution-provider.js';
import { notifyDeploymentCapacityExhausted } from './slack-alerts.js';
import { buildSiteOwnerTransferAuditEvent } from './application/sites/build-owner-transfer-audit-event.js';
import { rejectUserExposureMutation } from './transport/shared/site-input.js';
import {
  createSiteCreationApplication,
  siteCreateErrorResponse,
} from './transport/shared/site-creation-application.js';
import {
  clearRequestTraceStage,
  discardReplayRequestTrace,
  ensureRequestFailureTraced,
  finishRequestAuthStage,
  finishRequestAuthStageFromResponse,
  finishValidatedRequestTrace,
  queueRequestTraceSuccess,
  setRequestTraceStage,
  traceFailureResponse,
  withRequestTraceHeader,
} from './transport/public/deployment-request-trace.js';
import { createDeploymentsHttpHandlers } from './transport/public/deployments-handler.js';
import {
  readDeploymentIntakeHeaders,
  readDeploymentMultipart,
  readRollbackIntake,
} from './transport/public/deployment-intake.js';
import {
  bindExistingDeploymentTrace,
  createDeploymentActivationFailureRecoveryApplication,
  createDeploymentRecordApplication,
  createDeploymentRouteSnapshotRecoveryApplication,
  createRollbackSiteApplication,
  createSuccessfulDeploymentFinalizationApplication,
  createUploadedWorkerCompensationApplication,
  normalizeExposureForDeployment,
  persistIntermediateDeploymentState,
  readNow,
  reconcileCommittedDeployment,
  recordDeploymentStatePersistFailure,
  recoverFailedDeploymentsForSite,
  recoverUnexpectedRequestFailure,
  updateDeploymentToFailedAndNotify,
} from './transport/public/deployment-lifecycle-runtime.js';
import {
  buildDeploymentFailureDiagnostics,
  buildProviderFailureDiagnostics,
  deploymentStoreErrorCause,
  providerFailureDisposition,
  publicProviderErrorCode,
  workerNameFor,
} from './transport/public/deployment-diagnostics.js';
import {
  deploymentOperationError,
  deploymentOperationFailurePatch,
  idempotencyConflict,
  initialRuntimeConfigResolutionFailure,
  rollbackActivationFailurePatch,
  rollbackOfficeNetOperationError,
  rollbackRouteSnapshotRecoveryError,
  rollbackVersionAvailabilityErrorResponse,
  runtimeConfigFailurePatch,
  runtimeConfigResolutionErrorMessage,
  runtimeConfigSnapshotFailure,
  runtimeConfigUnavailable,
  siteNotFound,
} from './transport/public/deployment-errors.js';
import {
  createDeploymentRuntimeConfigCommitApplication,
  createDeploymentRuntimeConfigResolutionApplication,
  validateDeploymentRuntimeConfigSnapshot,
} from './transport/public/deployment-runtime-config.js';
import {
  createDeploymentCommitLeaseApplication,
  createDeploymentProviderApplication,
  createDeploymentRouteActivationPreparationApplication,
  createDeploymentRouteCutoverApplication,
  createDeploymentRouteSnapshotCommitApplication,
  createDeploymentVersionCreationApplication,
} from './transport/public/deployment-route-runtime.js';
import {
  createDeploySiteResolutionApplication,
  createRollbackSiteResolutionApplication,
  createRollbackVersionValidationApplication,
  normalizeOptionalSlug,
  normalizeOptionalString,
  validateDeployableSiteSlug,
  validateDeploySiteSlug,
} from './transport/public/deployment-site-resolution.js';
import { deploymentEnvelope } from './transport/public/deployment-projection.js';
import {
  deploySiteResolutionErrorResponse,
  deploymentRequestFailed,
  deploymentStateWriteFailed,
  rollbackSiteResolutionErrorResponse,
} from './transport/shared/deployment-responses.js';
import {
  isPublicOfficeNetFailure,
  publicOfficeNetOperationError,
} from './transport/shared/public-office-net-application.js';

const deploymentHttpHandlers = createDeploymentsHttpHandlers({
  deploy: createDeployment,
  readDeployment: getDeployment,
  rollback: rollbackVersion,
  requestLifecycle: {
    ensureFailureTraced: ensureRequestFailureTraced,
    finishAuthStage: finishRequestAuthStage,
    queueTraceSuccess: queueRequestTraceSuccess,
    recoverUnexpected: recoverUnexpectedRequestFailure,
    unexpectedResponse: unexpectedRequestResponse,
    withTraceHeader: withRequestTraceHeader,
  },
});

export function handleDeploymentsApi(request, env, config, store, ctx) {
  return deploymentHttpHandlers.handleDeploymentsApi(request, env, config, store, ctx);
}

export function handleVersionsApi(request, env, config, store, ctx) {
  return deploymentHttpHandlers.handleVersionsApi(request, env, config, store, ctx);
}

async function createDeployment(request, env, config, store, actor, ctx, trace, authStage) {
  setRequestTraceStage(trace, 'intake', 'read_deployment_request');
  const headers = readDeploymentIntakeHeaders(request);
  if (!headers.ok) return traceFailureResponse(trace, headers.response, headers.traceFailure);

  setRequestTraceStage(trace, 'intake', 'parse_multipart');
  const multipart = await readDeploymentMultipart(request);
  if (!multipart.ok) {
    return multipart.traceFailure
      ? traceFailureResponse(trace, multipart.response, multipart.traceFailure)
      : multipart.response;
  }
  queueRequestTraceSuccess(trace, 'intake', 'parse_multipart');
  setRequestTraceStage(trace, 'payload_validation', 'validate_deployment_payload');

  const { idempotencyKey } = headers;
  const { body } = multipart;
  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  const requestedSiteId = normalizeOptionalString(body.siteId);
  const requestedSiteSlug = normalizeOptionalSlug(body.siteSlug ?? body.slug);
  const requestedTeamId = normalizeOptionalString(body.teamId);
  const requestedVisibility = normalizeOptionalString(body.visibility);
  const clientContentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  const source = typeof body.source === 'string' ? body.source : 'api';
  const decision = body.decision;
  const workerRuntimeVarsProvided = decisionRequiresWorker(decision) && body.varsProvided;
  const requestedRuntimeVars = workerRuntimeVarsProvided ? body.vars : undefined;
  let runtimeVars = {};
  let runtimeVarRecords = [];
  let artifactBundle;
  let assetManifest;
  let assetFiles;
  let canonicalContentHash;

  if (!requestedSiteId && !requestedSiteSlug) {
    return jsonError('SITE_REQUIRED', 'Site is required.', 400, 'Pass siteId or siteSlug.');
  }
  if (requestedSiteSlug) {
    const slugError = validateDeploySiteSlug(requestedSiteSlug, config.environment, { allowReserved: true });
    if (slugError) return slugError;
  }
  if (requestedVisibility && !isSiteVisibility(requestedVisibility)) {
    return jsonError(
      'SITE_VISIBILITY_INVALID',
      'Site visibility is invalid.',
      400,
      'Use internal, org, acl, owner, or disabled.'
    );
  }
  if (!clientContentHash.startsWith('sha256:')) {
    return jsonError('CONTENT_HASH_INVALID', 'Content hash is invalid.', 400, 'Pass a sha256 content hash.');
  }
  if (decisionRequiresWorker(decision)) {
    try {
      artifactBundle = normalizeWorkerBundle(body.artifactBundle);
    } catch {
      return jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.');
    }
  }
  if (decisionRequiresAssets(decision)) {
    assetManifest = body.assetManifest;
    assetFiles = body.assetFiles;
    if (!assetManifest || typeof assetManifest !== 'object' || Array.isArray(assetManifest)) {
      return jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.');
    }
    if (!Array.isArray(assetFiles) || assetFiles.length === 0) {
      return jsonError('ASSET_FILES_REQUIRED', 'Asset files are required.', 400, 'Upload at least one asset file.');
    }
    const assetFileError = validateAssetFiles(assetManifest, assetFiles);
    if (assetFileError === 'ASSET_MANIFEST_INVALID') {
      return jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Send a valid assetManifest field.');
    }
    if (assetFileError === 'ASSET_FILES_REQUIRED') {
      return jsonError('ASSET_FILES_REQUIRED', 'Asset files are required.', 400, 'Upload every file listed in assetManifest.');
    }
  }
  try {
    canonicalContentHash = await canonicalDeploymentContentHash({ decision, assetManifest, assetFiles, artifactBundle });
  } catch (error) {
    if (error?.code === 'ASSET_MANIFEST_INVALID') {
      return jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.');
    }
    if (error?.code === 'PUBLISH_PLAN_INVALID') {
      return jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.');
    }
    throw error;
  }
  if (clientContentHash !== canonicalContentHash) {
    return traceFailureResponse(
      trace,
      jsonError(
        'CONTENT_HASH_MISMATCH',
        'Content hash does not match uploaded files.',
        400,
        'Run xd-cell deploy --dry-run and retry.'
      ),
      {
        stage: 'payload_validation',
        operation: 'validate_content_hash',
        errorCode: 'CONTENT_HASH_MISMATCH',
        errorMessage: 'Content hash does not match uploaded files.',
        diagnostics: { causeClass: 'payload_validation_error' },
      }
    );
  }
  queueRequestTraceSuccess(trace, 'payload_validation', 'validate_deployment_payload');
  setRequestTraceStage(trace, 'auth_and_site_resolution', 'resolve_site');
  const resolution = await createDeploySiteResolutionApplication({ store, env, config }).resolve({
    actor,
    environment: config.environment,
    siteId: requestedSiteId,
    siteSlug: requestedSiteSlug,
    teamId: requestedTeamId,
    visibility: requestedVisibility || 'org',
    requestedVisibility,
  });
  if (!resolution.ok) {
    const response = deploySiteResolutionErrorResponse(resolution.error);
    await finishRequestAuthStageFromResponse(authStage, response, 'site_resolution_error');
    return response;
  }
  let site = resolution.site;
  let ownerTransfer = null;
  const routeSlugError = validateDeployableSiteSlug(site.slug, config.environment);
  if (routeSlugError) {
    await finishRequestAuthStageFromResponse(authStage, routeSlugError, 'site_resolution_error');
    return routeSlugError;
  }
  const siteId = site.id;
  if (!actorCanDeploySite(actor, site, 'deploy:site')) {
    const response = jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use a token scoped to this site.');
    await finishRequestAuthStageFromResponse(authStage, response, 'authorization_error');
    return response;
  }
  await recoverFailedDeploymentsForSite({ store, env, config, ctx, actor, site });
  setRequestTraceStage(trace, 'runtime_config', 'build_request_hash');
  let requestHash;
  try {
    requestHash = await canonicalRequestHash({
      operation: 'deploy',
      siteId,
      decision,
      contentHash: canonicalContentHash,
      artifactBundle,
      assetManifest,
      source,
      teamId: requestedTeamId || null,
      visibility: requestedVisibility || null,
      vars: workerRuntimeVarsProvided ? await runtimeConfigHashInput(env, requestedRuntimeVars, []) : undefined,
    });
  } catch {
    return jsonError(
      'RUNTIME_CONFIG_UNSUPPORTED',
      'Runtime configuration is unavailable.',
      503,
      'Check runtime configuration and retry with a new Idempotency-Key.'
    );
  }
  setRequestTraceStage(trace, 'deployment_record', 'create_deployment');
  let deploymentResult;
  try {
    deploymentResult = await createDeploymentRecordApplication(store, env).createPending({
      environment: config.environment,
      actor,
      source,
      siteId,
      operation: 'deploy',
      idempotencyKey,
      requestHash,
      traceId: trace?.traceId || null,
      visibility: site.pendingOwnerTransfer?.visibility || site.defaultVisibility,
      previousVersionId: site.route?.activeVersionId || null,
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

  const deployment = deploymentResult.deployment;
  bindDeploymentTrace(trace, { deploymentId: deployment.id, siteId });
  await finishValidatedRequestTrace(trace, authStage);
  await traceSucceeded(trace, { stage: 'deployment_record', operation: 'create_deployment' });
  clearRequestTraceStage(trace);
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
  if (site.pendingSiteCreation) {
    const creationResult = await applyPendingDeploySiteCreation(env, config, store, actor, site);
    if (creationResult instanceof Response) {
      await finalizeFailedDeployment(
        deploymentOperationFailurePatch({
          errorCode: 'SITE_CREATE_FAILED',
          errorMessage: 'Site creation failed.',
        })
      );
      return creationResult;
    }
    site = creationResult.site;
  }

  let runtimeSecrets = [];
  let originalRuntimeVarRecords = [];
  const runtimeConfigResult = await createDeploymentRuntimeConfigResolutionApplication(store, env, trace).resolve({
    environment: config.environment,
    siteId,
    workerRequired: decisionRequiresWorker(decision),
    varsProvided: workerRuntimeVarsProvided,
    requestedVars: requestedRuntimeVars,
  });
  if (!runtimeConfigResult.ok) {
    const errorCode = runtimeConfigResult.error.code;
    const errorMessage = runtimeConfigResolutionErrorMessage(errorCode);
    await finalizeFailedDeployment(runtimeConfigFailurePatch({ errorCode, errorMessage }));
    return initialRuntimeConfigResolutionFailure(runtimeConfigResult.error);
  }
  runtimeVars = runtimeConfigResult.runtimeVars;
  runtimeVarRecords = runtimeConfigResult.runtimeVarRecords;
  originalRuntimeVarRecords = runtimeConfigResult.originalRuntimeVarRecords;
  runtimeSecrets = runtimeConfigResult.runtimeSecrets;
  const runtimeBindings = runtimeConfigResult.runtimeBindings;
  const versionId = nextId(env, 'ver');
  const plannedWorkerName = workerNameFor(site, versionId, config.environment);
  const providerApplication = createDeploymentProviderApplication({ env, config, store, trace });
  const providerResult = providerApplication.prepare({ site });
  if (!providerResult.ok) {
    await recordDeploymentStage(trace, {
      stage: 'provider_upload',
      operation: 'create_deployment_provider',
      status: 'failed',
      errorCode: 'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
      errorMessage: 'Deployment platform configuration is invalid.',
      diagnostics: { causeClass: 'provider_config_error' },
    });
    await finalizeFailedDeployment({
      errorCode: 'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
      errorMessage: 'Deployment platform configuration is invalid.',
      failureStage: 'provider_config',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'provider_config',
        executionProvider: 'unknown',
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName,
        cause: { code: 'DEPLOYMENT_PLATFORM_CONFIG_INVALID', class: 'provider_config_error' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
      'Deployment platform configuration is invalid.',
      500,
      'Check the Pages deployment platform configuration and retry with a new Idempotency-Key.'
    );
  }
  const provider = providerResult.provider;

  try {
    await store.updateDeployment(deployment.id, { status: 'uploading' });
  } catch (error) {
    await recordDeploymentStatePersistFailure({
      trace,
      env,
      deploymentId: deployment.id,
      operation: 'persist_uploading_deployment',
      cause: error,
    });
    await finalizeFailedDeployment(
      {
        errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
        errorMessage: 'Deployment state could not be persisted.',
        failureStage: 'persist_deployment_state',
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: 'persist_deployment_state',
          executionProvider: 'unknown',
          plannedVersionId: null,
          routePointerCommitted: false,
          cause: deploymentStoreErrorCause(error),
        }),
        completedAt: readNow(env),
      }
    );
    return deploymentStateWriteFailed();
  }
  const runtimeSnapshotError = decisionRequiresWorker(decision)
    ? await validateDeploymentRuntimeConfigSnapshot(store, {
        environment: config.environment,
        siteId,
        expectedVars: workerRuntimeVarsProvided ? originalRuntimeVarRecords : runtimeVarRecords,
        expectedSecrets: runtimeSecrets,
      })
    : null;
  if (runtimeSnapshotError) {
    await recordDeploymentStage(trace, {
      stage: 'runtime_config',
      operation: 'validate_runtime_snapshot_before_upload',
      status: 'failed',
      errorCode: runtimeSnapshotError.code,
      errorMessage: runtimeSnapshotError.message,
      diagnostics: { causeClass: 'runtime_config_changed' },
    });
    await finalizeFailedDeployment({
      errorCode: runtimeSnapshotError.code,
      errorMessage: runtimeSnapshotError.message,
      failureStage: 'runtime_config_snapshot',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'runtime_config_snapshot',
        executionProvider: provider.executionProvider || 'wfp',
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName,
        uploadCompleted: false,
        verifyCompleted: false,
        routePointerCommitted: false,
        cause: { code: runtimeSnapshotError.code, class: 'runtime_config_changed' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      runtimeSnapshotError.code,
      runtimeSnapshotError.message,
      runtimeSnapshotError.status,
      runtimeSnapshotError.action
    );
  }
  const uploadExposure = normalizeExposureForDeployment(site.route?.exposure || site.defaultExposure);
  const providerUploadResult = await providerApplication.upload({
    provider,
    site,
    exposure: uploadExposure,
    workerName: plannedWorkerName,
    versionId,
    decision,
    contentHash: canonicalContentHash,
    artifactBundle,
    assetManifest,
    assetFiles,
    runtimeBindings,
  });
  const uploaded = providerUploadResult.ok ? providerUploadResult.uploaded : null;
  if (!providerUploadResult.ok) {
    const error = providerUploadResult.error?.cause;
    const code = publicProviderErrorCode(error, 'upload');
    const executionProvider = provider.executionProvider || 'wfp';
    const providerDiagnostics = buildProviderFailureDiagnostics(error, executionProvider);
    const disposition = providerFailureDisposition(error, 'upload', providerDiagnostics);
    await finalizeFailedDeployment({
      errorCode: code,
      errorMessage: 'Deployment upload failed.',
      failureStage: 'upload_worker',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'upload_worker',
        executionProvider,
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName,
        uploadCompleted: false,
        verifyCompleted: false,
        routePointerCommitted: false,
        retryable: disposition.retryable,
        operatorAction: disposition.operatorAction,
        cause: { code, class: 'provider_upload_error' },
        provider: providerDiagnostics,
      }),
      completedAt: readNow(env),
    });
    const status = code === 'DEPLOYMENT_CAPACITY_EXHAUSTED' ? 503 : disposition.responseStatus;
    const action =
      code === 'DEPLOYMENT_CAPACITY_EXHAUSTED'
        ? 'Ask a Pages maintainer to expand platform deployment capacity.'
        : disposition.responseAction;
    if (code === 'DEPLOYMENT_CAPACITY_EXHAUSTED') {
      await notifyDeploymentCapacityExhausted(env, config, { store });
    }
    return jsonError(code, disposition.responseMessage, status, action);
  }

  const workerName = uploaded.workerName || plannedWorkerName;
  const postUploadRuntimeSnapshotError = decisionRequiresWorker(decision)
    ? await validateDeploymentRuntimeConfigSnapshot(store, {
        environment: config.environment,
        siteId,
        expectedVars: workerRuntimeVarsProvided ? originalRuntimeVarRecords : runtimeVarRecords,
        expectedSecrets: runtimeSecrets,
      })
    : null;
  if (postUploadRuntimeSnapshotError) {
    await recordDeploymentStage(trace, {
      stage: 'runtime_config',
      operation: 'validate_runtime_snapshot_after_upload',
      status: 'failed',
      errorCode: postUploadRuntimeSnapshotError.code,
      errorMessage: postUploadRuntimeSnapshotError.message,
      diagnostics: { causeClass: 'runtime_config_changed' },
    });
    await createUploadedWorkerCompensationApplication({ store, provider, trace }).cleanup({
      uploaded,
      originalFailure: { stage: 'runtime_config', code: postUploadRuntimeSnapshotError.code },
      trafficImpact: 'old_version_retained',
    });
    await finalizeFailedDeployment({
      errorCode: postUploadRuntimeSnapshotError.code,
      errorMessage: postUploadRuntimeSnapshotError.message,
      failureStage: 'runtime_config_post_upload',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'runtime_config_post_upload',
        executionProvider: uploaded.executionProvider || provider.executionProvider || 'wfp',
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName: workerName,
        uploadCompleted: true,
        verifyCompleted: false,
        routePointerCommitted: false,
        uploadedWorkerCleanup: 'attempted',
        cause: { code: postUploadRuntimeSnapshotError.code, class: 'runtime_config_changed' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      postUploadRuntimeSnapshotError.code,
      postUploadRuntimeSnapshotError.message,
      postUploadRuntimeSnapshotError.status,
      postUploadRuntimeSnapshotError.action
    );
  }
  try {
    await store.updateDeployment(deployment.id, { status: 'uploaded' });
  } catch (error) {
    await recordDeploymentStatePersistFailure({
      trace,
      env,
      deploymentId: deployment.id,
      operation: 'persist_uploaded_deployment',
      cause: error,
    });
    await createUploadedWorkerCompensationApplication({ store, provider, trace }).cleanup({
      uploaded,
      originalFailure: { stage: 'deployment_state_persist', code: 'DEPLOYMENT_STATE_WRITE_FAILED' },
      trafficImpact: 'old_version_retained',
    });
    await finalizeFailedDeployment(
      {
        errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
        errorMessage: 'Deployment state could not be persisted.',
        failureStage: 'persist_deployment_state',
        failureDiagnostics: buildDeploymentFailureDiagnostics({
          stage: 'persist_deployment_state',
          executionProvider: 'unknown',
          plannedVersionId: versionId,
          routePointerCommitted: false,
          cause: deploymentStoreErrorCause(error),
        }),
        completedAt: readNow(env),
      }
    );
    return deploymentStateWriteFailed();
  }
  const providerVerifyResult = await providerApplication.verify({
    provider,
    site,
    workerName,
    versionId,
    artifactRef: uploaded.artifactRef,
    ...uploaded,
  });
  if (!providerVerifyResult.ok) {
    const error = providerVerifyResult.error?.cause;
    const code = publicProviderErrorCode(null, 'verify');
    const executionProvider = uploaded.executionProvider || provider.executionProvider || 'wfp';
    const disposition = providerFailureDisposition(error, 'verify');
    await createUploadedWorkerCompensationApplication({ store, provider, trace }).cleanup({
      uploaded,
      originalFailure: { stage: 'provider_verify', code },
      trafficImpact: 'old_version_retained',
    });
    await finalizeFailedDeployment({
      errorCode: code,
      errorMessage: 'Deployment verification failed.',
      failureStage: 'verify_worker',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'verify_worker',
        executionProvider,
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName: workerName,
        uploadCompleted: true,
        verifyCompleted: false,
        routePointerCommitted: false,
        uploadedWorkerCleanup: 'attempted',
        retryable: disposition.retryable,
        operatorAction: disposition.operatorAction,
        cause: { code, class: 'provider_verify_error' },
        provider: buildProviderFailureDiagnostics(error, executionProvider),
      }),
      completedAt: readNow(env),
    });
    return jsonError(code, disposition.responseMessage, disposition.responseStatus, disposition.responseAction);
  }

  const runtimeConfigCommitResult = await createDeploymentRuntimeConfigCommitApplication(store, env, trace).commit({
    environment: config.environment,
    siteId,
    actorId: actor.userId,
    enabled: workerRuntimeVarsProvided,
    requestedVars: requestedRuntimeVars,
    expectedVars: originalRuntimeVarRecords,
    expectedSecrets: runtimeSecrets,
  });
  if (!runtimeConfigCommitResult.ok && runtimeConfigCommitResult.error.reason === 'snapshot_validation_failed') {
    const preCommitRuntimeSnapshotError = runtimeConfigSnapshotFailure(runtimeConfigCommitResult.error);
    await createUploadedWorkerCompensationApplication({ store, provider, trace }).cleanup({
      uploaded,
      originalFailure: { stage: 'runtime_config_commit', code: preCommitRuntimeSnapshotError.code },
      trafficImpact: 'old_version_retained',
    });
    await finalizeFailedDeployment({
      errorCode: preCommitRuntimeSnapshotError.code,
      errorMessage: preCommitRuntimeSnapshotError.message,
      failureStage: 'runtime_config_precommit',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'runtime_config_precommit',
        executionProvider: uploaded.executionProvider || provider.executionProvider || 'wfp',
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName: workerName,
        uploadCompleted: true,
        verifyCompleted: true,
        routePointerCommitted: false,
        uploadedWorkerCleanup: 'attempted',
        cause: { code: preCommitRuntimeSnapshotError.code, class: 'runtime_config_changed' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      preCommitRuntimeSnapshotError.code,
      preCommitRuntimeSnapshotError.message,
      preCommitRuntimeSnapshotError.status,
      preCommitRuntimeSnapshotError.action
    );
  }
  if (!runtimeConfigCommitResult.ok) {
    await createUploadedWorkerCompensationApplication({ store, provider, trace }).cleanup({
      uploaded,
      originalFailure: { stage: 'runtime_config_commit', code: 'RUNTIME_CONFIG_UNSUPPORTED' },
      trafficImpact: 'old_version_retained',
    });
    await finalizeFailedDeployment(runtimeConfigFailurePatch());
    return runtimeConfigUnavailable();
  }
  if (runtimeConfigCommitResult.kind === 'committed') {
    runtimeVarRecords = runtimeConfigCommitResult.runtimeVarRecords;
    runtimeVars = runtimeConfigCommitResult.runtimeVars;
  }
  const committedRuntimeVarRecords = runtimeVarRecords;

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
          cause: deploymentStoreErrorCause(error),
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

async function getDeployment(store, actor, deploymentId, environment, env) {
  let deployment = await store.getDeployment(deploymentId, environment);
  if (!deployment) return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  const site = await store.getSiteForUser(deployment.siteId, actor.userId, actor, environment);
  if (!site && actor.type === 'access_key' && typeof store.getSite === 'function') {
    const rawSite = await store.getSite(deployment.siteId);
    const rawSiteMatchesEnvironment = !environment || rawSite?.environment === environment;
    if (rawSite && !rawSite.deletedAt && rawSiteMatchesEnvironment && !actorCanReadSite(actor, rawSite)) {
      return deploymentReadForbidden();
    }
  }
  if (!site) return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  if (!actorCanReadSite(actor, site)) {
    return deploymentReadForbidden();
  }
  deployment = await reconcileCommittedDeployment(store, deployment, environment, env);
  return jsonOk(await deploymentEnvelope(store, deployment, {}, environment));
}

function deploymentReadForbidden() {
  return jsonError('DEPLOYMENT_READ_FORBIDDEN', 'Actor cannot read this deployment.', 403, 'Use a token with read:site scope.');
}

async function rollbackVersion(request, env, config, store, actor, versionId, ctx, trace, authStage) {
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

async function applyPendingDeploySiteCreation(env, config, store, actor, site) {
  try {
    const created = await createSiteCreationApplication({ store, env, config }).commit({
      actor,
      siteInput: site.pendingSiteCreation,
      allowLegacyV1Takeover: true,
    });
    return {
      site: {
        ...created,
        hostname: site.pendingSiteCreation.hostname,
        managementRole: site.managementRole || null,
      },
    };
  } catch (error) {
    const response = siteCreateErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function traceSucceeded(trace, { stage, operation, diagnostics }) {
  if (!trace) return null;
  return recordDeploymentStage(trace, {
    stage,
    operation,
    status: 'succeeded',
    diagnostics,
  });
}

async function recordSkippedDeploymentStages(trace, stages) {
  if (!trace) return;
  for (const [stage, operation] of stages) {
    await recordDeploymentStage(trace, {
      stage,
      operation,
      status: 'skipped',
    });
  }
}

async function unexpectedRequestResponse(store, deployment, environment) {
  if (deployment?.status === 'succeeded') {
    try {
      return jsonOk(await deploymentEnvelope(store, deployment, {}, environment), 201);
    } catch {
      // Fall back to a status-first action when the committed envelope cannot be reconstructed.
    }
  }
  return deploymentRequestFailed();
}
