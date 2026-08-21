import { decisionRequiresWorker } from '../../deployment-plan.js';
import { recordDeploymentStage } from '../../deployment-trace.js';
import { jsonError } from '../../http.js';
import { nextId } from '../../id.js';
import { notifyDeploymentCapacityExhausted } from '../../slack-alerts.js';
import { deploymentStateWriteFailed } from '../shared/deployment-responses.js';
import { createSiteCreationApplication, siteCreateErrorResponse } from '../shared/site-creation-application.js';
import {
  buildDeploymentFailureDiagnostics,
  buildProviderFailureDiagnostics,
  deploymentStoreErrorCause,
  providerFailureDisposition,
  publicProviderErrorCode,
  workerNameFor,
} from './deployment-diagnostics.js';
import {
  deploymentOperationFailurePatch,
  initialRuntimeConfigResolutionFailure,
  runtimeConfigFailurePatch,
  runtimeConfigResolutionErrorMessage,
  runtimeConfigSnapshotFailure,
  runtimeConfigUnavailable,
} from './deployment-errors.js';
import {
  createUploadedWorkerCompensationApplication,
  normalizeExposureForDeployment,
  readNow,
  recordDeploymentStatePersistFailure,
  updateDeploymentToFailedAndNotify,
} from './deployment-lifecycle-runtime.js';
import {
  createDeploymentRuntimeConfigCommitApplication,
  createDeploymentRuntimeConfigResolutionApplication,
  validateDeploymentRuntimeConfigSnapshot,
} from './deployment-runtime-config.js';
import { createDeploymentProviderApplication } from './deployment-route-runtime.js';

export async function prepareDeploymentUpload({
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
}) {
  const result = await (async () => {
    let runtimeVars = {};
    let runtimeVarRecords = [];
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
            cause: deploymentStoreErrorCause(),
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
            cause: deploymentStoreErrorCause(),
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
    return {
      kind: 'prepared',
      site,
      runtimeVars,
      runtimeVarRecords,
      originalRuntimeVarRecords,
      runtimeSecrets,
      versionId,
      plannedWorkerName,
      provider,
      uploaded,
      workerName,
      committedRuntimeVarRecords,
      uploadExposure,
    };
  })();
  if (result?.kind === 'prepared') return { ok: true, ...result };
  return { ok: false, response: result };
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
