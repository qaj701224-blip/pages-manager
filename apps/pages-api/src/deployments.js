import { validateSiteSlug } from '@xd/pages-runtime-protocol';

import { isManagedWfpWorkerName } from './admin-resource-governance.js';
import { authenticateApiRequest } from './auth.js';
import { canonicalRequestHash } from './crypto.js';
import {
  assertRuntimeConfigSnapshotUnchanged,
  restoreSiteVarsAfterFailedDeployment,
  runtimeConfigHashInput,
  runtimeSecretSnapshotRecords,
  runtimeVarsFromRecords,
  siteVarRecordsFromObject,
} from './deployment-runtime-config.js';
import { canonicalDeploymentContentHash, decisionRequiresAssets, decisionRequiresWorker } from './deployment-plan.js';
import {
  attachDeploymentTraceStore,
  bindDeploymentTrace,
  createDeploymentTraceContext,
  finishDeploymentStage,
  providerDiagnosticsFromError,
  recordDeploymentStage,
  startDeploymentStage,
  withDeploymentTraceHeader,
} from './deployment-trace.js';
import { isMultipartRequest, readMultipartDeploymentBody, validateAssetFiles } from './deployment-upload.js';
import { isSiteVisibility } from './domain/sites/access-policy.js';
import { jsonError, jsonOk } from './http.js';
import { newHexId, nextId } from './id.js';
import {
  buildRouteSnapshot,
  clearRoutePointerIfCurrent,
  deleteDeploymentFailureRecoveryRecord,
  listDeploymentFailureRecoveryRecords,
  routeSnapshotKey,
  writeDeploymentFailureRecoveryRecord,
  writeRouteSnapshot,
} from './route-snapshot.js';
import { createDeploymentProvider, normalizeWorkerBundle } from './execution-provider.js';
import { runtimeConfigSnapshot, validateRuntimeBindingQuotas } from './runtime-config.js';
import { notifyDeploymentCapacityExhausted } from './slack-alerts.js';
import {
  actorCanManageSite,
  buildSiteOwnerTransferAuditEvent,
  hostnameForSlug,
  rejectUserExposureMutation,
  siteCreateErrorResponse,
} from './sites.js';
import { deliverWebhookEventToSubscriptions } from './webhooks.js';
import { emitSiteDisabledWebhook, emitSiteFailedWebhook } from './lifecycle-webhooks.js';
import { createSiteWithLegacyV1Takeover } from './legacy-v1/takeover.js';

const encoder = new globalThis.TextEncoder();
const PROVIDER_DIAGNOSTIC_CLIENT_CODES = new Set(['WFP_API_ERROR', 'WFP_API_INVALID_JSON', 'WFP_NETWORK_ERROR']);
const PROVIDER_DIAGNOSTIC_OPERATIONS = new Set(['assets_upload_session', 'assets_upload', 'worker_put', 'worker_get']);
const TERMINAL_DEPLOYMENT_STATUSES = new Set(['succeeded', 'failed']);
const DEPLOYMENT_FAILURE_RECOVERY_KEY_PART = 'deployment_failure_recovery';
const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Cell 平台保留项，请换一个业务站点名。';
const deploymentRequestTraceStates = new WeakMap();

export async function handleDeploymentsApi(request, env, config, store, ctx) {
  const url = new URL(request.url);
  const trace =
    url.pathname === '/.xd-pages/api/deployments' && request.method === 'POST'
      ? createDeploymentTraceContext(request, env, {
          environment: config.environment,
          operation: 'deploy',
          deferPersistence: true,
          now: env?.now,
        })
      : null;
  if (trace) queueRequestTraceSuccess(trace, 'intake', 'accept_request');
  const authStage = trace
    ? startDeploymentStage(trace, { stage: 'auth_and_site_resolution', operation: 'authenticate_request' })
    : null;
  let auth;
  try {
    auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  } catch (error) {
    if (!trace) throw error;
    await finishRequestAuthStage(authStage, {
      status: 'failed',
      errorCode: 'DEPLOYMENT_REQUEST_FAILED',
      errorMessage: 'Deployment request could not be processed.',
      diagnostics: { causeClass: 'authentication_error' },
    });
    return withRequestTraceHeader(deploymentRequestFailed(), trace);
  }
  if (!auth.ok) {
    await finishRequestAuthStage(authStage, {
      status: 'failed',
      errorCode: auth.error.code,
      errorMessage: auth.error.message,
      diagnostics: { causeClass: 'authentication_error' },
    });
    return withRequestTraceHeader(authErrorResponse(auth.error), trace);
  }
  if (trace) attachDeploymentTraceStore(trace, store);

  if (url.pathname === '/.xd-pages/api/deployments') {
    if (request.method === 'POST') {
      let response;
      try {
        response = await createDeployment(request, env, config, store, auth.actor, ctx, trace, authStage);
      } catch (error) {
        if (error?.code === 'DEPLOYMENT_STATE_WRITE_FAILED') response = deploymentStateWriteFailed();
        else {
          await finishRequestAuthStage(authStage, { status: 'succeeded' });
          const recoveredDeployment = await recoverUnexpectedRequestFailure({
            trace,
            store,
            env,
            config,
            ctx,
            actor: auth.actor,
            fallbackOperation: 'orchestrate_deployment_request',
          });
          response = await unexpectedRequestResponse(store, recoveredDeployment, config.environment);
        }
      }
      await finishRequestAuthStage(authStage, { status: 'succeeded' });
      response = await ensureRequestFailureTraced(trace, response);
      return withRequestTraceHeader(response, trace);
    }
    return methodNotAllowed();
  }

  const deploymentId = matchDeploymentId(url.pathname);
  if (deploymentId && request.method === 'GET') return getDeployment(store, auth.actor, deploymentId, config.environment, env);
  if (deploymentId) return methodNotAllowed();

  return null;
}

export async function handleVersionsApi(request, env, config, store, ctx) {
  const url = new URL(request.url);
  const versionId = matchRollbackVersionId(url.pathname);
  const trace =
    versionId && request.method === 'POST'
      ? createDeploymentTraceContext(request, env, {
          environment: config.environment,
          operation: 'rollback',
          deferPersistence: true,
          now: env?.now,
        })
      : null;
  if (trace) queueRequestTraceSuccess(trace, 'intake', 'accept_request');
  const authStage = trace
    ? startDeploymentStage(trace, { stage: 'auth_and_site_resolution', operation: 'authenticate_request' })
    : null;
  let auth;
  try {
    auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  } catch (error) {
    if (!trace) throw error;
    await finishRequestAuthStage(authStage, {
      status: 'failed',
      errorCode: 'DEPLOYMENT_REQUEST_FAILED',
      errorMessage: 'Deployment request could not be processed.',
      diagnostics: { causeClass: 'authentication_error' },
    });
    return withRequestTraceHeader(deploymentRequestFailed(), trace);
  }
  if (!auth.ok) {
    await finishRequestAuthStage(authStage, {
      status: 'failed',
      errorCode: auth.error.code,
      errorMessage: auth.error.message,
      diagnostics: { causeClass: 'authentication_error' },
    });
    return withRequestTraceHeader(authErrorResponse(auth.error), trace);
  }
  if (trace) attachDeploymentTraceStore(trace, store);

  if (versionId && request.method === 'POST') {
    let response;
    try {
      response = await rollbackVersion(request, env, config, store, auth.actor, versionId, ctx, trace, authStage);
    } catch (error) {
      if (error?.code === 'DEPLOYMENT_STATE_WRITE_FAILED') response = deploymentStateWriteFailed();
      else {
        await finishRequestAuthStage(authStage, { status: 'succeeded' });
        const recoveredDeployment = await recoverUnexpectedRequestFailure({
          trace,
          store,
          env,
          config,
          ctx,
          actor: auth.actor,
          fallbackOperation: 'orchestrate_rollback_request',
        });
        response = await unexpectedRequestResponse(store, recoveredDeployment, config.environment);
      }
    }
    await finishRequestAuthStage(authStage, { status: 'succeeded' });
    response = await ensureRequestFailureTraced(trace, response);
    return withRequestTraceHeader(response, trace);
  }
  if (versionId) return methodNotAllowed();

  return null;
}

async function createDeployment(request, env, config, store, actor, ctx, trace, authStage) {
  setRequestTraceStage(trace, 'intake', 'read_deployment_request');
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return traceFailureResponse(trace, idempotencyKeyRequired(), {
      stage: 'intake',
      operation: 'read_idempotency_key',
      errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
      errorMessage: 'Idempotency-Key is required.',
      diagnostics: { causeClass: 'request_validation_error' },
    });
  }
  if (!isMultipartRequest(request)) {
    return traceFailureResponse(trace, cliUploadProtocolRequired(), {
      stage: 'intake',
      operation: 'parse_multipart',
      errorCode: 'CLI_UPLOAD_PROTOCOL_REQUIRED',
      errorMessage: 'Deployment uploads must use the CLI protocol.',
      diagnostics: { causeClass: 'payload_validation_error' },
    });
  }

  setRequestTraceStage(trace, 'intake', 'parse_multipart');
  let body;
  try {
    body = await readMultipartDeploymentBody(request);
  } catch (error) {
    if (error?.code === 'PAYLOAD_TOO_LARGE') {
      return jsonError(
        'PAYLOAD_TOO_LARGE',
        'Deployment payload is too large.',
        413,
        'Reduce artifact size or use an asset store backed deployment path.'
      );
    }
    if (error?.code === 'ASSET_MANIFEST_INVALID') {
      return jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Send a valid assetManifest field.');
    }
    if (error?.code === 'ASSET_FILES_REQUIRED') {
      return jsonError('ASSET_FILES_REQUIRED', 'Asset files are required.', 400, 'Upload every file listed in assetManifest.');
    }
    if (error?.code === 'FALLBACK_REQUIRES_ASSETS') {
      return jsonError(
        'FALLBACK_REQUIRES_ASSETS',
        'Fallback can only be set for deployments with assets.',
        400,
        'Remove fallback for worker-only deployments or upload assets.'
      );
    }
    if (error?.code === 'FALLBACK_INDEX_REQUIRES_INDEX_HTML') {
      return jsonError(
        'FALLBACK_INDEX_REQUIRES_INDEX_HTML',
        'Index fallback requires /index.html.',
        400,
        'Upload index.html or set assets.not_found_handling to 404-page.'
      );
    }
    if (error?.code === 'PUBLISH_PLAN_VERSION_UNSUPPORTED') {
      return jsonError(
        'PUBLISH_PLAN_VERSION_UNSUPPORTED',
        'Publish plan version is unsupported.',
        400,
        'Upgrade the XD Cell CLI and retry.'
      );
    }
    if (error?.code === 'PUBLISH_PLAN_INVALID') {
      return jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run xd-cell deploy --dry-run and retry.');
    }
    if (error?.code === 'CONTENT_HASH_MISMATCH') {
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
    if (error?.code === 'RUNTIME_VARS_INVALID') {
      return jsonError(
        'RUNTIME_VARS_INVALID',
        'Runtime vars are invalid.',
        400,
        'Use non-sensitive string vars with valid Worker binding names.'
      );
    }
    if (error?.code === 'RUNTIME_VARS_LIMIT_EXCEEDED') {
      return jsonError(
        'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
        'Runtime bindings exceed platform limits.',
        400,
        'Reduce vars or secret size/count and retry.'
      );
    }
    if (error?.code === 'CLI_UPLOAD_PROTOCOL_REQUIRED') {
      return traceFailureResponse(trace, cliUploadProtocolRequired(), {
        stage: 'intake',
        operation: 'parse_multipart',
        errorCode: 'CLI_UPLOAD_PROTOCOL_REQUIRED',
        errorMessage: 'Deployment uploads must use the CLI protocol.',
        diagnostics: { causeClass: 'payload_validation_error' },
      });
    }
    return traceFailureResponse(
      trace,
      jsonError('INVALID_MULTIPART', 'Invalid multipart body.', 400, 'Run xd-cell deploy --dry-run and retry.'),
      {
        stage: 'intake',
        operation: 'parse_multipart',
        errorCode: 'INVALID_MULTIPART',
        errorMessage: 'Invalid multipart body.',
        diagnostics: { causeClass: 'payload_validation_error' },
      }
    );
  }
  queueRequestTraceSuccess(trace, 'intake', 'parse_multipart');
  setRequestTraceStage(trace, 'payload_validation', 'validate_deployment_payload');

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
  let site = await resolveDeploySite(store, actor, config, env, {
    siteId: requestedSiteId,
    siteSlug: requestedSiteSlug,
    teamId: requestedTeamId,
    visibility: requestedVisibility || 'org',
    requestedVisibility,
  });
  if (site instanceof Response) {
    await finishRequestAuthStageFromResponse(authStage, site, 'site_resolution_error');
    return site;
  }
  let ownerTransfer = null;
  const routeSlugError = validateDeployableSiteSlug(site.slug, config.environment);
  if (routeSlugError) {
    await finishRequestAuthStageFromResponse(authStage, routeSlugError, 'site_resolution_error');
    return routeSlugError;
  }
  const siteId = site.id;
  if (!actorCanDeploy(actor, site, 'deploy:site')) {
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
    deploymentResult = await store.createDeploymentForIdempotency({
      id: nextId(env, 'dep'),
      environment: config.environment,
      actorId: actor.actorId,
      actorUserId: actor.userId,
      actorType: actor.type,
      source,
      siteId,
      operation: 'deploy',
      idempotencyKey,
      requestHash,
      traceId: trace?.traceId || null,
      visibility: site.pendingOwnerTransfer?.visibility || site.defaultVisibility,
      previousVersionId: site.route?.activeVersionId || null,
      status: 'pending',
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

  let runtimeConfigStage = trace
    ? startDeploymentStage(trace, {
        stage: 'runtime_config',
        operation: 'resolve_runtime_config',
      })
    : null;
  if (!decisionRequiresWorker(decision) && runtimeConfigStage) {
    await finishDeploymentStage(runtimeConfigStage, { status: 'skipped' });
    runtimeConfigStage = null;
  }
  let runtimeSecrets = [];
  let originalRuntimeVarRecords = [];
  if (decisionRequiresWorker(decision)) {
    if (typeof store.listEnabledSiteSecrets !== 'function' || typeof store.listEnabledSiteVars !== 'function') {
      if (runtimeConfigStage) {
        await finishDeploymentStage(runtimeConfigStage, {
          status: 'failed',
          errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
          errorMessage: 'Runtime configuration is unavailable.',
          diagnostics: { causeClass: 'runtime_config_error' },
        });
      }
      await finalizeFailedDeployment(runtimeConfigFailurePatch());
      return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime configuration is unavailable.', 503, 'Retry later.');
    }
    try {
      originalRuntimeVarRecords = await store.listEnabledSiteVars(config.environment, siteId);
      runtimeVarRecords = workerRuntimeVarsProvided ? siteVarRecordsFromObject(requestedRuntimeVars) : originalRuntimeVarRecords;
      runtimeVars = runtimeVarsFromRecords(runtimeVarRecords);
      runtimeSecrets = await store.listEnabledSiteSecrets(config.environment, siteId);
    } catch {
      if (runtimeConfigStage) {
        await finishDeploymentStage(runtimeConfigStage, {
          status: 'failed',
          errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
          errorMessage: 'Runtime configuration is unavailable.',
          diagnostics: { causeClass: 'runtime_config_error' },
        });
      }
      await finalizeFailedDeployment(runtimeConfigFailurePatch());
      return jsonError(
        'RUNTIME_CONFIG_UNSUPPORTED',
        'Runtime configuration is unavailable.',
        503,
        'Check runtime configuration and retry with a new Idempotency-Key.'
      );
    }
  }
  try {
    validateRuntimeBindingQuotas(runtimeVars, runtimeSecrets);
  } catch (error) {
    if (runtimeConfigStage) {
      await finishDeploymentStage(runtimeConfigStage, {
        status: 'failed',
        errorCode:
          error?.message === 'RUNTIME_BINDING_NAME_CONFLICT'
            ? 'RUNTIME_BINDING_NAME_CONFLICT'
            : 'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
        errorMessage: 'Runtime bindings are invalid.',
        diagnostics: { causeClass: 'runtime_config_error' },
      });
    }
    await finalizeFailedDeployment(
      runtimeConfigFailurePatch({
        errorCode:
          error?.message === 'RUNTIME_BINDING_NAME_CONFLICT'
            ? 'RUNTIME_BINDING_NAME_CONFLICT'
            : 'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
        errorMessage: 'Runtime bindings are invalid.',
      })
    );
    if (error?.message === 'RUNTIME_BINDING_NAME_CONFLICT') {
      return jsonError(
        'RUNTIME_BINDING_NAME_CONFLICT',
        'Runtime binding names conflict.',
        400,
        'Use unique names for vars and site secrets.'
      );
    }
    return jsonError(
      'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
      'Runtime bindings exceed platform limits.',
      400,
      'Reduce vars or site secrets and retry.'
    );
  }
  try {
    await runtimeConfigHashInput(env, runtimeVars, runtimeSecrets);
  } catch {
    if (runtimeConfigStage) {
      await finishDeploymentStage(runtimeConfigStage, {
        status: 'failed',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
        errorMessage: 'Runtime configuration is unavailable.',
        diagnostics: { causeClass: 'runtime_config_error' },
      });
    }
    await finalizeFailedDeployment(runtimeConfigFailurePatch());
    return jsonError(
      'RUNTIME_CONFIG_UNSUPPORTED',
      'Runtime configuration is unavailable.',
      503,
      'Check runtime configuration and retry with a new Idempotency-Key.'
    );
  }
  const versionId = nextId(env, 'ver');
  const plannedWorkerName = workerNameFor(site, versionId, config.environment);
  try {
    validateRuntimeBindingQuotas(runtimeVars, runtimeSecrets);
  } catch (error) {
    if (runtimeConfigStage) {
      await finishDeploymentStage(runtimeConfigStage, {
        status: 'failed',
        errorCode:
          error?.message === 'RUNTIME_BINDING_NAME_CONFLICT'
            ? 'RUNTIME_BINDING_NAME_CONFLICT'
            : 'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
        errorMessage: 'Runtime bindings are invalid.',
        diagnostics: { causeClass: 'runtime_config_error' },
      });
    }
    await finalizeFailedDeployment(
      runtimeConfigFailurePatch({
        errorCode:
          error?.message === 'RUNTIME_BINDING_NAME_CONFLICT'
            ? 'RUNTIME_BINDING_NAME_CONFLICT'
            : 'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
        errorMessage: 'Runtime bindings are invalid.',
      })
    );
    if (error?.message === 'RUNTIME_BINDING_NAME_CONFLICT') {
      return jsonError(
        'RUNTIME_BINDING_NAME_CONFLICT',
        'Runtime binding names conflict.',
        400,
        'Use unique names for vars and site secrets.'
      );
    }
    return jsonError(
      'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
      'Runtime bindings exceed platform limits.',
      400,
      'Reduce vars or site secrets and retry.'
    );
  }
  const runtimeBindings = {
    vars: runtimeVars,
    secrets: runtimeSecrets.map((secret) => ({
      name: secret.name,
      value: secret.value,
      revision: secret.revision,
    })),
  };
  if (runtimeConfigStage) {
    await finishDeploymentStage(runtimeConfigStage, { status: 'succeeded' });
    runtimeConfigStage = null;
  }
  let provider;
  try {
    provider = createDeploymentProvider(env, config, store, site);
  } catch {
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
    ? await assertRuntimeConfigSnapshotUnchanged(
        store,
        config.environment,
        siteId,
        workerRuntimeVarsProvided ? originalRuntimeVarRecords : runtimeVarRecords,
        runtimeSecrets
      )
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
  const providerUploadStage = trace
    ? startDeploymentStage(trace, {
        stage: 'provider_upload',
        operation: 'provider_upload',
      })
    : null;
  let uploaded;
  try {
    uploaded = await provider.upload({
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
    if (providerUploadStage) {
      await finishDeploymentStage(providerUploadStage, {
        status: 'succeeded',
        operation: uploaded?.operation,
      });
    }
  } catch (error) {
    const code = publicProviderErrorCode(error, 'upload');
    const executionProvider = provider.executionProvider || 'wfp';
    const providerDiagnostics = buildProviderFailureDiagnostics(error, executionProvider);
    const disposition = providerFailureDisposition(error, 'upload', providerDiagnostics);
    if (providerUploadStage) {
      await finishDeploymentStage(providerUploadStage, {
        status: 'failed',
        error,
        errorCode: code,
        errorMessage: 'Deployment upload failed.',
        diagnostics: { causeClass: 'provider_upload_error' },
      });
    }
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
    ? await assertRuntimeConfigSnapshotUnchanged(
        store,
        config.environment,
        siteId,
        workerRuntimeVarsProvided ? originalRuntimeVarRecords : runtimeVarRecords,
        runtimeSecrets
      )
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
    await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
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
    await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
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
  const providerVerifyStage = trace
    ? startDeploymentStage(trace, {
        stage: 'provider_verify',
        operation: 'provider_verify',
      })
    : null;
  try {
    await provider.verify({
      site,
      workerName,
      versionId,
      artifactRef: uploaded.artifactRef,
      ...uploaded,
    });
    if (providerVerifyStage) await finishDeploymentStage(providerVerifyStage, { status: 'succeeded' });
  } catch (error) {
    const code = publicProviderErrorCode(null, 'verify');
    const executionProvider = uploaded.executionProvider || provider.executionProvider || 'wfp';
    const disposition = providerFailureDisposition(error, 'verify');
    if (providerVerifyStage) {
      await finishDeploymentStage(providerVerifyStage, {
        status: 'failed',
        error,
        errorCode: code,
        errorMessage: 'Deployment verification failed.',
        diagnostics: { causeClass: 'provider_verify_error' },
      });
    }
    await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
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

  let runtimeConfigCommitStage = trace
    ? startDeploymentStage(trace, {
        stage: 'runtime_config_commit',
        operation: 'commit_runtime_config',
      })
    : null;
  if (!workerRuntimeVarsProvided && runtimeConfigCommitStage) {
    await finishDeploymentStage(runtimeConfigCommitStage, { status: 'skipped' });
    runtimeConfigCommitStage = null;
  }
  if (workerRuntimeVarsProvided) {
    if (typeof store.replaceSiteVars !== 'function') {
      if (runtimeConfigCommitStage) {
        await finishDeploymentStage(runtimeConfigCommitStage, {
          status: 'failed',
          errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
          errorMessage: 'Runtime configuration is unavailable.',
          diagnostics: { causeClass: 'runtime_config_error' },
        });
      }
      await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
        originalFailure: { stage: 'runtime_config_commit', code: 'RUNTIME_CONFIG_UNSUPPORTED' },
        trafficImpact: 'old_version_retained',
      });
      await finalizeFailedDeployment(runtimeConfigFailurePatch());
      return runtimeConfigUnavailable();
    }
    const preCommitRuntimeSnapshotError = await assertRuntimeConfigSnapshotUnchanged(
      store,
      config.environment,
      siteId,
      originalRuntimeVarRecords,
      runtimeSecrets
    );
    if (preCommitRuntimeSnapshotError) {
      if (runtimeConfigCommitStage) {
        await finishDeploymentStage(runtimeConfigCommitStage, {
          status: 'failed',
          errorCode: preCommitRuntimeSnapshotError.code,
          errorMessage: preCommitRuntimeSnapshotError.message,
          diagnostics: { causeClass: 'runtime_config_changed' },
        });
      }
      await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
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
    try {
      runtimeVarRecords = await store.replaceSiteVars({
        environment: config.environment,
        siteId,
        vars: requestedRuntimeVars,
        actorId: actor.userId,
        updatedAt: readNow(env),
        createId: () => nextId(env, 'var'),
      });
      runtimeVars = runtimeVarsFromRecords(runtimeVarRecords);
    } catch {
      if (runtimeConfigCommitStage) {
        await finishDeploymentStage(runtimeConfigCommitStage, {
          status: 'failed',
          errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
          errorMessage: 'Runtime configuration is unavailable.',
          diagnostics: { causeClass: 'runtime_config_error' },
        });
      }
      await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
        originalFailure: { stage: 'runtime_config_commit', code: 'RUNTIME_CONFIG_UNSUPPORTED' },
        trafficImpact: 'old_version_retained',
      });
      await finalizeFailedDeployment(runtimeConfigFailurePatch());
      return runtimeConfigUnavailable();
    }
    if (runtimeConfigCommitStage) {
      await finishDeploymentStage(runtimeConfigCommitStage, { status: 'succeeded' });
      runtimeConfigCommitStage = null;
    }
  }
  const committedRuntimeVarRecords = runtimeVarRecords;

  let version;
  let previousRoute;
  let route;
  let ownerTransferRollbackSite = null;
  let ownerTransferApplied = false;
  let activationSnapshotFailureResponse = null;
  let versionCreateStage = null;
  let routePolicyLockStage = null;
  try {
    await persistIntermediateDeploymentState(store, deployment.id, { status: 'verified' }, 'persist_verified_deployment');
    previousRoute = await store.getRouteBySiteId(siteId, config.environment);
    const preActivationRuntimeSnapshotError = decisionRequiresWorker(decision)
      ? await assertRuntimeConfigSnapshotUnchanged(store, config.environment, siteId, runtimeVarRecords, runtimeSecrets)
      : null;
    if (preActivationRuntimeSnapshotError) {
      await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
        originalFailure: { stage: 'runtime_config', code: preActivationRuntimeSnapshotError.code },
        trafficImpact: 'old_version_retained',
      });
      await restoreSiteVarsAfterFailedDeployment(store, {
        environment: config.environment,
        siteId,
        restoreVars: originalRuntimeVarRecords,
        expectedVars: committedRuntimeVarRecords,
        actorId: actor.userId,
        updatedAt: readNow(env),
        createId: () => nextId(env, 'var'),
        enabled: workerRuntimeVarsProvided,
      });
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
        await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
          originalFailure: { stage: 'auth_and_site_resolution', code: 'SITE_TRANSFER_FAILED' },
          trafficImpact: 'old_version_retained',
        });
        await restoreSiteVarsAfterFailedDeployment(store, {
          environment: config.environment,
          siteId,
          restoreVars: originalRuntimeVarRecords,
          expectedVars: committedRuntimeVarRecords,
          actorId: actor.userId,
          updatedAt: readNow(env),
          createId: () => nextId(env, 'var'),
          enabled: workerRuntimeVarsProvided,
        });
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
    versionCreateStage = trace
      ? startDeploymentStage(trace, {
          stage: 'version_create',
          operation: 'create_site_version',
        })
      : null;
    version = await store.createSiteVersion({
      id: versionId,
      siteId,
      deploymentId: deployment.id,
      workerName,
      runtime: uploaded.runtime || 'worker',
      executionProvider: uploaded.executionProvider || provider.executionProvider || 'wfp',
      dispatchType: uploaded.dispatchType || 'dispatch-namespace',
      dispatchBindingName: uploaded.dispatchBindingName || null,
      slotId: uploaded.slotId || null,
      artifactRef: uploaded.artifactRef,
      contentHash: canonicalContentHash,
      deploymentShape: decision.deploymentShape,
      requestedFallback: decision.requestedFallback,
      resolvedFallback: decision.resolvedFallback,
      routingMode: decision.routingMode,
      workerEntry: decision.workerEntry,
      assetsConfigJson: assetsConfigForDecisionStorage(decision),
      workerModulesJson: artifactBundle
        ? artifactBundle.modules.map((module) => ({
            moduleName: module.name,
            contentType: module.type,
            size: module.content.length,
          }))
        : null,
      assetManifestJson: assetManifest
        ? Object.entries(assetManifest).map(([assetPath, entry]) => ({
            path: assetPath,
            hash: entry.hash,
            size: Number(entry.size),
            contentType: entry.content_type || null,
          }))
        : null,
      canonicalContentHash,
      varNamesJson: Object.keys(runtimeVars).sort(),
      secretNamesJson: runtimeSecrets.map((secret) => secret.name).sort(),
      runtimeConfigSnapshotJson: runtimeConfigSnapshot(
        runtimeVarRecords,
        await runtimeSecretSnapshotRecords(env, runtimeSecrets)
      ),
      artifactAvailability: 'active',
      createdBy: actor.userId,
    });
    if (versionCreateStage) {
      await finishDeploymentStage(versionCreateStage, { status: 'succeeded' });
      versionCreateStage = null;
    }
    await persistIntermediateDeploymentState(
      store,
      deployment.id,
      {
        status: 'activating',
        versionId: version.id,
      },
      'persist_activating_deployment'
    );
    routePolicyLockStage = trace
      ? startDeploymentStage(trace, {
          stage: 'route_policy_lock',
          operation: 'acquire_site_commit_lock',
        })
      : null;
    if (typeof store.withSiteCommitLock !== 'function') throw deploymentOperationError('SITE_POLICY_LOCKED');
    route = await store.withSiteCommitLock(
      config.environment,
      siteId,
      async (activationLease) => {
        if (routePolicyLockStage) {
          await finishDeploymentStage(routePolicyLockStage, { status: 'succeeded' });
          routePolicyLockStage = null;
        }
        const routeBeforeActivation = previousRoute;
        const latestRoute = await store.getRouteBySiteId(siteId, config.environment);
        if (!latestRoute) throw deploymentOperationError('ROUTE_ACTIVATION_CONFLICT');
        previousRoute = latestRoute;
        await persistIntermediateDeploymentState(
          store,
          deployment.id,
          { previousVersionId: latestRoute.activeVersionId || null },
          'persist_previous_version_deployment'
        );
        await assertRouteSnapshotConverged(env, store, latestRoute, config.environment);
        const activationExposure = normalizeExposureForDeployment(latestRoute.exposure);
        if (activationExposure !== uploadExposure) {
          throw deploymentOperationError('ROUTE_ACTIVATION_CONFLICT', {
            message: 'Site exposure changed while deployment was uploading.',
            action: 'Retry the deployment so Worker bindings match the latest site exposure.',
          });
        }
        const activationVisibility = ownerTransferApplied
          ? site.defaultVisibility
          : latestRoute.visibility === routeBeforeActivation?.visibility
            ? site.defaultVisibility
            : latestRoute.visibility;
        assertCommitLeaseHealthy(activationLease);
        const officeNetStage = trace
          ? startDeploymentStage(trace, {
              stage: 'office_net',
              operation: 'verify_public_office_net_absent',
            })
          : null;
        try {
          await ensurePublicWorkerOfficeNetAbsent(provider, {
            store,
            environment: config.environment,
            siteId,
            workerName: version.workerName,
            executionProvider: version.executionProvider,
            deploymentShape: decision.deploymentShape,
            exposure: activationExposure,
            signal: activationLease.signal,
          });
          if (officeNetStage) {
            await finishDeploymentStage(officeNetStage, {
              status: activationExposure === 'public' ? 'succeeded' : 'skipped',
            });
          }
        } catch (error) {
          if (officeNetStage) {
            await finishDeploymentStage(officeNetStage, {
              status: 'failed',
              error,
              errorCode: error?.code || 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
              errorMessage: error?.message || 'Public Worker OfficeNet verification failed.',
              diagnostics: { causeClass: 'public_office_net_error' },
            });
          }
          throw error;
        }
        assertCommitLeaseHealthy(activationLease);
        const routeActivateStage = trace
          ? startDeploymentStage(trace, {
              stage: 'route_activate',
              operation: 'activate_route',
            })
          : null;
        let activatedRoute;
        try {
          activatedRoute = await store.activateSiteVersion(
            siteId,
            {
              activeVersionId: version.id,
              workerName: version.workerName,
              runtime: version.runtime,
              executionProvider: version.executionProvider,
              dispatchType: version.dispatchType,
              dispatchBindingName: version.dispatchBindingName,
              slotId: version.slotId,
              visibility: activationVisibility,
              lease: activationLease,
              updatedAt: readNow(env),
            },
            config.environment,
            { ...latestRoute, exposure: activationExposure }
          );
          if (routeActivateStage) {
            await finishDeploymentStage(routeActivateStage, {
              status: activatedRoute ? 'succeeded' : 'failed',
              ...(!activatedRoute
                ? {
                    errorCode: 'ROUTE_ACTIVATION_CONFLICT',
                    errorMessage: 'Route changed while deployment was activating.',
                    diagnostics: { causeClass: 'route_activation_conflict' },
                  }
                : {}),
            });
          }
        } catch (error) {
          if (routeActivateStage) {
            await finishDeploymentStage(routeActivateStage, {
              status: 'failed',
              error,
              errorCode: error?.code || 'ROUTE_ACTIVATION_FAILED',
              errorMessage: error?.message || 'Route activation failed.',
              diagnostics: { causeClass: 'route_activation_error' },
            });
          }
          throw error;
        }
        if (!activatedRoute) return null;
        const routeSnapshotStage = trace
          ? startDeploymentStage(trace, {
              stage: 'route_snapshot',
              operation: 'write_route_snapshot',
            })
          : null;
        try {
          assertCommitLeaseHealthy(activationLease);
          await writeSnapshot(env, store, { site, route: activatedRoute, version });
          assertCommitLeaseHealthy(activationLease);
          if (routeSnapshotStage) await finishDeploymentStage(routeSnapshotStage, { status: 'succeeded' });
        } catch {
          if (routeSnapshotStage) {
            await finishDeploymentStage(routeSnapshotStage, {
              status: 'failed',
              errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
              errorMessage: 'Route snapshot write failed.',
              diagnostics: { causeClass: 'route_snapshot_store_error' },
            });
          }
          let restoredRoute = null;
          let restorationError = null;
          try {
            restoredRoute = await restoreSiteRouteAfterSnapshotFailure(
              store,
              siteId,
              previousRoute,
              activatedRoute,
              config.environment
            );
          } catch (error) {
            restorationError = error;
          }
          try {
            await restoreSiteVarsAfterFailedDeployment(store, {
              environment: config.environment,
              siteId,
              restoreVars: originalRuntimeVarRecords,
              expectedVars: committedRuntimeVarRecords,
              actorId: actor.userId,
              updatedAt: readNow(env),
              createId: () => nextId(env, 'var'),
              enabled: workerRuntimeVarsProvided,
            });
          } catch (error) {
            restorationError ||= error;
          }
          try {
            site =
              (await restoreDeployOwnerTransferAfterFailure(store, {
                siteId,
                previousSite: ownerTransferRollbackSite,
                environment: config.environment,
                enabled: ownerTransferApplied,
              })) || site;
          } catch (error) {
            restorationError ||= error;
          }
          const restoredSnapshotWritten = restorationError
            ? false
            : await writeRestoredRouteSnapshotAfterFailure(env, store, site, restoredRoute, config.environment);
          const routePointerCleared = restoredSnapshotWritten
            ? false
            : await clearRoutePointerAfterSnapshotFailure(env, restoredRoute || activatedRoute);
          const repairRequired = Boolean(restorationError || !restoredSnapshotWritten);
          await recordDeploymentStage(trace, {
            stage: 'cleanup_or_compensation',
            operation: 'restore_route_after_snapshot_failure',
            status: repairRequired ? 'failed' : 'compensated',
            ...(!repairRequired
              ? {}
              : {
                  errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
                  errorMessage: 'Route snapshot compensation failed.',
                }),
            diagnostics: {
              causeClass: repairRequired ? 'route_snapshot_compensation_error' : 'route_snapshot_compensated',
              routePointerCommitted: false,
              trafficImpact: repairRequired
                ? routePointerCleared
                  ? 'site_unavailable'
                  : 'public_route_state_unknown'
                : 'old_version_retained',
              cleanupStatus: repairRequired ? 'failed' : 'succeeded',
              operatorAction: repairRequired ? 'repair_route_snapshot' : undefined,
            },
          });
          if (repairRequired) {
            logDeploymentRepairRequired(env, {
              environment: config.environment,
              siteId,
              deploymentId: deployment.id,
              reason: 'route_snapshot_repair_failed',
            });
          }
          if (restoredSnapshotWritten) {
            await cleanupUploadedWorkerIfInactiveAndRecord(
              trace,
              store,
              provider,
              uploaded,
              siteId,
              version.id,
              config.environment,
              {
                originalFailure: { stage: 'route_snapshot', code: 'ROUTE_SNAPSHOT_WRITE_FAILED' },
                trafficImpact: repairRequired ? 'public_route_state_unknown' : 'old_version_retained',
              }
            );
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
      },
      { lockId: nextId(env, 'deploylock'), bestEffortRelease: true }
    );
  } catch (error) {
    const routePolicyLockFailed = Boolean(routePolicyLockStage);
    if (versionCreateStage) {
      await finishDeploymentStage(versionCreateStage, {
        status: 'failed',
        errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
        errorMessage: 'Deployment version could not be persisted.',
        diagnostics: { causeClass: 'version_store_error' },
      });
      versionCreateStage = null;
    }
    if (routePolicyLockStage) {
      await finishDeploymentStage(routePolicyLockStage, {
        status: 'failed',
        errorCode: error?.code || 'SITE_POLICY_LOCKED',
        errorMessage: error?.message || 'Site policy lock could not be acquired.',
        diagnostics: { causeClass: 'site_policy_lock_error' },
      });
      routePolicyLockStage = null;
    }
    await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
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
    });
    await restoreSiteVarsAfterFailedDeployment(store, {
      environment: config.environment,
      siteId,
      restoreVars: originalRuntimeVarRecords,
      expectedVars: committedRuntimeVarRecords,
      actorId: actor.userId,
      updatedAt: readNow(env),
      createId: () => nextId(env, 'var'),
      enabled: workerRuntimeVarsProvided,
    });
    site =
      (await restoreDeployOwnerTransferAfterFailure(store, {
        siteId,
        previousSite: ownerTransferRollbackSite,
        environment: config.environment,
        enabled: ownerTransferApplied,
      })) || site;
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
      await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
        originalFailure: { stage: 'runtime_config', code: 'RUNTIME_CONFIG_CHANGED' },
        trafficImpact: 'old_version_retained',
      });
      await restoreSiteVarsAfterFailedDeployment(store, {
        environment: config.environment,
        siteId,
        restoreVars: originalRuntimeVarRecords,
        expectedVars: committedRuntimeVarRecords,
        actorId: actor.userId,
        updatedAt: readNow(env),
        createId: () => nextId(env, 'var'),
        enabled: workerRuntimeVarsProvided,
      });
      site =
        (await restoreDeployOwnerTransferAfterFailure(store, {
          siteId,
          previousSite: ownerTransferRollbackSite,
          environment: config.environment,
          enabled: ownerTransferApplied,
        })) || site;
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
    await cleanupUploadedWorkerAndRecord(trace, provider, uploaded, {
      originalFailure: { stage: 'route_activate', code: 'ROUTE_ACTIVATION_CONFLICT' },
      trafficImpact: 'old_version_retained',
    });
    await restoreSiteVarsAfterFailedDeployment(store, {
      environment: config.environment,
      siteId,
      restoreVars: originalRuntimeVarRecords,
      expectedVars: committedRuntimeVarRecords,
      actorId: actor.userId,
      updatedAt: readNow(env),
      createId: () => nextId(env, 'var'),
      enabled: workerRuntimeVarsProvided,
    });
    site =
      (await restoreDeployOwnerTransferAfterFailure(store, {
        siteId,
        previousSite: ownerTransferRollbackSite,
        environment: config.environment,
        enabled: ownerTransferApplied,
      })) || site;
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
  const completedAt = readNow(env);
  const deploymentStateStage = trace
    ? startDeploymentStage(trace, {
        stage: 'deployment_state_persist',
        operation: 'persist_succeeded_deployment',
      })
    : null;
  let completed;
  try {
    completed = await store.updateDeployment(deployment.id, {
      status: 'succeeded',
      versionId: version.id,
      previousVersionId: previousRoute?.activeVersionId || null,
      completedAt,
    });
    if (deploymentStateStage) await finishDeploymentStage(deploymentStateStage, { status: 'succeeded' });
  } catch (cause) {
    await recordDeploymentStatePersistFailure({
      trace,
      env,
      deploymentId: deployment.id,
      operation: 'persist_succeeded_deployment',
      stageHandle: deploymentStateStage,
      cause,
    });
    completed = synthesizeSucceededDeployment(deployment, {
      versionId: version.id,
      previousVersionId: previousRoute?.activeVersionId || null,
      completedAt,
    });
  }

  await recordCleanupOutcome(trace, await cleanupPreviousNormalWorkerSlot(provider, previousRoute, route, env), {
    trafficImpact: 'new_version_active',
  });
  await recordCleanupOutcome(trace, await enqueuePreviousWfpWorkerCleanup(store, env, config, previousRoute, route, completed), {
    trafficImpact: 'new_version_active',
  });
  const webhookDelivery = emitDeploymentSucceededWebhook({
    store,
    env,
    config,
    actor,
    site,
    route,
    deployment: completed,
    trace,
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(webhookDelivery);
  } else {
    await webhookDelivery;
  }
  await emitSiteDisabledWebhook({ store, env, config, ctx, actor, site, previousRoute, route });

  return jsonOk(await deploymentEnvelope(store, completed, { version, route, decision, ownerTransfer }), 201);
}

async function emitDeploymentSucceededWebhook({ store, env, config, actor, site, route, deployment, trace }) {
  const stage = trace
    ? startDeploymentStage(trace, {
        stage: 'webhook_delivery',
        operation: 'site_deployed',
      })
    : null;
  try {
    const team =
      site.ownerType === 'team' && site.ownerId && typeof store.getTeam === 'function' ? await store.getTeam(site.ownerId) : null;
    const deliveries = await deliverWebhookEventToSubscriptions({
      store,
      env,
      config,
      event: {
        id: nextId(env, 'evt'),
        type: 'site.deployed',
        environment: config.environment,
        occurredAt: deployment.completedAt || readNow(env),
        actor: {
          type: actor.type,
          userId: actor.userId || null,
          email: actor.email || null,
          name: actor.name || null,
        },
        site: {
          id: site.id,
          slug: site.slug,
          hostname: route.hostname,
          ownerType: site.ownerType || 'user',
          ownerId: site.ownerId || site.ownerUserId,
          visibility: route.visibility || site.defaultVisibility,
          status: route.routeStatus,
        },
        team: team
          ? {
              id: team.id,
              name: team.name || null,
              teamType: team.teamType || null,
            }
          : undefined,
        deployment: {
          id: deployment.id,
          status: deployment.status,
          source: deployment.source,
          operation: deployment.operation,
          createdAt: deployment.createdAt,
          completedAt: deployment.completedAt || null,
        },
      },
      fetchImpl: typeof env.WEBHOOK_FETCH === 'function' ? env.WEBHOOK_FETCH : undefined,
      resolveHost: typeof env.resolveWebhookHost === 'function' ? env.resolveWebhookHost : undefined,
      now: () => deployment.completedAt || readNow(env),
    });
    if (stage) {
      if (deliveries.length === 0) {
        await finishDeploymentStage(stage, { status: 'skipped' });
      } else {
        const failed = deliveries.some((delivery) => delivery?.deliveryStatus === 'failed');
        await finishDeploymentStage(stage, {
          status: failed ? 'failed' : 'succeeded',
          ...(failed
            ? {
                errorCode: 'WEBHOOK_DELIVERY_FAILED',
                errorMessage: 'Webhook delivery failed.',
                diagnostics: { causeClass: 'webhook_delivery_error' },
              }
            : {}),
        });
      }
    }
  } catch {
    if (stage) {
      await finishDeploymentStage(stage, {
        status: 'failed',
        errorCode: 'WEBHOOK_DELIVERY_FAILED',
        errorMessage: 'Webhook delivery failed.',
        diagnostics: { causeClass: 'webhook_delivery_error' },
      });
    }
    // Webhook delivery is best-effort and must not mask a committed deployment.
  }
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
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return traceFailureResponse(trace, idempotencyKeyRequired(), {
      stage: 'intake',
      operation: 'read_idempotency_key',
      errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
      errorMessage: 'Idempotency-Key is required.',
      diagnostics: { causeClass: 'request_validation_error' },
    });
  }

  let body;
  try {
    body = await readOptionalJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return traceFailureResponse(trace, jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.'), {
      stage: 'intake',
      operation: 'parse_json',
      errorCode: 'INVALID_JSON',
      errorMessage: 'Invalid JSON body.',
      diagnostics: { causeClass: 'payload_validation_error' },
    });
  }
  queueRequestTraceSuccess(trace, 'intake', 'parse_json');
  setRequestTraceStage(trace, 'payload_validation', 'rollback_validate');

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  setRequestTraceStage(trace, 'auth_and_site_resolution', 'resolve_rollback_site');
  const version = await store.getSiteVersion(versionId, config.environment);
  if (!version) {
    const response = jsonError('VERSION_NOT_FOUND', 'Version not found.', 404, 'Check the version id.');
    await finishRequestAuthStageFromResponse(authStage, response, 'site_resolution_error');
    return response;
  }
  const requestedSiteError = await validateRequestedRollbackSite(store, version, body, config.environment);
  if (requestedSiteError) {
    await finishRequestAuthStageFromResponse(authStage, requestedSiteError, 'site_resolution_error');
    return requestedSiteError;
  }
  const site = await store.getSiteForUser(version.siteId, actor.userId, actor, config.environment);
  if (!site || !actorCanDeploy(actor, site, 'rollback:site')) {
    const response = jsonError('ROLLBACK_FORBIDDEN', 'Actor cannot rollback this site.', 403, 'Use a token scoped to this site.');
    await finishRequestAuthStageFromResponse(authStage, response, 'authorization_error');
    return response;
  }
  await recoverFailedDeploymentsForSite({ store, env, config, ctx, actor, site });

  setRequestTraceStage(trace, 'payload_validation', 'rollback_validate');
  const versionAvailabilityError = await validateRollbackVersion(store, version, config.environment);
  if (versionAvailabilityError) return versionAvailabilityError;
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
    deploymentResult = await store.createDeploymentForIdempotency({
      id: nextId(env, 'dep'),
      environment: config.environment,
      actorId: actor.actorId,
      actorUserId: actor.userId,
      actorType: actor.type,
      source: 'api',
      siteId: site.id,
      operation: 'rollback',
      idempotencyKey,
      requestHash,
      traceId: trace?.traceId || null,
      visibility: currentRoute.visibility,
      status: 'pending',
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

  let rollbackLease = null;
  let rollbackPolicyStage = trace
    ? startDeploymentStage(trace, {
        stage: 'route_policy_lock',
        operation: 'rollback_policy_lock',
      })
    : null;
  try {
    rollbackLease =
      typeof store.acquireSiteCommitLock === 'function'
        ? await acquireRenewableSiteCommitLease(store, config.environment, site.id, {
            lockId: nextId(env, 'rollbacklock'),
            ...(Number.isFinite(env?.SITE_COMMIT_LOCK_RENEW_INTERVAL_MS)
              ? { renewIntervalMs: env.SITE_COMMIT_LOCK_RENEW_INTERVAL_MS }
              : {}),
            ...(Number.isFinite(env?.SITE_COMMIT_LOCK_TIMEOUT_MS) ? { timeoutMs: env.SITE_COMMIT_LOCK_TIMEOUT_MS } : {}),
          })
        : null;
  } catch {
    if (rollbackPolicyStage) {
      await finishDeploymentStage(rollbackPolicyStage, {
        status: 'failed',
        errorCode: 'SITE_POLICY_LOCKED',
        errorMessage: 'Site policy lock could not be acquired.',
        diagnostics: { causeClass: 'site_policy_lock_error' },
      });
      rollbackPolicyStage = null;
    }
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, currentRoute, {
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
  if (!rollbackLease) {
    if (rollbackPolicyStage) {
      await finishDeploymentStage(rollbackPolicyStage, {
        status: 'failed',
        errorCode: 'SITE_POLICY_CONFLICT',
        errorMessage: 'Site policy changed while rollback was preparing.',
        diagnostics: { causeClass: 'site_policy_conflict' },
      });
      rollbackPolicyStage = null;
    }
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, currentRoute, {
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
  if (rollbackPolicyStage) {
    await finishDeploymentStage(rollbackPolicyStage, { status: 'succeeded' });
    rollbackPolicyStage = null;
  }
  const rollbackRouteBeforeActivation = currentRoute;
  let rollbackLatestRoute;
  try {
    rollbackLatestRoute = await store.getRouteBySiteId(site.id, config.environment);
  } catch {
    await recordDeploymentStage(trace, {
      stage: 'route_activate',
      operation: 'rollback_route_state_read',
      status: 'failed',
      errorCode: 'ROLLBACK_ACTIVATION_FAILED',
      errorMessage: 'Rollback route state could not be read.',
      diagnostics: { causeClass: 'rollback_route_state_read_error' },
    });
    await releaseSiteCommitLeaseBestEffort(rollbackLease);
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, currentRoute, {
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
  if (!rollbackLatestRoute) {
    await recordDeploymentStage(trace, {
      stage: 'route_activate',
      operation: 'rollback_route_activate',
      status: 'failed',
      errorCode: 'ROUTE_ACTIVATION_CONFLICT',
      errorMessage: 'Route changed while rollback was activating.',
      diagnostics: { causeClass: 'route_activation_conflict' },
    });
    await releaseSiteCommitLeaseBestEffort(rollbackLease);
    await finalizeFailedRollback(
      rollbackActivationFailurePatch(version, currentRoute, {
        errorCode: 'ROUTE_ACTIVATION_CONFLICT',
        errorMessage: 'Route changed while rollback was activating.',
        failureStage: 'rollback_activate_route',
        errorClass: 'route_activation_conflict',
      })
    );
    return jsonError('ROUTE_ACTIVATION_CONFLICT', 'Route changed while rollback was activating.', 409, 'Retry the rollback.');
  }
  currentRoute = rollbackLatestRoute;
  let route;
  let rollbackProvider;
  let rollbackOfficeNetStage = null;
  let rollbackRouteActivateStage = null;
  try {
    await assertRouteSnapshotConverged(env, store, currentRoute, config.environment);
    rollbackProvider = createDeploymentProvider(env, config, store, site);
    const rollbackExposure = normalizeExposureForDeployment(currentRoute.exposure);
    assertCommitLeaseHealthy(rollbackLease);
    rollbackOfficeNetStage = trace
      ? startDeploymentStage(trace, {
          stage: 'office_net',
          operation: 'rollback_verify_public_office_net_absent',
        })
      : null;
    await ensurePublicWorkerOfficeNetAbsent(rollbackProvider, {
      store,
      environment: config.environment,
      siteId: site.id,
      workerName: version.workerName,
      executionProvider: version.executionProvider,
      deploymentShape: version.deploymentShape,
      exposure: rollbackExposure,
      signal: rollbackLease.signal,
    });
    if (rollbackExposure === 'public' && currentRoute.activeVersionId && currentRoute.activeVersionId !== version.id) {
      const currentVersion = await store.getSiteVersion(currentRoute.activeVersionId, config.environment);
      if (!currentVersion) {
        throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', {
          message: 'The current public Worker version could not be verified before rollback.',
        });
      }
      await ensurePublicWorkerOfficeNetAbsent(rollbackProvider, {
        store,
        environment: config.environment,
        siteId: site.id,
        workerName: currentVersion.workerName,
        executionProvider: currentVersion.executionProvider,
        deploymentShape: currentVersion.deploymentShape,
        exposure: rollbackExposure,
        signal: rollbackLease.signal,
      });
    }
    if (rollbackOfficeNetStage) {
      await finishDeploymentStage(rollbackOfficeNetStage, {
        status: rollbackExposure === 'public' ? 'succeeded' : 'skipped',
      });
      rollbackOfficeNetStage = null;
    }
    assertCommitLeaseHealthy(rollbackLease);
    rollbackRouteActivateStage = trace
      ? startDeploymentStage(trace, {
          stage: 'route_activate',
          operation: 'rollback_route_activate',
        })
      : null;
    route = await store.activateSiteVersion(
      site.id,
      {
        activeVersionId: version.id,
        workerName: version.workerName,
        runtime: version.runtime,
        executionProvider: version.executionProvider,
        dispatchType: version.dispatchType,
        dispatchBindingName: version.dispatchBindingName,
        slotId: version.slotId,
        visibility: currentRoute.visibility,
        requiredArtifactAvailability: 'active',
        lease: rollbackLease,
        updatedAt: readNow(env),
      },
      config.environment,
      { ...rollbackLatestRoute, exposure: normalizeExposureForDeployment(rollbackLatestRoute.exposure) }
    );
    if (rollbackRouteActivateStage) {
      await finishDeploymentStage(rollbackRouteActivateStage, {
        status: route ? 'succeeded' : 'failed',
        ...(!route
          ? {
              errorCode: 'ROUTE_ACTIVATION_CONFLICT',
              errorMessage: 'Route changed while rollback was activating.',
              diagnostics: { causeClass: 'route_activation_conflict' },
            }
          : {}),
      });
      rollbackRouteActivateStage = null;
    }
  } catch (error) {
    if (rollbackOfficeNetStage) {
      await finishDeploymentStage(rollbackOfficeNetStage, {
        status: 'failed',
        error,
        errorCode: error?.code || 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
        errorMessage: error?.message || 'Public Worker OfficeNet verification failed.',
        diagnostics: { causeClass: 'public_office_net_error' },
      });
      rollbackOfficeNetStage = null;
    }
    if (rollbackRouteActivateStage) {
      await finishDeploymentStage(rollbackRouteActivateStage, {
        status: 'failed',
        error,
        errorCode: error?.code || 'ROLLBACK_ACTIVATION_FAILED',
        errorMessage: error?.message || 'Rollback activation failed.',
        diagnostics: { causeClass: 'rollback_activation_error' },
      });
      rollbackRouteActivateStage = null;
    }
    await releaseSiteCommitLeaseBestEffort(rollbackLease);
    if (isPublicOfficeNetFailure(error)) {
      await finalizeFailedRollback(
        rollbackActivationFailurePatch(version, rollbackRouteBeforeActivation, {
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
      rollbackActivationFailurePatch(version, rollbackRouteBeforeActivation, {
        errorCode: code,
        errorMessage: message,
        failureStage: 'rollback_activate_route',
        errorClass: code === 'SITE_POLICY_CONFLICT' ? 'site_policy_conflict' : 'rollback_activation_error',
      })
    );
    return jsonError(code, message, status, action);
  }
  if (!route) {
    await releaseSiteCommitLeaseBestEffort(rollbackLease);
    const latestVersion = await store.getSiteVersion(version.id, config.environment);
    if (latestVersion?.artifactAvailability !== 'active') {
      await finalizeFailedRollback({
        versionId: version.id,
        previousVersionId: currentRoute.activeVersionId,
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
      previousVersionId: currentRoute.activeVersionId,
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
  const rollbackRouteSnapshotStage = trace
    ? startDeploymentStage(trace, {
        stage: 'route_snapshot',
        operation: 'rollback_route_snapshot',
      })
    : null;
  try {
    assertCommitLeaseHealthy(rollbackLease);
    await writeSnapshot(env, store, { site, route, version });
    assertCommitLeaseHealthy(rollbackLease);
    if (rollbackRouteSnapshotStage) {
      await finishDeploymentStage(rollbackRouteSnapshotStage, { status: 'succeeded' });
    }
  } catch {
    if (rollbackRouteSnapshotStage) {
      await finishDeploymentStage(rollbackRouteSnapshotStage, {
        status: 'failed',
        errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
        errorMessage: 'Route snapshot write failed.',
        diagnostics: { causeClass: 'route_snapshot_store_error' },
      });
    }
    let restoredRoute = null;
    let restoredOfficeNetError = null;
    try {
      restoredRoute = await restoreSiteRouteAfterSnapshotFailure(store, site.id, currentRoute, route, config.environment);
    } catch (error) {
      restoredOfficeNetError = deploymentOperationError('ROUTE_SNAPSHOT_WRITE_FAILED', {
        message: 'The rollback route could not be restored after the snapshot write failed.',
        action: 'Repair the route snapshot before retrying the rollback.',
        cause: error,
      });
    }
    try {
      const restoredVersion = restoredRoute?.activeVersionId
        ? await store.getSiteVersion(restoredRoute.activeVersionId, config.environment)
        : null;
      await ensurePublicWorkerOfficeNetAbsent(rollbackProvider, {
        store,
        environment: config.environment,
        siteId: site.id,
        workerName: restoredRoute?.workerName || restoredVersion?.workerName,
        executionProvider: restoredRoute?.executionProvider || restoredVersion?.executionProvider,
        deploymentShape: restoredVersion?.deploymentShape || 'inactive',
        exposure: normalizeExposureForDeployment(restoredRoute?.exposure),
        signal: rollbackLease.signal,
      });
    } catch (error) {
      restoredOfficeNetError = error;
    }
    if (restoredOfficeNetError && restoredRoute?.exposure === 'public') {
      try {
        const compensated = await store.updateSiteAccessPolicy({
          environment: config.environment,
          siteId: site.id,
          exposure: 'internal',
          accessMode: 'disabled',
          expected: {
            policyVersion: restoredRoute.policyVersion,
            routeGeneration: restoredRoute.routeGeneration,
            activeVersionId: restoredRoute.activeVersionId,
            runtimeConfigGeneration: restoredRoute.runtimeConfigGeneration,
          },
          lease: rollbackLease,
          updatedAt: readNow(env),
        });
        restoredRoute = compensated?.route || restoredRoute;
      } catch (error) {
        restoredOfficeNetError = deploymentOperationError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', {
          message: 'The public rollback could not be compensated to a safe internal route.',
          action: 'Keep the site unavailable and repair the route before retrying the rollback.',
          cause: error,
        });
      }
    }
    let restoredSnapshotWritten = false;
    if (restoredOfficeNetError && restoredRoute?.exposure === 'public') {
      restoredSnapshotWritten = await writeSafeDisabledRouteSnapshotAfterFailure(
        env,
        store,
        site,
        restoredRoute,
        config.environment
      );
    } else {
      restoredSnapshotWritten = await writeRestoredRouteSnapshotAfterFailure(env, store, site, restoredRoute, config.environment);
    }
    const routePointerCleared = restoredSnapshotWritten
      ? false
      : await clearRoutePointerAfterSnapshotFailure(env, restoredRoute || route);
    const repairRequired = Boolean(!restoredSnapshotWritten);
    await recordDeploymentStage(trace, {
      stage: 'cleanup_or_compensation',
      operation: 'rollback_restore_route_after_snapshot_failure',
      status: repairRequired ? 'failed' : 'compensated',
      ...(repairRequired
        ? {
            errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
            errorMessage: 'Rollback route snapshot compensation failed.',
          }
        : {}),
      diagnostics: {
        causeClass: repairRequired ? 'route_snapshot_compensation_error' : 'route_snapshot_compensated',
        routePointerCommitted: false,
        trafficImpact: repairRequired
          ? routePointerCleared
            ? 'site_unavailable'
            : 'public_route_state_unknown'
          : 'old_version_retained',
        cleanupStatus: repairRequired ? 'failed' : 'succeeded',
        operatorAction: repairRequired ? 'repair_route_snapshot' : undefined,
      },
    });
    if (repairRequired) {
      logDeploymentRepairRequired(env, {
        environment: config.environment,
        siteId: site.id,
        deploymentId: deploymentResult.deployment.id,
        reason: 'route_snapshot_repair_failed',
      });
    }
    await releaseSiteCommitLeaseBestEffort(rollbackLease);
    const failureError = restoredOfficeNetError;
    const failureCode = failureError?.code || 'ROUTE_SNAPSHOT_WRITE_FAILED';
    const failureStage = failureError ? 'rollback_restore_public_office_net' : 'rollback_write_route_snapshot';
    await finalizeFailedRollback({
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
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

  await releaseSiteCommitLeaseBestEffort(rollbackLease);

  const completedAt = readNow(env);
  const rollbackStateStage = trace
    ? startDeploymentStage(trace, {
        stage: 'deployment_state_persist',
        operation: 'persist_succeeded_deployment',
      })
    : null;
  let completed;
  try {
    completed = await store.updateDeployment(deploymentResult.deployment.id, {
      status: 'succeeded',
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
      completedAt,
    });
    if (rollbackStateStage) await finishDeploymentStage(rollbackStateStage, { status: 'succeeded' });
  } catch (cause) {
    await recordDeploymentStatePersistFailure({
      trace,
      env,
      deploymentId: deploymentResult.deployment.id,
      operation: 'persist_succeeded_deployment',
      stageHandle: rollbackStateStage,
      cause,
    });
    completed = synthesizeSucceededDeployment(deploymentResult.deployment, {
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
      completedAt,
    });
  }
  await recordDeploymentStage(trace, {
    stage: 'webhook_delivery',
    operation: 'rollback_no_webhook',
    status: 'skipped',
  });

  return jsonOk(await deploymentEnvelope(store, completed, { version, route }), 201);
}

async function validateRequestedRollbackSite(store, version, body, environment) {
  const siteId = typeof body.siteId === 'string' ? body.siteId.trim() : '';
  if (siteId && siteId !== version.siteId) return rollbackSiteMismatch();

  const siteSlug = typeof body.siteSlug === 'string' ? body.siteSlug.trim().toLowerCase() : '';
  if (!siteSlug) return null;
  if (typeof store.findSiteBySlug !== 'function') return null;
  const requestedSite = await store.findSiteBySlug(environment, siteSlug);
  if (!requestedSite) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug.');
  if (requestedSite.id !== version.siteId) return rollbackSiteMismatch();
  return null;
}

function rollbackSiteMismatch() {
  return jsonError(
    'ROLLBACK_SITE_MISMATCH',
    'Rollback version does not belong to the requested site.',
    409,
    'Check the site name and version id.'
  );
}

async function resolveDeploySite(store, actor, config, env, { siteId, siteSlug, teamId, visibility, requestedVisibility }) {
  const environment = config.environment;
  if (siteId) {
    const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
    if (!site) return siteNotFound('Check the site id.');
    return transferDeploySiteToTeamIfRequested(store, actor, config, env, site, teamId, requestedVisibility);
  }
  const bySlug = typeof store.findSiteBySlug === 'function' ? await store.findSiteBySlug(environment, siteSlug) : null;
  if (!bySlug) {
    const slugError = validateDeploySiteSlug(siteSlug, environment);
    if (slugError) return slugError;
    return createSiteFromDeployOwner(store, actor, config, env, { siteSlug, teamId, visibility });
  }
  const site = await store.getSiteForUser(bySlug.id, actor.userId, actor, environment);
  if (!site) return siteNotFound('Check the site slug and access key scope.');
  return transferDeploySiteToTeamIfRequested(store, actor, config, env, site, teamId, requestedVisibility);
}

async function transferDeploySiteToTeamIfRequested(store, actor, config, env, site, teamId, visibility) {
  if (!teamId) return site;
  if (site.ownerType === 'team' && site.ownerId === teamId) return site;
  if (!actorCanManageSite(actor, site)) {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot transfer this site before deployment.',
      403,
      'Use a publisher/admin role or owner-scoped access key for the current site.'
    );
  }

  const target = await resolveDeployTransferTeam(store, actor, teamId, config.environment);
  if (target instanceof Response) return target;
  const nextVisibility = visibility || site.route?.visibility || site.defaultVisibility;
  if (nextVisibility === 'owner') return teamOwnerVisibilityUnsupported();
  if (typeof store.transferSiteOwner !== 'function') {
    return jsonError('SITE_TRANSFER_UNSUPPORTED', 'Site transfer is unavailable.', 503, 'Retry later.');
  }

  void env;
  return {
    ...site,
    pendingOwnerTransfer: {
      ownerId: target.ownerId,
      visibility,
    },
  };
}

async function applyPendingDeployOwnerTransfer(store, actor, config, env, site, transfer) {
  const updatedAt = readNow(env);
  const auditEvent = buildSiteOwnerTransferAuditEvent(
    env,
    config,
    actor,
    site,
    { ownerType: 'team', ownerId: transfer.ownerId },
    { source: 'deploy', createdAt: updatedAt }
  );
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

async function restoreDeployOwnerTransferAfterFailure(store, { siteId, previousSite, environment, enabled }) {
  if (!enabled || !previousSite || typeof store.transferSiteOwner !== 'function') return null;
  try {
    return await store.transferSiteOwner(
      siteId,
      {
        ownerType: previousSite.ownerType || 'user',
        ownerId: previousSite.ownerId || previousSite.ownerUserId,
        ownerUserId: previousSite.ownerUserId,
        defaultVisibility: previousSite.defaultVisibility,
        updatedAt: previousSite.updatedAt,
      },
      environment
    );
  } catch {
    return null;
  }
}

async function resolveDeployTransferTeam(store, actor, teamId, environment) {
  if (actor.type === 'access_key' && (actor.ownerType || 'user') === 'team') {
    if (actor.ownerId !== teamId || !actor.scopes.includes('deploy:site')) {
      return jsonError(
        'DEPLOY_FORBIDDEN',
        'Actor cannot transfer this site to the requested team.',
        403,
        'Use an owner-scoped access key for the target team.'
      );
    }
    const team = typeof store.getTeam === 'function' ? await store.getTeam(teamId) : null;
    if (!team || team.environment !== environment || team.deletedAt) {
      return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
    }
    return { ownerId: team.id, role: 'publisher' };
  }
  return resolveTeamDeployOwner(store, actor.userId, teamId, environment);
}

async function createSiteFromDeployOwner(store, actor, config, env, { siteSlug, teamId, visibility }) {
  if (actor.type !== 'access_key' && teamId) {
    return createTeamSiteFromUserDeploy(store, actor, config, env, { siteSlug, teamId, visibility });
  }
  return createSiteFromOwnerScopedAccessKeyDeploy(store, actor, config, env, { siteSlug, teamId, visibility });
}

async function createTeamSiteFromUserDeploy(store, actor, config, env, { siteSlug, teamId, visibility }) {
  if (visibility === 'owner') return teamOwnerVisibilityUnsupported();
  const teamOwner = await resolveTeamDeployOwner(store, actor.userId, teamId, config.environment);
  if (teamOwner instanceof Response) return teamOwner;
  return pendingDeploySiteCreation(config, env, {
    siteSlug,
    ownerType: 'team',
    ownerId: teamOwner.ownerId,
    ownerUserId: actor.userId,
    visibility,
    managementRole: teamOwner.role,
  });
}

async function createSiteFromOwnerScopedAccessKeyDeploy(store, actor, config, env, { siteSlug, teamId, visibility }) {
  if (actor.type !== 'access_key') return siteNotFound('Check the site slug.');
  if (actor.siteId) return siteNotFound('Check the site slug and access key scope.');
  if (!actor.scopes.includes('deploy:site')) {
    return jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use a token scoped to deploy sites.');
  }

  const ownerType = actor.ownerType || 'user';
  const ownerId = actor.ownerId || actor.userId;
  const ownerUserId = ownerType === 'team' ? actor.userId : ownerId;
  if (teamId && ownerType === 'user') {
    return createTeamSiteFromUserDeploy(store, actor, config, env, { siteSlug, teamId, visibility });
  }
  if (teamId && (ownerType !== 'team' || ownerId !== teamId)) {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot deploy this site.',
      403,
      'Use a user CLI token or an owner-scoped access key for this team.'
    );
  }
  if (!ownerId || !ownerUserId) {
    return jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use an active owner-scoped access key.');
  }
  if (ownerType === 'team' && visibility === 'owner') return teamOwnerVisibilityUnsupported();

  return pendingDeploySiteCreation(config, env, {
    siteSlug,
    ownerType,
    ownerId,
    ownerUserId,
    visibility,
  });
}

function teamOwnerVisibilityUnsupported() {
  return jsonError(
    'SITE_VISIBILITY_INVALID',
    'Team-owned sites cannot use owner visibility.',
    400,
    'Use internal, org, acl, or disabled for team-owned sites.'
  );
}

function pendingDeploySiteCreation(config, env, { siteSlug, ownerType, ownerId, ownerUserId, visibility, managementRole }) {
  const site = {
    id: nextId(env, 'site'),
    slug: siteSlug,
    ownerType,
    ownerId,
    ownerUserId,
    siteUuid: nextSiteUuid(env),
    defaultVisibility: visibility,
    environment: config.environment,
    managementRole: managementRole || null,
  };
  return {
    ...site,
    pendingSiteCreation: {
      ...site,
      routeId: nextId(env, 'route'),
      hostname: hostnameForSlug(siteSlug, config),
    },
  };
}

async function applyPendingDeploySiteCreation(env, config, store, actor, site) {
  try {
    const created = await createSiteWithLegacyV1Takeover({
      env,
      config,
      store,
      actor,
      siteInput: {
        id: site.pendingSiteCreation.id,
        slug: site.pendingSiteCreation.slug,
        ownerType: site.pendingSiteCreation.ownerType,
        ownerId: site.pendingSiteCreation.ownerId,
        ownerUserId: site.pendingSiteCreation.ownerUserId,
        siteUuid: site.pendingSiteCreation.siteUuid,
        defaultVisibility: site.pendingSiteCreation.defaultVisibility,
        environment: site.pendingSiteCreation.environment,
        routeId: site.pendingSiteCreation.routeId,
        hostname: site.pendingSiteCreation.hostname,
      },
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

async function resolveTeamDeployOwner(store, userId, teamId, environment) {
  if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
  const team = await store.getTeam(teamId);
  if (!team || team.environment !== environment) {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  const member = await store.getTeamMember({ teamId, userId });
  if (!member) return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  if (member.role !== 'admin' && member.role !== 'publisher') {
    return jsonError(
      'TEAM_PUBLISHER_REQUIRED',
      'Team publisher role required.',
      403,
      'Ask a team publisher to deploy this site.'
    );
  }
  return { ownerId: team.id, role: member.role };
}

async function validateRollbackVersion(store, version, environment) {
  if (version.artifactAvailability !== 'active') {
    return jsonError(
      'ROLLBACK_VERSION_UNAVAILABLE',
      'Version is not available for rollback.',
      409,
      'Deploy a new version because this version artifact is no longer active.'
    );
  }

  const deployment = await store.getDeployment(version.deploymentId, environment);
  if (!deployment || deployment.status !== 'succeeded') {
    return jsonError(
      'ROLLBACK_VERSION_UNAVAILABLE',
      'Version is not available for rollback.',
      409,
      'Rollback to a version from a succeeded deployment.'
    );
  }

  if (version.executionProvider === 'normal-worker-slot') {
    return jsonError(
      'ROLLBACK_VERSION_UNAVAILABLE',
      'Version is not available for rollback.',
      409,
      'Normal Worker slot versions are legacy-only. Deploy a new WFP version instead.'
    );
  }
  return null;
}

async function deploymentEnvelope(store, deployment, preloaded = {}, environment) {
  const version =
    preloaded.version || (deployment.versionId ? await store.getSiteVersion(deployment.versionId, environment) : null);
  const route = preloaded.route || (deployment.siteId ? await store.getRouteBySiteId(deployment.siteId, environment) : null);
  const envelope = {
    deployment: formatDeployment(deployment),
    version: version ? formatVersion(version) : null,
    route: route ? formatRoute(route) : null,
    decision: preloaded.decision ? formatDecision(preloaded.decision) : formatVersionDecision(version),
  };
  if (preloaded.ownerTransfer) envelope.ownerTransfer = preloaded.ownerTransfer;
  return envelope;
}

function formatDeployment(deployment) {
  const formatted = {
    id: deployment.id,
    siteId: deployment.siteId,
    versionId: deployment.versionId,
    actorType: deployment.actorType,
    operation: deployment.operation,
    source: deployment.source,
    visibility: deployment.visibility,
    status: deployment.status,
    errorCode: deployment.errorCode || null,
    errorMessage: deployment.errorMessage || null,
    previousVersionId: deployment.previousVersionId,
    createdAt: deployment.createdAt,
    completedAt: deployment.completedAt,
  };
  if (deployment.failureStage) formatted.failureStage = deployment.failureStage;
  return formatted;
}

function formatVersion(version) {
  return {
    id: version.id,
    siteId: version.siteId,
    deploymentId: version.deploymentId,
    runtime: version.runtime,
    contentHash: version.contentHash,
    decision: formatVersionDecision(version),
    workerEntry: version.workerEntry || null,
    createdAt: version.createdAt,
  };
}

function formatDecision(decision) {
  return {
    deploymentShape: decision.deploymentShape,
    requestedFallback: decision.requestedFallback,
    resolvedFallback: decision.resolvedFallback,
    routingMode: decision.routingMode,
  };
}

function formatVersionDecision(version) {
  if (!version) return null;
  if (!version.deploymentShape && !version.routingMode) return null;
  return {
    deploymentShape: version.deploymentShape || null,
    requestedFallback: version.requestedFallback || null,
    resolvedFallback: version.resolvedFallback || null,
    routingMode: version.routingMode || null,
  };
}

function assetsConfigForDecisionStorage(decision) {
  if (!decisionRequiresAssets(decision)) return null;
  return {
    not_found_handling:
      decision.resolvedFallback === 'index'
        ? 'single-page-application'
        : decision.resolvedFallback === 'not-found'
          ? '404-page'
          : 'none',
    ...(decision.routingMode === 'worker-first' ? { run_worker_first: true } : {}),
  };
}

function formatRoute(route) {
  return {
    id: route.id,
    hostname: route.hostname,
    siteId: route.siteId,
    runtime: route.runtime,
    activeVersionId: route.activeVersionId,
    visibility: route.visibility,
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    routeStatus: route.routeStatus,
  };
}

async function writeSnapshot(env, store, input) {
  const aclEntries = await store.listSiteAclEntries(input.site.id);
  const site = await store.getSite(input.site.id);
  const snapshot = buildRouteSnapshot({ ...input, site, aclEntries });
  await writeRouteSnapshot(env, snapshot);
  return snapshot;
}

async function restoreSiteRouteAfterSnapshotFailure(store, siteId, previousRoute, expectedRoute, environment) {
  if (typeof store.restoreSiteRouteIfCurrent === 'function') {
    return store.restoreSiteRouteIfCurrent(siteId, previousRoute, expectedRoute, environment);
  }
  return store.restoreSiteRoute(siteId, previousRoute, environment);
}

async function writeRestoredRouteSnapshotAfterFailure(env, store, site, route, environment) {
  if (!route) return false;
  try {
    const version = route.activeVersionId
      ? await store.getSiteVersion(route.activeVersionId, environment)
      : inactiveRouteVersion(route);
    if (!version && route.routeStatus === 'active') return false;
    await writeSnapshot(env, store, { site, route, version });
    return true;
  } catch {
    return false;
  }
}

async function writeSafeDisabledRouteSnapshotAfterFailure(env, store, site, route, environment) {
  if (!route) return false;
  const safeRoute = {
    ...route,
    exposure: 'internal',
    visibility: 'disabled',
    accessMode: 'disabled',
  };
  try {
    const version = safeRoute.activeVersionId
      ? await store.getSiteVersion(safeRoute.activeVersionId, environment)
      : inactiveRouteVersion(safeRoute);
    if (!version && safeRoute.routeStatus === 'active') return false;
    await writeSnapshot(env, store, { site, route: safeRoute, version });
    return true;
  } catch {
    return false;
  }
}

async function clearRoutePointerAfterSnapshotFailure(env, route) {
  if (!route || !env?.ROUTE_SNAPSHOTS) return false;
  try {
    return await clearRoutePointerIfCurrent(env, {
      hostname: route.hostname,
      environment: route.environment,
      routeGeneration: Number(route.routeGeneration || 0),
      policyVersion: Number(route.policyVersion || 0),
      snapshotKey: routeSnapshotKey(
        route.environment,
        route.hostname,
        Number(route.routeGeneration || 0),
        Number(route.policyVersion || 0)
      ),
    });
  } catch {
    return false;
  }
}

function inactiveRouteVersion(route) {
  return {
    id: null,
    executionProvider: route.executionProvider,
    dispatchType: route.dispatchType,
    dispatchBindingName: route.dispatchBindingName,
    slotId: route.slotId,
    contentHash: null,
    deploymentShape: 'inactive',
    resolvedFallback: null,
    routingMode: null,
  };
}

async function cleanupUploadedWorker(provider, uploaded) {
  const operation = 'worker_delete';
  if (!uploaded || typeof provider?.delete !== 'function') {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  try {
    await provider.delete(uploaded);
    return cleanupOutcome('succeeded', operation, { causeClass: 'cleanup_succeeded' });
  } catch (error) {
    return cleanupOutcome('failed', error?.operation || operation, { error });
  }
}

async function cleanupUploadedWorkerIfInactive(store, provider, uploaded, siteId, versionId, environment) {
  let route;
  try {
    route = await store.getRouteBySiteId(siteId, environment);
  } catch {
    return cleanupOutcome('failed', 'worker_delete', { causeClass: 'cleanup_state_read_error' });
  }
  if (routeReferencesUploadedWorker(route, uploaded, versionId)) {
    return cleanupOutcome('not_needed', 'worker_delete', { causeClass: 'cleanup_not_needed' });
  }
  return cleanupUploadedWorker(provider, uploaded);
}

function routeReferencesUploadedWorker(route, uploaded, versionId) {
  if (!route || !uploaded) return false;
  return (
    route.activeVersionId === versionId ||
    (uploaded.workerName && route.workerName === uploaded.workerName) ||
    (uploaded.slotId && route.slotId === uploaded.slotId)
  );
}

async function cleanupPreviousNormalWorkerSlot(provider, previousRoute, activeRoute, env) {
  const operation = 'worker_placeholder_put';
  if (typeof provider?.cleanupRetainedSlot !== 'function') {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  if (previousRoute?.executionProvider !== 'normal-worker-slot') {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  if (!previousRoute.slotId || !previousRoute.activeVersionId || previousRoute.slotId === activeRoute?.slotId) {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  try {
    await provider.cleanupRetainedSlot({
      slotId: previousRoute.slotId,
      versionId: previousRoute.activeVersionId,
      activeSlotId: activeRoute?.slotId || null,
      updatedAt: readNow(env),
    });
    return cleanupOutcome('succeeded', operation, { causeClass: 'cleanup_succeeded' });
  } catch (error) {
    return cleanupOutcome('failed', error?.operation || operation, { error });
  }
}

async function enqueuePreviousWfpWorkerCleanup(store, env, config, previousRoute, activeRoute, deployment) {
  const operation = 'worker_delete';
  if (typeof store.createDeploymentResourceCleanupTask !== 'function') {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  if (!previousRoute || previousRoute.routeStatus !== 'active') {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  if (previousRoute.executionProvider !== 'wfp' && previousRoute.dispatchType !== 'dispatch-namespace') {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  if (!previousRoute.workerName || !previousRoute.activeVersionId) {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  if (previousRoute.workerName === activeRoute?.workerName || previousRoute.activeVersionId === activeRoute?.activeVersionId) {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }
  if (!isManagedWfpWorkerName(previousRoute.workerName, config.environment)) {
    return cleanupOutcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
  }

  const cleanupTaskId = nextId(env, 'cln');
  try {
    await store.createDeploymentResourceCleanupTask({
      id: cleanupTaskId,
      environment: config.environment,
      resourceType: 'wfp_user_worker',
      resourceRef: previousRoute.workerName,
      siteId: previousRoute.siteId,
      versionId: previousRoute.activeVersionId,
      deploymentId: deployment.id,
      cleanupReason: 'blue_green_previous_worker',
      status: 'pending',
      cleanupAfter: cleanupAfterDrainWindow(env),
    });
    return cleanupOutcome('scheduled', operation, {
      cleanupTaskId,
      causeClass: 'cleanup_scheduled',
    });
  } catch {
    return cleanupOutcome('failed', operation, {
      cleanupTaskId,
      causeClass: 'cleanup_task_store_error',
    });
  }
}

function cleanupOutcome(status, operation, { cleanupTaskId, error, causeClass } = {}) {
  const provider = error ? providerDiagnosticsFromError(error) : undefined;
  return omitUndefined({
    status,
    operation,
    cleanupTaskId,
    causeClass: causeClass || provider?.causeClass || (status === 'failed' ? 'cleanup_error' : 'cleanup_succeeded'),
    provider,
  });
}

async function recordCleanupOutcome(trace, outcome, { originalFailure, trafficImpact } = {}) {
  if (!trace || !outcome) return outcome;
  const eventStatus =
    outcome.status === 'failed'
      ? 'failed'
      : outcome.status === 'not_needed'
        ? 'skipped'
        : outcome.status === 'succeeded'
          ? 'compensated'
          : 'succeeded';
  await recordDeploymentStage(trace, {
    stage: 'cleanup_or_compensation',
    operation: outcome.operation,
    status: eventStatus,
    diagnostics: {
      causeClass: outcome.causeClass,
      trafficImpact,
      cleanupStatus: outcome.status,
      cleanupTaskId: outcome.cleanupTaskId,
      originalFailure,
      compensation: {
        status: outcome.status,
        operation: outcome.operation,
        ...outcome.provider,
      },
    },
  });
  return outcome;
}

async function cleanupUploadedWorkerAndRecord(trace, provider, uploaded, context) {
  const outcome = await cleanupUploadedWorker(provider, uploaded);
  return recordCleanupOutcome(trace, outcome, context);
}

async function cleanupUploadedWorkerIfInactiveAndRecord(
  trace,
  store,
  provider,
  uploaded,
  siteId,
  versionId,
  environment,
  context
) {
  const outcome = await cleanupUploadedWorkerIfInactive(store, provider, uploaded, siteId, versionId, environment);
  return recordCleanupOutcome(trace, outcome, context);
}

function cleanupAfterDrainWindow(env) {
  const now = Date.parse(readNow(env));
  const configured = Number(env?.WFP_WORKER_CLEANUP_DRAIN_SECONDS || env?.WFP_CLEANUP_DRAIN_SECONDS || 300);
  const seconds = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 24 * 60 * 60) : 300;
  return new Date(now + seconds * 1000).toISOString();
}

async function reconcileCommittedDeployment(store, deployment, environment, env, trace = null) {
  if (!deployment || deployment.status === 'succeeded' || deployment.status === 'failed') return deployment;
  if (!deployment.siteId || !deployment.versionId) return deployment;

  const version = await store.getSiteVersion(deployment.versionId, environment);
  const route = await store.getRouteBySiteId(deployment.siteId, environment);
  const routeCommitted = route?.activeVersionId === deployment.versionId;
  const deploymentOwnsVersion = version?.deploymentId === deployment.id;
  const rollbackCommitted = deployment.operation === 'rollback' && Boolean(version) && routeCommitted;
  if (!routeCommitted || (!deploymentOwnsVersion && !rollbackCommitted)) {
    return deployment;
  }

  const patch = {
    status: 'succeeded',
    versionId: deployment.versionId,
    completedAt: deployment.completedAt || readNow(env),
  };
  const reconciliationTrace = trace || (await traceForStoredDeployment(store, deployment, environment, env));
  try {
    const reconciled = (await store.updateDeployment(deployment.id, patch)) || synthesizeSucceededDeployment(deployment, patch);
    if (reconciliationTrace) {
      await recordDeploymentStage(reconciliationTrace, {
        stage: 'deployment_state_persist',
        operation: 'reconcile_committed_deployment',
        status: 'compensated',
        diagnostics: {
          causeClass: 'deployment_state_reconciled',
          trafficImpact: 'new_version_active',
        },
      });
    }
    return reconciled;
  } catch (cause) {
    await recordDeploymentStatePersistFailure({
      trace: reconciliationTrace,
      env,
      deploymentId: deployment.id,
      operation: 'reconcile_committed_deployment',
      cause,
    });
    return synthesizeSucceededDeployment(deployment, patch);
  }
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

function synthesizeSucceededDeployment(deployment, patch) {
  return {
    ...deployment,
    ...patch,
    status: 'succeeded',
    errorCode: null,
    errorMessage: null,
    failureStage: null,
    failureDiagnostics: null,
  };
}

function buildDeploymentFailureDiagnostics({
  stage,
  executionProvider,
  deploymentShape,
  plannedVersionId,
  plannedWorkerName,
  uploadCompleted = false,
  verifyCompleted = false,
  routeActivatedInD1,
  routePointerCommitted = false,
  routePointerCleared,
  previousRouteRestored,
  uploadedWorkerCleanup,
  trafficImpact = 'old_version_retained',
  retryable = true,
  operatorAction = 'retry_deploy',
  cause,
  provider,
}) {
  return omitUndefined({
    schemaVersion: 1,
    stage,
    executionProvider,
    deploymentShape,
    plannedVersionId,
    plannedWorkerName,
    uploadCompleted,
    verifyCompleted,
    routeActivatedInD1,
    routePointerCommitted,
    routePointerCleared,
    previousRouteRestored,
    uploadedWorkerCleanup,
    trafficImpact,
    retryable,
    operatorAction,
    cause,
    provider,
  });
}

function buildProviderFailureDiagnostics(error, executionProvider) {
  if (executionProvider !== 'wfp') return undefined;
  const operation = error?.operation;
  const clientCode = error?.code;
  if (!PROVIDER_DIAGNOSTIC_OPERATIONS.has(operation) || !PROVIDER_DIAGNOSTIC_CLIENT_CODES.has(clientCode)) {
    return undefined;
  }
  const diagnostics = providerDiagnosticsFromError(error);

  return omitUndefined({
    name: 'cloudflare_wfp',
    operation,
    httpStatus: diagnostics.httpStatus,
    clientCode,
    providerCode: diagnostics.providerCode,
    providerMessage: diagnostics.providerMessage,
    providerRequestId: diagnostics.providerRequestId,
  });
}

function omitUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function logDeploymentRepairRequired(env, input) {
  const payload = {
    event: 'pages_deployment_repair_required',
    environment: input.environment,
    siteId: input.siteId,
    deploymentId: input.deploymentId,
    reason: input.reason,
  };
  try {
    const logger =
      typeof env?.logDeploymentRepairRequired === 'function' ? env.logDeploymentRepairRequired : globalThis.console?.error;
    if (typeof logger === 'function') logger(JSON.stringify(payload));
  } catch {
    // Diagnostics must never replace the deployment response.
  }
}

function deploymentStoreErrorCause() {
  return {
    code: 'DEPLOYMENT_STATE_WRITE_FAILED',
    class: 'deployment_store_error',
  };
}

async function persistIntermediateDeploymentState(store, deploymentId, patch, operation) {
  try {
    return await store.updateDeployment(deploymentId, patch);
  } catch (cause) {
    const error = new Error('Deployment state could not be persisted.', { cause });
    error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
    error.deploymentStateOperation = operation;
    throw error;
  }
}

async function recordDeploymentStatePersistFailure({ trace, env, deploymentId, operation, stageHandle }) {
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

function logDeploymentStateWriteFailed(env, { traceId, deploymentId, operation }) {
  const payload = {
    event: 'pages_deployment_state_write_failed',
    traceId,
    deploymentId,
    stage: 'deployment_state_persist',
    operation,
    causeClass: 'deployment_store_error',
  };
  try {
    const logger =
      typeof env?.logDeploymentStateWriteFailed === 'function' ? env.logDeploymentStateWriteFailed : globalThis.console?.error;
    if (typeof logger === 'function') logger(JSON.stringify(payload));
  } catch {
    // Diagnostics must never replace the deployment response.
  }
}

function rollbackActivationFailurePatch(
  version,
  previousRoute,
  { errorCode, errorMessage, failureStage, errorClass, executionProviderFallback = 'unknown' }
) {
  return {
    versionId: version.id,
    previousVersionId: previousRoute?.activeVersionId || null,
    errorCode,
    errorMessage,
    failureStage,
    failureDiagnostics: buildDeploymentFailureDiagnostics({
      stage: failureStage,
      executionProvider: version.executionProvider || executionProviderFallback,
      deploymentShape: version.deploymentShape,
      plannedVersionId: version.id,
      plannedWorkerName: version.workerName,
      routeActivatedInD1: false,
      routePointerCommitted: false,
      cause: { code: errorCode, class: errorClass },
    }),
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

async function releaseSiteCommitLeaseBestEffort(lease) {
  if (!lease || typeof lease.release !== 'function') return false;
  try {
    return await lease.release();
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

function runtimeConfigFailurePatch({
  errorCode = 'RUNTIME_CONFIG_UNSUPPORTED',
  errorMessage = 'Runtime configuration is unavailable.',
} = {}) {
  return {
    errorCode,
    errorMessage,
    failureStage: 'runtime_config',
    failureDiagnostics: buildDeploymentFailureDiagnostics({
      stage: 'runtime_config',
      executionProvider: 'unknown',
      cause: { code: errorCode, class: 'runtime_config_error' },
    }),
  };
}

function deploymentOperationFailurePatch({ errorCode, errorMessage, operatorAction = 'retry_deploy' }) {
  return {
    errorCode,
    errorMessage,
    failureStage: 'deployment_operation',
    failureDiagnostics: buildDeploymentFailureDiagnostics({
      stage: 'deployment_operation',
      executionProvider: 'unknown',
      operatorAction,
      cause: { code: errorCode, class: 'deployment_operation_error' },
    }),
  };
}

async function updateDeploymentToFailedAndNotify({
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
  const before = await store.getDeployment(deploymentId, config.environment).catch(() => null);
  const failedPatch = {
    ...patch,
    status: 'failed',
    completedAt: patch.completedAt || readNow(env),
  };
  const persistStage = trace
    ? startDeploymentStage(trace, {
        stage: 'deployment_state_persist',
        operation: 'persist_failed_deployment',
      })
    : null;
  let initialPersistFailed = false;
  let updated;
  try {
    updated = await store.updateDeployment(deploymentId, failedPatch);
  } catch (cause) {
    initialPersistFailed = true;
    await recordDeploymentStatePersistFailure({
      trace,
      env,
      deploymentId,
      operation: 'persist_failed_deployment',
      stageHandle: persistStage,
      cause,
    });
    const recoveryStage = trace
      ? startDeploymentStage(trace, {
          stage: 'deployment_state_persist',
          operation: 'recover_failed_deployment',
        })
      : null;
    try {
      updated = await store.updateDeployment(deploymentId, failedPatch);
    } catch (recoveryCause) {
      await recordDeploymentStatePersistFailure({
        trace,
        env,
        deploymentId,
        operation: 'recover_failed_deployment',
        stageHandle: recoveryStage,
        cause: recoveryCause,
      });
      const recoveryMarkerStored = await persistFailedDeploymentRecoveryMarker(env, config, {
        deploymentId,
        siteId: site?.id || trace?.siteId || null,
        siteHostname: site?.route?.hostname || site?.hostname || null,
        operation: trace?.operation || null,
        failedPatch,
      });
      logDeploymentRepairRequired(env, {
        environment: config.environment,
        siteId: site?.id || trace?.siteId || null,
        deploymentId,
        reason: recoveryMarkerStored
          ? 'deployment_failure_state_recovery_deferred'
          : 'deployment_failure_state_recovery_failed',
      });
      const error = new Error('Deployment failure state could not be persisted.', { cause: recoveryCause });
      error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
      throw error;
    }
    if (recoveryStage) await finishDeploymentStage(recoveryStage, { status: 'succeeded' });
  }
  if (persistStage && !initialPersistFailed) await finishDeploymentStage(persistStage, { status: 'succeeded' });
  if (!before || !updated || before.status === 'failed' || updated.status !== 'failed' || !site) {
    if (trace) {
      await recordDeploymentStage(trace, {
        stage: 'webhook_delivery',
        operation: 'site_failed',
        status: 'skipped',
      });
    }
    return updated;
  }

  await emitSiteFailedWebhook({ store, env, config, ctx, actor, site, deployment: updated, trace });
  return updated;
}

function deploymentStateWriteFailed() {
  return jsonError(
    'DEPLOYMENT_STATE_WRITE_FAILED',
    'Deployment state could not be persisted.',
    503,
    'Retry the deployment with a new Idempotency-Key.'
  );
}

function runtimeConfigUnavailable() {
  return jsonError(
    'RUNTIME_CONFIG_UNSUPPORTED',
    'Runtime configuration is unavailable.',
    503,
    'Check runtime configuration and retry with a new Idempotency-Key.'
  );
}

function normalizeExposureForDeployment(value) {
  return value === 'public' ? 'public' : 'internal';
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

export async function ensurePublicWorkerOfficeNetAbsent(
  provider,
  { store, environment, siteId, workerName, executionProvider, deploymentShape, exposure, signal }
) {
  if (exposure !== 'public') return { status: 'not_applicable', reason: 'exposure-not-public' };
  if (deploymentShape === 'assets-only') return { status: 'not_applicable', reason: 'assets-only' };
  if (deploymentShape !== 'worker-only' && deploymentShape !== 'worker-with-assets') {
    throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', {
      message: 'The public Worker deployment shape is not recognized.',
      action: 'Deploy a known Worker shape and retry the public activation.',
    });
  }
  if (executionProvider === 'normal-worker-slot') return { status: 'not_applicable', reason: 'normal-worker-slot' };
  if (executionProvider !== 'wfp') {
    throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', {
      message: 'The public Worker execution provider cannot verify OfficeNet bindings.',
      action: 'Use a supported execution provider and retry the public activation.',
    });
  }
  const removeAndVerify = async ({ signal: settingsSignal } = {}) => {
    const providerSignal = combineAbortSignals(signal, settingsSignal);
    if (typeof provider.removeOfficeNetBinding !== 'function') {
      throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED');
    }
    try {
      await provider.removeOfficeNetBinding({ workerName, signal: providerSignal });
    } catch (error) {
      throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', { cause: error });
    }
    if (typeof provider.verifyOfficeNetAbsent !== 'function') {
      throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED');
    }
    try {
      const absent = await provider.verifyOfficeNetAbsent({ workerName, signal: providerSignal });
      if (!absent) throw new Error('OFFICE_NET_PRESENT');
    } catch (error) {
      throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', { cause: error });
    }
    return { status: 'verified' };
  };
  if (typeof store?.withRuntimeConfigLock === 'function') {
    try {
      return await store.withRuntimeConfigLock(environment, siteId, removeAndVerify);
    } catch (error) {
      if (isPublicOfficeNetFailure(error)) throw error;
      throw deploymentOperationError('SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', { cause: error });
    }
  }
  return await removeAndVerify({ signal });
}

function combineAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof globalThis.AbortSignal?.any === 'function') return globalThis.AbortSignal.any(activeSignals);
  const controller = new globalThis.AbortController();
  for (const activeSignal of activeSignals) {
    if (activeSignal.aborted) {
      controller.abort(activeSignal.reason);
      break;
    }
    activeSignal.addEventListener('abort', () => controller.abort(activeSignal.reason), { once: true });
  }
  return controller.signal;
}

function isPublicOfficeNetFailure(error) {
  return error?.code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' || error?.code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
}

function deploymentOperationError(code, { message, action, cause } = {}) {
  const defaults = {
    SITE_POLICY_LOCKED: {
      message: 'Site policy is being changed. Retry the deployment.',
      action: 'Retry the deployment with a new Idempotency-Key.',
      status: 409,
    },
    ROUTE_ACTIVATION_CONFLICT: {
      message: 'Route changed while deployment was activating.',
      action: 'Check the latest site status and retry the deployment with a new Idempotency-Key.',
      status: 409,
    },
    SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED: {
      message: 'The public Worker still has an OfficeNet binding that could not be removed.',
      action: 'Check the active Worker settings and retry the deployment.',
      status: 503,
    },
    SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED: {
      message: 'The public Worker OfficeNet binding could not be verified absent.',
      action: 'Check the active Worker settings and retry the deployment.',
      status: 503,
    },
    ROUTE_SNAPSHOT_WRITE_FAILED: {
      message: 'Route snapshot could not be written.',
      action: 'Repair the route snapshot before retrying the deployment.',
      status: 503,
    },
  }[code] || {
    message: 'Deployment operation failed.',
    action: 'Retry the deployment with a new Idempotency-Key.',
    status: 409,
  };
  const error = new Error(message || defaults.message, { cause });
  error.code = code;
  error.status = defaults.status;
  error.action = action || defaults.action;
  return error;
}

function publicProviderErrorCode(error, step) {
  if (error?.code === 'SLOT_CAPACITY_EXHAUSTED') return 'DEPLOYMENT_CAPACITY_EXHAUSTED';
  return step === 'upload' ? 'DEPLOYMENT_UPLOAD_FAILED' : 'DEPLOYMENT_VERIFY_FAILED';
}

function providerFailureDisposition(error, step, providerDiagnostics) {
  if (step === 'upload' && isWorkerSourceCompilationFailure(error)) {
    const providerMessage = providerDiagnostics?.providerMessage;
    return {
      retryable: false,
      operatorAction: 'fix_worker_source',
      responseStatus: 400,
      responseMessage: 'Worker source compilation failed.',
      responseAction: providerMessage
        ? `Fix the Worker source and deploy again: ${providerMessage}`
        : 'Fix the Worker source compilation error, then deploy again.',
    };
  }

  return {
    retryable: true,
    operatorAction: 'retry_deploy',
    responseStatus: 502,
    responseMessage: step === 'verify' ? 'Deployment verification failed.' : 'Deployment upload failed.',
    responseAction: 'Retry the deployment with a new Idempotency-Key.',
  };
}

function isWorkerSourceCompilationFailure(error) {
  if (error?.operation !== 'worker_put' || Number(error?.status) !== 400) return false;
  const providerCode = error?.providerCode === undefined || error?.providerCode === null ? '' : String(error.providerCode);
  if (providerCode === '10021') return true;
  const providerMessage = typeof error?.providerMessage === 'string' ? error.providerMessage : '';
  return /(?:SyntaxError|syntax error|Unexpected end of input)/i.test(providerMessage);
}

function actorCanDeploy(actor, site, requiredScope) {
  if (!site) return false;
  if (actor.type !== 'access_key') {
    if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
    return site.ownerUserId === actor.userId;
  }
  if (actor.siteId && actor.siteId !== site.id) return false;
  if (!actor.scopes.includes(requiredScope)) return false;
  const ownerType = actor.ownerType || 'user';
  const ownerId = actor.ownerId || actor.userId;
  if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === ownerId;
  if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
  return (site.ownerId || site.ownerUserId) === ownerId;
}

function actorCanReadSite(actor, site) {
  if (actor.type !== 'access_key') return true;
  if (!actor.scopes.includes('read:site')) return false;
  if (!site || typeof site === 'string') return false;
  if (actor.siteId && actor.siteId !== site.id) return false;
  if (actor.siteId && !actor.ownerType && !actor.ownerId && !actor.userId) return actor.siteId === site.id;

  const ownerType = actor.ownerType || 'user';
  const ownerId = actor.ownerId || actor.userId;
  if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === ownerId;
  if ((site.ownerType || 'user') === 'user') return (site.ownerId || site.ownerUserId) === ownerId;
  if (site.ownerType === 'team') return Boolean(site.managementRole);
  return false;
}

function workerNameFor(site, deploymentId, environment) {
  const prefix = environment === 'staging' ? 'pages-v2-staging' : 'pages-v2';
  const suffix = boundedNamePart(deploymentId, 16);
  const maxSlugLength = Math.max(4, 63 - prefix.length - suffix.length - 2);
  const slug = boundedNamePart(site.slug, maxSlugLength);
  return `${prefix}-${slug}-${suffix}`;
}

function boundedNamePart(value, maxLength) {
  const normalized = String(value || '')
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (normalized.length <= maxLength) return normalized || 'x';
  return normalized.slice(0, maxLength).replace(/-+$/g, '') || normalized.slice(-maxLength);
}

function readIdempotencyKey(request) {
  const value = request.headers.get('Idempotency-Key');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function matchDeploymentId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/deployments\/([^/]+)$/);
  return match ? match[1] : null;
}

function matchRollbackVersionId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/versions\/([^/]+)\/rollback$/);
  return match ? match[1] : null;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateDeploySiteSlug(siteSlug, environment, { allowReserved = false } = {}) {
  const validation = validateSiteSlug(siteSlug, { environment });
  if (validation.ok) return null;
  if (validation.error.code === 'RESERVED_SLUG') {
    if (allowReserved) return null;
    return jsonError('SITE_SLUG_RESERVED', 'Site slug is reserved.', 400, RESERVED_SITE_SLUG_ACTION);
  }
  return jsonError(
    'SITE_SLUG_INVALID',
    'Site slug is invalid.',
    400,
    'Use 2-50 lowercase letters, numbers, and hyphens; the first and last characters must be alphanumeric.'
  );
}

function validateDeployableSiteSlug(siteSlug, environment) {
  return validateDeploySiteSlug(siteSlug, environment);
}

function siteNotFound(action) {
  return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, action);
}

function nextSiteUuid(env) {
  if (typeof env?.nextSiteUuid === 'function') {
    const id = env.nextSiteUuid();
    if (id) return id;
  }
  return newHexId();
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

async function readOptionalJsonBody(request, { maxBytes }) {
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) throw new Error('JSON body is too large');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object is required');
  return parsed;
}

function authErrorResponse(error) {
  return jsonError(error.code, error.message, error.status, error.action);
}

async function finishRequestAuthStage(handle, input) {
  if (!handle || handle.finished) return null;
  handle.finished = true;
  if (input?.status === 'failed') {
    await flushRequestTraceSuccesses(handle.trace);
    markRequestTraceFailed(handle.trace);
  }
  return finishDeploymentStage(handle, input);
}

async function finishValidatedRequestTrace(trace, authStage) {
  await flushRequestTraceSuccess(trace, 'intake');
  await finishRequestAuthStage(authStage, { status: 'succeeded' });
  await flushRequestTraceSuccess(trace, 'payload_validation');
}

function discardReplayRequestTrace(trace, authStage) {
  const state = trace ? deploymentRequestTraceStates.get(trace) : null;
  if (state?.pendingSuccesses) state.pendingSuccesses.length = 0;
  if (authStage) authStage.finished = true;
}

async function finishRequestAuthStageFromResponse(handle, response, causeClass) {
  let errorCode = 'AUTH_AND_SITE_RESOLUTION_FAILED';
  let errorMessage = 'Authentication or site resolution failed.';
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.code === 'string') errorCode = body.error.code;
    if (typeof body?.error?.message === 'string') errorMessage = body.error.message;
  } catch {
    // Keep the fixed safe fallback fields.
  }
  return finishRequestAuthStage(handle, {
    status: 'failed',
    errorCode,
    errorMessage,
    diagnostics: { causeClass },
  });
}

async function traceFailureResponse(trace, response, { stage, operation, errorCode, errorMessage, diagnostics }) {
  if (trace) {
    await flushRequestTraceSuccesses(trace);
    markRequestTraceFailed(trace);
    await recordDeploymentStage(trace, {
      stage,
      operation,
      status: 'failed',
      errorCode,
      errorMessage,
      diagnostics,
    });
  }
  return response;
}

function setRequestTraceStage(trace, stage, operation) {
  if (!trace) return;
  const current = deploymentRequestTraceStates.get(trace);
  deploymentRequestTraceStates.set(trace, {
    stage,
    operation,
    failed: current?.failed || false,
    pendingSuccesses: current?.pendingSuccesses || [],
  });
}

function queueRequestTraceSuccess(trace, stage, operation) {
  if (!trace) return;
  const current = deploymentRequestTraceStates.get(trace) || {
    stage: null,
    operation: null,
    failed: false,
    pendingSuccesses: [],
  };
  current.pendingSuccesses.push({
    stage,
    operation,
    handle: startDeploymentStage(trace, { stage, operation }),
  });
  deploymentRequestTraceStates.set(trace, current);
}

async function flushRequestTraceSuccesses(trace) {
  const current = trace ? deploymentRequestTraceStates.get(trace) : null;
  if (!current?.pendingSuccesses?.length) return;
  const pending = current.pendingSuccesses.splice(0);
  for (const item of pending) await finishDeploymentStage(item.handle, { status: 'succeeded' });
}

async function flushRequestTraceSuccess(trace, stage) {
  const current = trace ? deploymentRequestTraceStates.get(trace) : null;
  if (!current?.pendingSuccesses?.length) return;
  const matching = [];
  const remaining = [];
  for (const item of current.pendingSuccesses) {
    if (item.stage === stage) matching.push(item);
    else remaining.push(item);
  }
  current.pendingSuccesses = remaining;
  for (const item of matching) await finishDeploymentStage(item.handle, { status: 'succeeded' });
}

function clearRequestTraceStage(trace) {
  if (trace) deploymentRequestTraceStates.delete(trace);
}

function markRequestTraceFailed(trace) {
  if (!trace) return;
  const current = deploymentRequestTraceStates.get(trace);
  deploymentRequestTraceStates.set(trace, {
    stage: current?.stage || null,
    operation: current?.operation || null,
    failed: true,
    pendingSuccesses: current?.pendingSuccesses || [],
  });
}

async function ensureRequestFailureTraced(trace, response) {
  const state = trace ? deploymentRequestTraceStates.get(trace) : null;
  if (!state || state.failed || response.status < 400 || !state.stage) return response;

  let errorCode = 'DEPLOYMENT_REQUEST_FAILED';
  let errorMessage = 'Deployment request failed.';
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.code === 'string') errorCode = body.error.code;
    if (typeof body?.error?.message === 'string') errorMessage = body.error.message;
  } catch {
    // Keep the fixed safe fallback fields.
  }
  await flushRequestTraceSuccesses(trace);
  markRequestTraceFailed(trace);
  await recordDeploymentStage(trace, {
    stage: state.stage,
    operation: state.operation,
    status: 'failed',
    errorCode,
    errorMessage,
    diagnostics: { causeClass: 'request_stage_error' },
  });
  return response;
}

async function traceUnexpectedRequestFailure(trace, { fallbackStage, fallbackOperation }) {
  if (!trace) return;
  const state = deploymentRequestTraceStates.get(trace);
  if (state?.failed) return;
  await flushRequestTraceSuccesses(trace);
  markRequestTraceFailed(trace);
  await recordDeploymentStage(trace, {
    stage: state?.stage || fallbackStage,
    operation: state?.operation || fallbackOperation,
    status: 'failed',
    errorCode: 'DEPLOYMENT_REQUEST_FAILED',
    errorMessage: 'Deployment request could not be processed.',
    diagnostics: { causeClass: 'unexpected_orchestration_error' },
  });
}

async function recoverUnexpectedRequestFailure({ trace, store, env, config, ctx, actor, fallbackOperation }) {
  const deploymentId = trace?.deploymentId || null;
  try {
    await traceUnexpectedRequestFailure(trace, {
      fallbackStage: deploymentId ? 'deployment_operation' : 'intake',
      fallbackOperation,
    });
  } catch {
    // Trace persistence must not prevent best-effort terminal state recovery.
  }
  if (!deploymentId) return null;

  let deployment;
  try {
    deployment = await store.getDeployment(deploymentId, config.environment);
  } catch {
    logDeploymentStateWriteFailed(env, {
      traceId: trace.traceId,
      deploymentId,
      operation: 'persist_unexpected_deployment_failure',
    });
    return null;
  }
  if (!deployment || TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status)) return deployment || null;

  try {
    const reconciled = await reconcileCommittedDeployment(store, deployment, config.environment, env, trace);
    if (TERMINAL_DEPLOYMENT_STATUSES.has(reconciled?.status)) return reconciled;
  } catch {
    logDeploymentRepairRequired(env, {
      environment: config.environment,
      siteId: trace.siteId,
      deploymentId,
      reason: 'deployment_commit_reconciliation_failed',
    });
    return deployment;
  }

  let site = null;
  if (trace.siteId && typeof store.getSite === 'function') {
    try {
      site = await store.getSite(trace.siteId, config.environment);
      if (site && typeof store.getRouteBySiteId === 'function') {
        const route = await store.getRouteBySiteId(trace.siteId, config.environment);
        if (route) site = { ...site, route };
      }
    } catch {
      // Failure persistence is still useful when optional webhook context cannot be loaded.
    }
  }
  try {
    return await updateDeploymentToFailedAndNotify({
      store,
      env,
      config,
      ctx,
      deploymentId,
      patch: deploymentOperationFailurePatch({
        errorCode: 'DEPLOYMENT_REQUEST_FAILED',
        errorMessage: 'Deployment request could not be processed.',
        operatorAction: trace.operation === 'rollback' ? 'retry_rollback' : 'retry_deploy',
      }),
      actor,
      site,
      trace,
    });
  } catch (error) {
    if (error?.code !== 'DEPLOYMENT_STATE_WRITE_FAILED') throw error;
    return deployment;
  }
}

async function persistFailedDeploymentRecoveryMarker(env, config, input) {
  const markers = env?.ROUTE_SNAPSHOTS;
  if (!input.siteId || !input.deploymentId) return false;
  const marker = {
    schemaVersion: 1,
    environment: config.environment,
    siteId: input.siteId,
    deploymentId: input.deploymentId,
    operation: input.operation === 'rollback' ? 'rollback' : 'deploy',
    failedPatch: recoveryMarkerFailedPatch(input.failedPatch, env),
    createdAt: readNow(env),
  };
  const markerValue = JSON.stringify(marker);
  if (typeof markers?.put === 'function') {
    try {
      await markers.put(deploymentFailureRecoveryKey(config.environment, input.siteId, input.deploymentId), markerValue);
      return true;
    } catch {
      // RoutePointer durable state is the independent fallback when D1 and KV are unavailable together.
    }
  }
  try {
    return await writeDeploymentFailureRecoveryRecord(env, {
      environment: config.environment,
      hostname: input.siteHostname,
      deploymentId: input.deploymentId,
      value: markerValue,
    });
  } catch {
    return false;
  }
}

async function recoverFailedDeploymentsForSite({ store, env, config, ctx, actor, site }) {
  if (site.pendingSiteCreation) return;
  const { records: recoveryMarkers, readError } = await loadDeploymentFailureRecoveryMarkers(env, config, site);
  for (const recoveryMarker of recoveryMarkers) {
    const rawMarker = recoveryMarker.value;
    let marker;
    try {
      marker = parseDeploymentFailureRecoveryMarker(rawMarker, config.environment, site.id);
    } catch {
      marker = null;
    }
    if (!marker) {
      await recoveryMarker.delete();
      continue;
    }

    let deployment;
    try {
      deployment = await store.getDeployment(marker.deploymentId, config.environment);
    } catch (cause) {
      const error = new Error('Deployment state could not be read for recovery.', { cause });
      error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
      throw error;
    }
    if (!deployment || deployment.siteId !== site.id || TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status)) {
      await recoveryMarker.delete();
      continue;
    }

    let reconciled;
    try {
      reconciled = await reconcileCommittedDeployment(store, deployment, config.environment, env);
    } catch (cause) {
      const error = new Error('Deployment commit state could not be read for recovery.', { cause });
      error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
      throw error;
    }
    if (TERMINAL_DEPLOYMENT_STATUSES.has(reconciled?.status)) {
      let persisted;
      try {
        persisted = await store.getDeployment(marker.deploymentId, config.environment);
      } catch (cause) {
        const error = new Error('Reconciled deployment state could not be read.', { cause });
        error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
        throw error;
      }
      if (TERMINAL_DEPLOYMENT_STATUSES.has(persisted?.status)) {
        await recoveryMarker.delete();
        continue;
      }
      const error = new Error('Reconciled deployment state could not be persisted.');
      error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
      throw error;
    }

    const recoveryTrace = await traceForStoredDeployment(store, deployment, config.environment, env).catch(() => null);
    try {
      const recovered = await updateDeploymentToFailedAndNotify({
        store,
        env,
        config,
        ctx,
        deploymentId: marker.deploymentId,
        patch: marker.failedPatch,
        actor,
        site,
        trace: recoveryTrace,
      });
      if (!TERMINAL_DEPLOYMENT_STATUSES.has(recovered?.status)) continue;
      if (recoveryTrace) {
        await recordDeploymentStage(recoveryTrace, {
          stage: 'deployment_state_persist',
          operation: 'recover_failed_deployment_marker',
          status: 'compensated',
          diagnostics: {
            causeClass: 'deployment_store_recovery',
            operatorAction: marker.operation === 'rollback' ? 'retry_rollback' : 'retry_deploy',
          },
        });
      }
      await recoveryMarker.delete();
    } catch (error) {
      if (error?.code === 'DEPLOYMENT_STATE_WRITE_FAILED') throw error;
      logDeploymentRepairRequired(env, {
        environment: config.environment,
        siteId: site.id,
        deploymentId: marker.deploymentId,
        reason: 'deployment_failure_state_recovery_failed',
      });
    }
  }
  if (readError) throw readError;
}

async function loadDeploymentFailureRecoveryMarkers(env, config, site) {
  const records = [];
  let readError = null;
  const markers = env?.ROUTE_SNAPSHOTS;
  if (typeof markers?.list === 'function' && typeof markers?.get === 'function') {
    let markerKeys;
    try {
      markerKeys = await listDeploymentFailureRecoveryKeys(markers, config.environment, site.id);
    } catch (cause) {
      readError = deploymentRecoveryReadError('Deployment recovery markers could not be listed.', cause);
      markerKeys = [];
    }
    for (const markerKey of markerKeys) {
      let value;
      try {
        value = await markers.get(markerKey);
      } catch (cause) {
        readError ||= deploymentRecoveryReadError('Deployment recovery marker could not be read.', cause);
        continue;
      }
      records.push({
        value,
        delete: () => deleteDeploymentFailureRecoveryMarker(markers, markerKey),
      });
    }
  }

  let durableRecords;
  try {
    durableRecords = await listDeploymentFailureRecoveryRecords(env, {
      environment: config.environment,
      hostname: site.route?.hostname || site.hostname,
    });
  } catch (cause) {
    readError ||= deploymentRecoveryReadError('Durable deployment recovery markers could not be listed.', cause);
    durableRecords = [];
  }
  for (const record of durableRecords) {
    records.push({
      value: record?.value,
      delete: () =>
        deleteDeploymentFailureRecoveryRecordBestEffort(env, {
          environment: config.environment,
          hostname: site.route?.hostname || site.hostname,
          deploymentId: record?.deploymentId,
        }),
    });
  }
  return { records, readError };
}

function deploymentRecoveryReadError(message, cause) {
  const error = new Error(message, { cause });
  error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
  return error;
}

async function listDeploymentFailureRecoveryKeys(markers, environment, siteId) {
  const prefix = deploymentFailureRecoveryPrefix(environment, siteId);
  const keys = [];
  let cursor;
  let hasNextPage = true;
  while (hasNextPage) {
    const page = await markers.list(omitUndefined({ prefix, cursor }));
    for (const item of page?.keys || []) {
      if (typeof item?.name === 'string' && item.name.startsWith(prefix)) keys.push(item.name);
    }
    hasNextPage = page?.list_complete === false && Boolean(page.cursor);
    cursor = hasNextPage ? page.cursor : undefined;
  }
  return keys;
}

function deploymentFailureRecoveryPrefix(environment, siteId) {
  return `${environment}:${DEPLOYMENT_FAILURE_RECOVERY_KEY_PART}:${siteId}:`;
}

function deploymentFailureRecoveryKey(environment, siteId, deploymentId) {
  return `${deploymentFailureRecoveryPrefix(environment, siteId)}${deploymentId}`;
}

function recoveryMarkerFailedPatch(patch, env) {
  return omitUndefined({
    versionId: safeRecoveryMarkerId(patch?.versionId),
    previousVersionId: safeRecoveryMarkerId(patch?.previousVersionId),
    errorCode: safeRecoveryMarkerErrorCode(patch?.errorCode) || 'DEPLOYMENT_STATE_WRITE_FAILED',
    errorMessage: safeRecoveryMarkerMessage(patch?.errorMessage) || 'Deployment failure state required recovery.',
    failureStage: safeRecoveryMarkerIdentifier(patch?.failureStage) || 'persist_deployment_state',
    failureDiagnostics: safeRecoveryMarkerDiagnostics(patch?.failureDiagnostics),
    completedAt: safeRecoveryMarkerTimestamp(patch?.completedAt) || readNow(env),
  });
}

function parseDeploymentFailureRecoveryMarker(raw, environment, siteId) {
  if (typeof raw !== 'string' || raw.length > 32 * 1024) return null;
  const marker = JSON.parse(raw);
  if (
    !marker ||
    marker.schemaVersion !== 1 ||
    marker.environment !== environment ||
    marker.siteId !== siteId ||
    !safeRecoveryMarkerId(marker.deploymentId)
  ) {
    return null;
  }
  return {
    deploymentId: marker.deploymentId,
    operation: marker.operation === 'rollback' ? 'rollback' : 'deploy',
    failedPatch: recoveryMarkerFailedPatch(marker.failedPatch),
  };
}

function safeRecoveryMarkerId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

function safeRecoveryMarkerErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : undefined;
}

function safeRecoveryMarkerIdentifier(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : undefined;
}

function safeRecoveryMarkerMessage(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return undefined;
  return /(?:authorization|bearer|cookie|password|secret|token|https?:\/\/)/i.test(value) ? undefined : value;
}

function safeRecoveryMarkerDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 24 * 1024 ? JSON.parse(serialized) : undefined;
  } catch {
    return undefined;
  }
}

function safeRecoveryMarkerTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

async function deleteDeploymentFailureRecoveryMarker(markers, key) {
  if (typeof markers?.delete !== 'function') return;
  try {
    await markers.delete(key);
  } catch {
    // A retained marker is safe: the next request observes the terminal deployment and retries deletion.
  }
}

async function deleteDeploymentFailureRecoveryRecordBestEffort(env, input) {
  try {
    await deleteDeploymentFailureRecoveryRecord(env, input);
  } catch {
    // A retained durable marker is safe: the next request observes the terminal deployment and retries deletion.
  }
}

async function bindExistingDeploymentTrace(trace, store, deployment, environment) {
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

function withRequestTraceHeader(response, trace) {
  if (!trace) return response;
  return withDeploymentTraceHeader(response, response.headers.get('X-Deployment-Trace-Id') || trace.traceId);
}

function idempotencyKeyRequired() {
  return jsonError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.', 400, 'Send an Idempotency-Key header.');
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

function deploymentRequestFailed() {
  return jsonError(
    'DEPLOYMENT_REQUEST_FAILED',
    'Deployment request could not be processed.',
    500,
    'Check deployment status using the trace id. Retry with a new Idempotency-Key only when no terminal deployment exists.'
  );
}

function idempotencyConflict() {
  return jsonError(
    'IDEMPOTENCY_CONFLICT',
    'Idempotency-Key was already used with a different request.',
    409,
    'Retry with the original request or use a new Idempotency-Key.'
  );
}

function cliUploadProtocolRequired() {
  return jsonError(
    'CLI_UPLOAD_PROTOCOL_REQUIRED',
    'Deployment uploads must be generated by the XD Cell CLI.',
    400,
    'Run `xd-cell deploy` or `xd-cell deploy --dry-run --json` and retry.'
  );
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
