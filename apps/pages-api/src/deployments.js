import { validateSiteSlug } from '@xd/pages-runtime-protocol';

import { authenticateApiRequest } from './auth.js';
import { canonicalRequestHash, hashAccessKey, sha256HexForBytes } from './crypto.js';
import { jsonError, jsonOk } from './http.js';
import { newHexId, newId } from './id.js';
import { buildRouteSnapshot, writeRouteSnapshot } from './route-snapshot.js';
import { createDeploymentProvider, normalizeWorkerBundle } from './execution-provider.js';
import { normalizeRuntimeVars, runtimeConfigSnapshot, validateRuntimeBindingQuotas } from './runtime-config.js';
import { notifyDeploymentCapacityExhausted } from './slack-alerts.js';
import { actorCanManageSite, buildSiteOwnerTransferAuditEvent, hostnameForSlug, siteCreateErrorResponse } from './sites.js';
import { deliverWebhookEventToSubscriptions } from './webhooks.js';

const encoder = new globalThis.TextEncoder();
const utf8Decoder = new globalThis.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_DEPLOYMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DEPLOYMENT_METADATA_BYTES = 4 * 1024 * 1024;
const DEPLOYMENT_SHAPES = new Set(['assets-only', 'worker-only', 'worker-with-assets']);
const ROUTING_MODES = new Set(['assets-only', 'worker-only', 'worker-first']);
const FALLBACK_MODES = new Set(['auto', 'index', 'not-found', 'none', 'single-page-application', '404-page']);
const VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const DENYLISTED_BASENAMES = new Set(['.env', '.dev.vars', 'wrangler.toml', '.gitlab-ci.yml']);
const DENYLISTED_EXTENSIONS = new Set(['.pem', '.key']);
const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Cell 平台保留项，请换一个业务站点名。';
const CONTROL_ASSET_PATHS = new Set([
  '/_worker.js',
  '/_headers',
  '/_redirects',
  '/_routes.json',
  '/.assetsignore',
  '/pages.config.json',
  '/xd-cell.config.json',
]);

export async function handleDeploymentsApi(request, env, config, store, ctx) {
  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return authErrorResponse(auth.error);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/api/deployments') {
    if (request.method === 'POST') return createDeployment(request, env, config, store, auth.actor, ctx);
    return methodNotAllowed();
  }

  const deploymentId = matchDeploymentId(url.pathname);
  if (deploymentId && request.method === 'GET') return getDeployment(store, auth.actor, deploymentId, config.environment, env);
  if (deploymentId) return methodNotAllowed();

  return null;
}

export async function handleVersionsApi(request, env, config, store) {
  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return authErrorResponse(auth.error);

  const versionId = matchRollbackVersionId(new URL(request.url).pathname);
  if (versionId && request.method === 'POST') return rollbackVersion(request, env, config, store, auth.actor, versionId);
  if (versionId) return methodNotAllowed();

  return null;
}

async function createDeployment(request, env, config, store, actor, ctx) {
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return idempotencyKeyRequired();
  if (!isMultipartRequest(request)) return cliUploadProtocolRequired();

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
      return jsonError(
        'CONTENT_HASH_MISMATCH',
        'Content hash does not match uploaded files.',
        400,
        'Run xd-cell deploy --dry-run and retry.'
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
    if (error?.code === 'CLI_UPLOAD_PROTOCOL_REQUIRED') return cliUploadProtocolRequired();
    return jsonError('INVALID_MULTIPART', 'Invalid multipart body.', 400, 'Run xd-cell deploy --dry-run and retry.');
  }

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
  if (requestedVisibility && !VISIBILITIES.has(requestedVisibility)) {
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
    return jsonError(
      'CONTENT_HASH_MISMATCH',
      'Content hash does not match uploaded files.',
      400,
      'Run xd-cell deploy --dry-run and retry.'
    );
  }
  let site = await resolveDeploySite(store, actor, config, env, {
    siteId: requestedSiteId,
    siteSlug: requestedSiteSlug,
    teamId: requestedTeamId,
    visibility: requestedVisibility || 'org',
    requestedVisibility,
  });
  if (site instanceof Response) return site;
  let ownerTransfer = null;
  const routeSlugError = validateDeployableSiteSlug(site.slug, config.environment);
  if (routeSlugError) return routeSlugError;
  const siteId = site.id;
  if (!actorCanDeploy(actor, site, 'deploy:site')) {
    return jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use a token scoped to this site.');
  }
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
  const deploymentResult = await store.createDeploymentForIdempotency({
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
    visibility: site.pendingOwnerTransfer?.visibility || site.defaultVisibility,
    status: 'pending',
  });

  if (deploymentResult.kind === 'conflict') return idempotencyConflict();
  if (deploymentResult.kind === 'existing') {
    const reconciled = await reconcileCommittedDeployment(store, deploymentResult.deployment, config.environment, env);
    return jsonOk(await deploymentEnvelope(store, reconciled, {}, config.environment));
  }

  const deployment = deploymentResult.deployment;
  if (site.pendingSiteCreation) {
    const creationResult = await applyPendingDeploySiteCreation(store, site);
    if (creationResult instanceof Response) {
      await markDeploymentFailed(store, deployment.id, env, {
        errorCode: 'SITE_CREATE_FAILED',
        errorMessage: 'Site creation failed.',
      });
      return creationResult;
    }
    site = creationResult.site;
  }

  let runtimeSecrets = [];
  let originalRuntimeVarRecords = [];
  if (decisionRequiresWorker(decision)) {
    if (typeof store.listEnabledSiteSecrets !== 'function' || typeof store.listEnabledSiteVars !== 'function') {
      await markRuntimeConfigDeploymentFailed(store, deployment.id, env);
      return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime configuration is unavailable.', 503, 'Retry later.');
    }
    try {
      originalRuntimeVarRecords = await store.listEnabledSiteVars(config.environment, siteId);
      runtimeVarRecords = workerRuntimeVarsProvided ? siteVarRecordsFromObject(requestedRuntimeVars) : originalRuntimeVarRecords;
      runtimeVars = runtimeVarsFromRecords(runtimeVarRecords);
      runtimeSecrets = await store.listEnabledSiteSecrets(config.environment, siteId);
    } catch {
      await markRuntimeConfigDeploymentFailed(store, deployment.id, env);
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
    await markRuntimeConfigDeploymentFailed(store, deployment.id, env, {
      errorCode:
        error?.message === 'RUNTIME_BINDING_NAME_CONFLICT' ? 'RUNTIME_BINDING_NAME_CONFLICT' : 'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
      errorMessage: 'Runtime bindings are invalid.',
    });
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
    await markRuntimeConfigDeploymentFailed(store, deployment.id, env);
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
    await markRuntimeConfigDeploymentFailed(store, deployment.id, env, {
      errorCode:
        error?.message === 'RUNTIME_BINDING_NAME_CONFLICT' ? 'RUNTIME_BINDING_NAME_CONFLICT' : 'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
      errorMessage: 'Runtime bindings are invalid.',
    });
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
  let provider;
  try {
    provider = createDeploymentProvider(env, config, store, site);
  } catch {
    await store.updateDeployment(deployment.id, {
      status: 'failed',
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
  } catch {
    await markDeploymentStateWriteFailed(store, deployment.id, { env });
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
    await store.updateDeployment(deployment.id, {
      status: 'failed',
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
  let uploaded;
  try {
    uploaded = await provider.upload({
      site,
      workerName: plannedWorkerName,
      versionId,
      decision,
      contentHash: canonicalContentHash,
      artifactBundle,
      assetManifest,
      assetFiles,
      runtimeBindings,
    });
  } catch (error) {
    const code = publicProviderErrorCode(error, 'upload');
    await store.updateDeployment(deployment.id, {
      status: 'failed',
      errorCode: code,
      errorMessage: 'Deployment upload failed.',
      failureStage: 'upload_worker',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'upload_worker',
        executionProvider: provider.executionProvider || 'wfp',
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName,
        uploadCompleted: false,
        verifyCompleted: false,
        routePointerCommitted: false,
        cause: { code, class: 'provider_upload_error' },
      }),
      completedAt: readNow(env),
    });
    const status = code === 'DEPLOYMENT_CAPACITY_EXHAUSTED' ? 503 : 502;
    const action =
      code === 'DEPLOYMENT_CAPACITY_EXHAUSTED'
        ? 'Ask a Pages maintainer to expand platform deployment capacity.'
        : 'Retry the deployment with a new Idempotency-Key.';
    if (code === 'DEPLOYMENT_CAPACITY_EXHAUSTED') {
      await notifyDeploymentCapacityExhausted(env, config, { store });
    }
    return jsonError(code, 'Deployment upload failed.', status, action);
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
    await cleanupUploadedWorker(provider, uploaded);
    await store.updateDeployment(deployment.id, {
      status: 'failed',
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
  } catch {
    await cleanupUploadedWorker(provider, uploaded);
    await markDeploymentStateWriteFailed(store, deployment.id, { env });
    return deploymentStateWriteFailed();
  }
  try {
    await provider.verify({
      site,
      workerName,
      versionId,
      artifactRef: uploaded.artifactRef,
      ...uploaded,
    });
  } catch {
    await cleanupUploadedWorker(provider, uploaded);
    const code = publicProviderErrorCode(null, 'verify');
    await store.updateDeployment(deployment.id, {
      status: 'failed',
      errorCode: code,
      errorMessage: 'Deployment verification failed.',
      failureStage: 'verify_worker',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'verify_worker',
        executionProvider: uploaded.executionProvider || provider.executionProvider || 'wfp',
        deploymentShape: decision.deploymentShape,
        plannedVersionId: versionId,
        plannedWorkerName: workerName,
        uploadCompleted: true,
        verifyCompleted: false,
        routePointerCommitted: false,
        uploadedWorkerCleanup: 'attempted',
        cause: { code, class: 'provider_verify_error' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(code, 'Deployment verification failed.', 502, 'Retry the deployment with a new Idempotency-Key.');
  }

  if (workerRuntimeVarsProvided) {
    if (typeof store.replaceSiteVars !== 'function') {
      await cleanupUploadedWorker(provider, uploaded);
      await markRuntimeConfigDeploymentFailed(store, deployment.id, env);
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
      await cleanupUploadedWorker(provider, uploaded);
      await store.updateDeployment(deployment.id, {
        status: 'failed',
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
      await cleanupUploadedWorker(provider, uploaded);
      await markRuntimeConfigDeploymentFailed(store, deployment.id, env);
      return runtimeConfigUnavailable();
    }
  }
  const committedRuntimeVarRecords = runtimeVarRecords;

  let version;
  let previousRoute;
  let route;
  let ownerTransferRollbackSite = null;
  let ownerTransferApplied = false;
  try {
    await store.updateDeployment(deployment.id, { status: 'verified' });
    previousRoute = await store.getRouteBySiteId(siteId, config.environment);
    const preActivationRuntimeSnapshotError = decisionRequiresWorker(decision)
      ? await assertRuntimeConfigSnapshotUnchanged(store, config.environment, siteId, runtimeVarRecords, runtimeSecrets)
      : null;
    if (preActivationRuntimeSnapshotError) {
      await cleanupUploadedWorker(provider, uploaded);
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
      await store.updateDeployment(deployment.id, {
        status: 'failed',
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
        await cleanupUploadedWorker(provider, uploaded);
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
        await markDeploymentFailed(store, deployment.id, env, {
          errorCode: 'SITE_TRANSFER_FAILED',
          errorMessage: 'Site owner transfer failed.',
        });
        return transferResult;
      }
      ownerTransferApplied = true;
      site = transferResult.site;
      ownerTransfer = transferResult.ownerTransfer;
    }
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
    await store.updateDeployment(deployment.id, {
      status: 'activating',
      versionId: version.id,
    });
    route = await store.activateSiteVersion(
      siteId,
      {
        activeVersionId: version.id,
        workerName: version.workerName,
        runtime: version.runtime,
        executionProvider: version.executionProvider,
        dispatchType: version.dispatchType,
        dispatchBindingName: version.dispatchBindingName,
        slotId: version.slotId,
        visibility: site.defaultVisibility,
        updatedAt: readNow(env),
      },
      config.environment,
      previousRoute
    );
  } catch {
    await cleanupUploadedWorker(provider, uploaded);
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
    await restoreDeployOwnerTransferAfterFailure(store, {
      siteId,
      previousSite: ownerTransferRollbackSite,
      environment: config.environment,
      enabled: ownerTransferApplied,
    });
    await markDeploymentStateWriteFailed(store, deployment.id, { env, versionId: version?.id });
    return deploymentStateWriteFailed();
  }
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
      await cleanupUploadedWorker(provider, uploaded);
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
      await restoreDeployOwnerTransferAfterFailure(store, {
        siteId,
        previousSite: ownerTransferRollbackSite,
        environment: config.environment,
        enabled: ownerTransferApplied,
      });
      await store.updateDeployment(deployment.id, {
        status: 'failed',
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
    await cleanupUploadedWorker(provider, uploaded);
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
    await restoreDeployOwnerTransferAfterFailure(store, {
      siteId,
      previousSite: ownerTransferRollbackSite,
      environment: config.environment,
      enabled: ownerTransferApplied,
    });
    await store.updateDeployment(deployment.id, {
      status: 'failed',
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
  try {
    await writeSnapshot(env, store, { site, route, version });
  } catch {
    const restoredRoute = await restoreSiteRouteAfterSnapshotFailure(store, siteId, previousRoute, route, config.environment);
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
    const restoredSnapshotWritten = await writeRestoredRouteSnapshotAfterFailure(
      env,
      store,
      site,
      restoredRoute,
      config.environment
    );
    if (restoredSnapshotWritten) {
      await cleanupUploadedWorkerIfInactive(store, provider, uploaded, siteId, version.id, config.environment);
    }
    await store.updateDeployment(deployment.id, {
      status: 'failed',
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
        cause: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', class: 'route_snapshot_store_error' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      'ROUTE_SNAPSHOT_WRITE_FAILED',
      'Route snapshot could not be written.',
      503,
      'Retry the deployment with a new Idempotency-Key.'
    );
  }

  const completedAt = readNow(env);
  let completed;
  try {
    completed = await store.updateDeployment(deployment.id, {
      status: 'succeeded',
      versionId: version.id,
      completedAt,
    });
  } catch {
    completed = synthesizeSucceededDeployment(deployment, { versionId: version.id, completedAt });
  }

  await cleanupPreviousNormalWorkerSlot(provider, previousRoute, route, env);
  await enqueuePreviousWfpWorkerCleanup(store, env, config, previousRoute, route, completed);
  const webhookDelivery = emitDeploymentSucceededWebhook({ store, env, config, actor, site, route, deployment: completed });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(webhookDelivery);
  } else {
    await webhookDelivery;
  }

  return jsonOk(await deploymentEnvelope(store, completed, { version, route, decision, ownerTransfer }), 201);
}

async function emitDeploymentSucceededWebhook({ store, env, config, actor, site, route, deployment }) {
  try {
    const team =
      site.ownerType === 'team' && site.ownerId && typeof store.getTeam === 'function' ? await store.getTeam(site.ownerId) : null;
    await deliverWebhookEventToSubscriptions({
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
  } catch {
    // Webhook delivery is best-effort and must not mask a committed deployment.
  }
}

async function runtimeConfigHashInput(env, vars = {}, secrets = []) {
  return {
    vars: await Promise.all(
      Object.keys(vars)
        .sort()
        .map(async (name) => ({
          name,
          valueHash: await runtimeVarValueHash(env, name, vars[name]),
        }))
    ),
    secrets: secrets
      .map((secret) => ({
        name: secret.name,
        revision: secret.revision,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function runtimeSecretSnapshotRecords(env, secrets = []) {
  return Promise.all(
    secrets.map(async (secret) => ({
      ...secret,
      valueHash: await runtimeSecretValueHash(env, secret.name, secret.value),
    }))
  );
}

async function runtimeVarValueHash(env, name, value) {
  return hashAccessKey(`xd-pages-runtime-var-v1\0${name}\0${value}`, readRuntimeConfigHashPepper(env));
}

async function runtimeSecretValueHash(env, name, value) {
  return hashAccessKey(`xd-pages-runtime-secret-v1\0${name}\0${value}`, readRuntimeConfigHashPepper(env));
}

function readRuntimeConfigHashPepper(env) {
  const explicit = env.RUNTIME_CONFIG_HASH_PEPPER;
  if (typeof explicit === 'string' && explicit) return explicit;
  const activePepperId = String(env.ACCESS_KEY_ACTIVE_PEPPER_ID || '').trim();
  if (activePepperId) {
    const registry = String(env.ACCESS_KEY_PEPPERS || '').trim();
    for (const entry of registry.split(',')) {
      const [pepperId, secretEnvName] = entry.split(':').map((part) => part.trim());
      if (pepperId !== activePepperId || !secretEnvName) continue;
      const value = env[secretEnvName];
      if (typeof value === 'string' && value) return value;
    }
  }
  const requestHashPepper = env.REQUEST_HASH_PEPPER;
  if (typeof requestHashPepper === 'string' && requestHashPepper) return requestHashPepper;
  if (!activePepperId) {
    const registry = String(env.ACCESS_KEY_PEPPERS || '').trim();
    for (const entry of registry.split(',')) {
      const [, secretEnvName] = entry.split(':').map((part) => part.trim());
      if (!secretEnvName) continue;
      const value = env[secretEnvName];
      if (typeof value === 'string' && value) return value;
    }
  }
  throw new Error('RUNTIME_CONFIG_HASH_PEPPER_REQUIRED');
}

async function assertRuntimeConfigSnapshotUnchanged(store, environment, siteId, expectedVars, expectedSecrets) {
  let actualSecrets;
  let actualVars;
  try {
    actualVars = await store.listEnabledSiteVars(environment, siteId);
    actualSecrets = await store.listEnabledSiteSecrets(environment, siteId);
  } catch {
    return {
      code: 'RUNTIME_CONFIG_UNSUPPORTED',
      message: 'Runtime configuration is unavailable.',
      status: 503,
      action: 'Check runtime configuration and retry with a new Idempotency-Key.',
    };
  }
  if (runtimeVarSnapshotsEqual(expectedVars, actualVars) && runtimeSecretSnapshotsEqual(expectedSecrets, actualSecrets)) {
    return null;
  }
  return {
    code: 'RUNTIME_CONFIG_CHANGED',
    message: 'Runtime configuration changed while deployment was starting.',
    status: 409,
    action: 'Retry the deployment with a new Idempotency-Key.',
  };
}

function runtimeVarSnapshotsEqual(left = [], right = []) {
  const normalizedLeft = runtimeVarSnapshot(left);
  const normalizedRight = runtimeVarSnapshot(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((entry, index) => {
    const other = normalizedRight[index];
    return entry.name === other.name && entry.value === other.value && entry.revision === other.revision;
  });
}

function runtimeVarSnapshot(vars = []) {
  const records = Array.isArray(vars) ? vars : Object.keys(vars || {}).map((name) => ({ name, value: vars[name], revision: 0 }));
  return records
    .map((record) => ({
      name: record.name,
      value: record.value,
      revision: Number(record.revision || 0),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function runtimeSecretSnapshotsEqual(left = [], right = []) {
  const normalizedLeft = runtimeSecretSnapshot(left);
  const normalizedRight = runtimeSecretSnapshot(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((entry, index) => {
    const other = normalizedRight[index];
    return entry.name === other.name && entry.revision === other.revision;
  });
}

function siteVarRecordsFromObject(vars = {}) {
  return Object.keys(vars)
    .sort()
    .map((name) => ({ name, value: vars[name], revision: 0 }));
}

function runtimeVarsFromRecords(records = []) {
  return Object.fromEntries(records.map((record) => [record.name, record.value]));
}

async function restoreSiteVarsAfterFailedDeployment(
  store,
  { environment, siteId, restoreVars, expectedVars, actorId, updatedAt, createId, enabled } = {}
) {
  if (!enabled || typeof store.replaceSiteVars !== 'function') return;
  try {
    if (typeof store.listEnabledSiteVars === 'function') {
      const currentVars = await store.listEnabledSiteVars(environment, siteId);
      if (!runtimeVarSnapshotsEqual(currentVars, expectedVars)) return;
    }
    await store.replaceSiteVars({
      environment,
      siteId,
      vars: runtimeVarsFromRecords(restoreVars),
      actorId,
      updatedAt,
      createId,
    });
  } catch {
    // Best effort: the original deployment failure is still the user-facing error.
  }
}

function runtimeSecretSnapshot(secrets = []) {
  return secrets
    .map((secret) => ({
      name: secret.name,
      revision: Number(secret.revision || 0),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function isMultipartRequest(request) {
  const mediaType = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'multipart/form-data';
}

async function readMultipartDeploymentBody(request) {
  assertContentLengthWithinUploadLimit(request);
  const form = await request.formData();
  if (form.has('metadata')) return readPublishPlanMultipartBody(form);
  throwCoded('CLI_UPLOAD_PROTOCOL_REQUIRED');
}

async function readPublishPlanMultipartBody(form) {
  const { metadata, sizeBytes: metadataSizeBytes } = await parseSingleMetadata(form);
  if (metadata.schemaVersion !== 1) throwCoded('PUBLISH_PLAN_VERSION_UNSUPPORTED');

  const assetManifest = normalizePublishAssetManifest(metadata.assetManifest || []);
  const workerModules = normalizePublishWorkerModules(metadata.workerModules || []);
  const declaredParts = collectDeclaredPartNames(assetManifest, workerModules);
  const uploadedParts = await collectUploadedParts(form, metadataSizeBytes);
  validateUploadedParts(declaredParts, uploadedParts);
  await validateUploadedHashes({ assetManifest, workerModules, uploadedParts });
  const decision = normalizePublishPlanDecision({
    publishPlan: metadata.publishPlan,
    requestedFallback: metadata.requestedFallback,
    assetManifest,
    workerModules,
  });
  const workerRuntimeVarsProvided = decisionRequiresWorker(decision) && Object.prototype.hasOwnProperty.call(metadata, 'vars');

  return {
    siteId: metadata.siteId,
    siteSlug: metadata.siteSlug,
    teamId: metadata.teamId,
    visibility: metadata.visibility,
    source: typeof metadata.source === 'string' && metadata.source.trim() ? metadata.source.trim() : 'cli',
    contentHash: typeof metadata.contentHash === 'string' ? metadata.contentHash : '',
    decision,
    publishPlan: metadata.publishPlan,
    assetManifest: assetManifestObjectForProvider(assetManifest),
    assetFiles: await assetFilesForProvider(assetManifest, uploadedParts),
    artifactBundle: await artifactBundleForProvider(metadata, workerModules, uploadedParts),
    vars: workerRuntimeVarsProvided ? normalizePublishRuntimeVars(metadata.vars) : {},
    varsProvided: workerRuntimeVarsProvided,
  };
}

function normalizePublishRuntimeVars(value) {
  try {
    return normalizeRuntimeVars(value);
  } catch (error) {
    throwCoded(error?.message === 'RUNTIME_VARS_LIMIT_EXCEEDED' ? 'RUNTIME_VARS_LIMIT_EXCEEDED' : 'RUNTIME_VARS_INVALID');
  }
}

async function parseSingleMetadata(form) {
  const values = form.getAll('metadata');
  if (values.length !== 1) throwCoded('PUBLISH_PLAN_INVALID');
  const value = values[0];
  let text;
  let sizeBytes;
  if (value instanceof File) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    sizeBytes = bytes.byteLength;
    if (sizeBytes > MAX_DEPLOYMENT_METADATA_BYTES || sizeBytes > MAX_DEPLOYMENT_UPLOAD_BYTES) {
      throwCoded('PAYLOAD_TOO_LARGE');
    }
    text = decodeUtf8(bytes);
  } else if (typeof value === 'string') {
    text = value;
    sizeBytes = encoder.encode(value).byteLength;
    if (sizeBytes > MAX_DEPLOYMENT_METADATA_BYTES || sizeBytes > MAX_DEPLOYMENT_UPLOAD_BYTES) {
      throwCoded('PAYLOAD_TOO_LARGE');
    }
  } else throwCoded('PUBLISH_PLAN_INVALID');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return { metadata: parsed, sizeBytes };
  } catch {
    throwCoded('PUBLISH_PLAN_INVALID');
  }
}

function normalizePublishAssetManifest(value) {
  if (!Array.isArray(value)) throwCoded('ASSET_MANIFEST_INVALID');
  const paths = new Set();
  const partNames = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throwCoded('ASSET_MANIFEST_INVALID');
    const path = normalizeManifestAssetPath(entry.path);
    const partName = normalizePartName(entry.partName);
    if (paths.has(path) || partNames.has(partName)) throwCoded('PUBLISH_PLAN_INVALID');
    paths.add(path);
    partNames.add(partName);
    validateAssetPath(path);
    if (CONTROL_ASSET_PATHS.has(path)) throwCoded('ASSET_MANIFEST_INVALID');
    if (denylistCodeForAssetPath(path)) throwCoded('ASSET_MANIFEST_INVALID');
    if (!isShortHash(entry.hash)) throwCoded('ASSET_MANIFEST_INVALID');
    if (!Number.isFinite(Number(entry.size)) || Number(entry.size) < 0) throwCoded('ASSET_MANIFEST_INVALID');
    return {
      path,
      partName,
      hash: entry.hash,
      size: Number(entry.size),
      contentType: normalizeContentType(entry.contentType) || 'application/octet-stream',
    };
  });
}

function normalizePublishWorkerModules(value) {
  if (!Array.isArray(value)) throwCoded('PUBLISH_PLAN_INVALID');
  const moduleNames = new Set();
  const partNames = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throwCoded('PUBLISH_PLAN_INVALID');
    const moduleName = normalizeModuleName(entry.moduleName);
    const partName = normalizePartName(entry.partName);
    if (moduleNames.has(moduleName) || partNames.has(partName)) throwCoded('PUBLISH_PLAN_INVALID');
    moduleNames.add(moduleName);
    partNames.add(partName);
    if (!isShortHash(entry.hash)) throwCoded('PUBLISH_PLAN_INVALID');
    if (!Number.isFinite(Number(entry.size)) || Number(entry.size) < 0) throwCoded('PUBLISH_PLAN_INVALID');
    return {
      moduleName,
      partName,
      hash: entry.hash,
      size: Number(entry.size),
      contentType: normalizeContentType(entry.contentType) || 'application/javascript+module',
    };
  });
}

async function validateUploadedHashes({ assetManifest, workerModules, uploadedParts }) {
  for (const asset of assetManifest) {
    const uploaded = uploadedParts.get(asset.partName);
    if (!uploaded) throwCoded('ASSET_FILES_REQUIRED');
    if (uploaded.bytes.byteLength !== asset.size) throwCoded('ASSET_MANIFEST_INVALID');
    const actualHash = await hashUploadedAsset(uploaded.bytes, asset.contentType);
    if (actualHash !== asset.hash) throwCoded('ASSET_MANIFEST_INVALID');
  }
  for (const module of workerModules) {
    const uploaded = uploadedParts.get(module.partName);
    if (!uploaded) throwCoded('PUBLISH_PLAN_INVALID');
    if (uploaded.bytes.byteLength !== module.size) throwCoded('PUBLISH_PLAN_INVALID');
    const actualHash = await hashUploadedAsset(uploaded.bytes, module.contentType);
    if (actualHash !== module.hash) throwCoded('PUBLISH_PLAN_INVALID');
  }
}

function collectDeclaredPartNames(assetManifest, workerModules) {
  const parts = new Map();
  for (const asset of assetManifest) {
    if (parts.has(asset.partName)) throwCoded('PUBLISH_PLAN_INVALID');
    parts.set(asset.partName, { partType: 'asset', entry: asset });
  }
  for (const module of workerModules) {
    if (parts.has(module.partName)) throwCoded('PUBLISH_PLAN_INVALID');
    parts.set(module.partName, { partType: 'worker', entry: module });
  }
  return parts;
}

async function collectUploadedParts(form, initialSize = 0) {
  const uploaded = new Map();
  let totalSize = initialSize;
  for (const [key, value] of form.entries()) {
    if (key === 'metadata') continue;
    if (!(value instanceof File)) throwCoded('PUBLISH_PLAN_INVALID');
    if (uploaded.has(key)) throwCoded('PUBLISH_PLAN_INVALID');
    const bytes = new Uint8Array(await value.arrayBuffer());
    totalSize += bytes.byteLength;
    if (totalSize > MAX_DEPLOYMENT_UPLOAD_BYTES) throwCoded('PAYLOAD_TOO_LARGE');
    uploaded.set(key, {
      file: value,
      bytes,
      contentType: value.type || 'application/octet-stream',
    });
  }
  return uploaded;
}

function validateUploadedParts(declaredParts, uploadedParts) {
  for (const name of uploadedParts.keys()) {
    if (!declaredParts.has(name)) throwCoded('PUBLISH_PLAN_INVALID');
  }
  for (const name of declaredParts.keys()) {
    if (!uploadedParts.has(name)) throwCoded('ASSET_FILES_REQUIRED');
  }
}

function normalizePublishPlanDecision({ publishPlan, requestedFallback, assetManifest, workerModules }) {
  if (!publishPlan || typeof publishPlan !== 'object' || Array.isArray(publishPlan)) throwCoded('PUBLISH_PLAN_INVALID');
  const deploymentShape = normalizeEnum(publishPlan.deploymentShape, DEPLOYMENT_SHAPES);
  const requested = normalizeEnum(publishPlan.requestedFallback || requestedFallback || 'auto', FALLBACK_MODES);
  const metadataRequested = requestedFallback === undefined ? requested : normalizeEnum(requestedFallback, FALLBACK_MODES);
  if (metadataRequested !== requested) throwCoded('PUBLISH_PLAN_INVALID');

  const hasAssets = assetManifest.length > 0;
  const hasWorker = workerModules.length > 0;
  const payloadShape = payloadShapeForParts({ hasAssets, hasWorker });
  if (!payloadShape || payloadShape !== deploymentShape) throwCoded('PUBLISH_PLAN_INVALID');

  const expectedRoutingMode =
    deploymentShape === 'worker-with-assets' ? 'worker-first' : deploymentShape === 'worker-only' ? 'worker-only' : 'assets-only';
  if (!ROUTING_MODES.has(publishPlan.routingMode) || publishPlan.routingMode !== expectedRoutingMode) {
    throwCoded('PUBLISH_PLAN_INVALID');
  }

  if (deploymentShape === 'worker-only') {
    if (!['auto', 'none'].includes(requested) || publishPlan.resolvedFallback !== null) throwCoded('FALLBACK_REQUIRES_ASSETS');
  } else if (!['index', 'not-found', 'none'].includes(publishPlan.resolvedFallback)) {
    throwCoded('PUBLISH_PLAN_INVALID');
  }
  if (publishPlan.resolvedFallback === 'index' && !assetManifest.some((asset) => asset.path === '/index.html')) {
    throwCoded('FALLBACK_INDEX_REQUIRES_INDEX_HTML');
  }

  const workerEntry =
    deploymentShape === 'assets-only'
      ? null
      : normalizeModuleName(publishPlan.workerMainModuleName || publishPlan.workerEntry || '');
  if (deploymentShape === 'assets-only' && (publishPlan.workerEntry || publishPlan.workerMainModuleName)) {
    throwCoded('PUBLISH_PLAN_INVALID');
  }
  if (workerEntry && !workerModules.some((module) => module.moduleName === workerEntry)) throwCoded('PUBLISH_PLAN_INVALID');

  const expectedNotFoundHandling =
    publishPlan.resolvedFallback === 'index'
      ? 'single-page-application'
      : publishPlan.resolvedFallback === 'not-found'
        ? '404-page'
        : 'none';
  const assetsConfig = deploymentShape === 'worker-only' ? null : { notFoundHandling: expectedNotFoundHandling };
  if (publishPlan.assetsConfig?.notFoundHandling && publishPlan.assetsConfig.notFoundHandling !== expectedNotFoundHandling) {
    throwCoded('PUBLISH_PLAN_INVALID');
  }

  return {
    deploymentShape,
    requestedFallback: requested,
    resolvedFallback: deploymentShape === 'worker-only' ? null : publishPlan.resolvedFallback,
    routingMode: publishPlan.routingMode,
    workerEntry,
    assetsConfig,
  };
}

function assetManifestObjectForProvider(assetManifest) {
  if (assetManifest.length === 0) return undefined;
  return Object.fromEntries(
    assetManifest.map((asset) => [
      asset.path,
      {
        hash: asset.hash,
        size: asset.size,
        content_type: asset.contentType,
      },
    ])
  );
}

function payloadShapeForParts({ hasAssets, hasWorker }) {
  if (hasAssets && hasWorker) return 'worker-with-assets';
  if (hasWorker) return 'worker-only';
  if (hasAssets) return 'assets-only';
  return null;
}

async function assetFilesForProvider(assetManifest, uploadedParts) {
  const files = [];
  for (const asset of assetManifest) {
    const uploaded = uploadedParts.get(asset.partName);
    if (!uploaded) throwCoded('ASSET_FILES_REQUIRED');
    if (uploaded.bytes.byteLength !== asset.size) throwCoded('ASSET_MANIFEST_INVALID');
    files.push({
      path: asset.path,
      bytes: uploaded.bytes,
      contentType: asset.contentType || uploaded.contentType,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function artifactBundleForProvider(metadata, workerModules, uploadedParts) {
  if (workerModules.length === 0) return undefined;
  const mainModule = normalizeModuleName(
    metadata.workerMainModuleName || metadata.publishPlan?.workerMainModuleName || metadata.publishPlan?.workerEntry
  );
  if (!workerModules.some((module) => module.moduleName === mainModule)) throwCoded('PUBLISH_PLAN_INVALID');
  const modules = [];
  for (const module of workerModules) {
    const uploaded = uploadedParts.get(module.partName);
    if (!uploaded) throwCoded('PUBLISH_PLAN_INVALID');
    if (uploaded.bytes.byteLength !== module.size) throwCoded('PUBLISH_PLAN_INVALID');
    modules.push({
      name: module.moduleName,
      content: decodeUtf8(uploaded.bytes),
      type: module.contentType || uploaded.contentType || 'application/javascript+module',
    });
  }
  return {
    mainModule,
    modules,
  };
}

function assertContentLengthWithinUploadLimit(request) {
  const raw = request.headers.get('Content-Length');
  if (!raw) return;
  const contentLength = Number(raw);
  if (Number.isFinite(contentLength) && contentLength > MAX_DEPLOYMENT_UPLOAD_BYTES + MAX_DEPLOYMENT_METADATA_BYTES) {
    throwCoded('PAYLOAD_TOO_LARGE');
  }
}

function decodeUtf8(bytes) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throwCoded('PUBLISH_PLAN_INVALID');
  }
}

async function canonicalDeploymentContentHash({ decision, assetFiles = [], artifactBundle }) {
  if (!decision || !DEPLOYMENT_SHAPES.has(decision.deploymentShape)) throwCoded('PUBLISH_PLAN_INVALID');
  const files = [];
  for (const file of assetFiles || []) {
    files.push({
      relativePath: file.path.replace(/^\/+/, ''),
      contentType: file.contentType || 'application/octet-stream',
      bytes: file.bytes,
    });
  }
  for (const module of artifactBundle?.modules || []) {
    files.push({
      relativePath: module.name,
      contentType: module.type || 'application/javascript+module',
      bytes: encoder.encode(module.content),
    });
  }

  const chunks = ['xd-pages-upload-plan-v1\0', JSON.stringify(publishPlanFromDecision(decision)), '\0'];
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    chunks.push('file\0', file.relativePath, '\0', String(file.bytes.byteLength), '\0', file.contentType, '\0');
    chunks.push(file.bytes);
    chunks.push('\0');
  }
  return `sha256:${await sha256HexForBytes(concatHashChunks(chunks))}`;
}

function publishPlanFromDecision(decision) {
  return {
    deploymentShape: decision.deploymentShape,
    requestedFallback: decision.requestedFallback,
    resolvedFallback: decision.resolvedFallback,
    routingMode: decision.routingMode,
    workerEntry: decision.workerEntry,
    workerMainModuleName: decision.workerEntry,
    assetsConfig: assetsConfigForDecisionHash(decision),
  };
}

function assetsConfigForDecisionHash(decision) {
  if (decision.deploymentShape === 'worker-only') return null;
  return {
    notFoundHandling:
      decision.resolvedFallback === 'index'
        ? 'single-page-application'
        : decision.resolvedFallback === 'not-found'
          ? '404-page'
          : 'none',
  };
}

async function hashUploadedAsset(bytes, contentType) {
  return (
    await sha256HexForBytes(concatHashChunks(['xd-pages-asset-v2\0', contentType || 'application/octet-stream', '\0', bytes]))
  ).slice(0, 32);
}

function concatHashChunks(chunks) {
  const encoded = chunks.map((chunk) => (chunk instanceof Uint8Array ? chunk : encoder.encode(String(chunk))));
  const totalLength = encoded.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of encoded) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isShortHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function validateAssetFiles(manifest, files) {
  const filesByPath = new Map();
  for (const file of files) {
    const entry = manifest[file.path];
    if (!entry) return 'ASSET_MANIFEST_INVALID';
    if (Number(entry.size) !== file.bytes.byteLength) return 'ASSET_MANIFEST_INVALID';
    filesByPath.set(file.path, file);
  }
  for (const path of Object.keys(manifest)) {
    if (!filesByPath.has(path)) return 'ASSET_FILES_REQUIRED';
  }
  return null;
}

function validateAssetPath(path) {
  const parts = String(path || '').split('/');
  if (!path || !path.startsWith('/') || path.includes('\0') || parts.includes('..')) throwAssetManifestInvalid();
}

function denylistCodeForAssetPath(assetPath) {
  const normalized = String(assetPath || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');
  const basename = normalized.split('/').at(-1) || '';
  const comparable = normalized.toLowerCase();
  const comparableBasename = basename.toLowerCase();
  const extension = basename.includes('.') ? `.${basename.split('.').at(-1).toLowerCase()}` : '';
  if (DENYLISTED_BASENAMES.has(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (/^\.env(\.|$)/.test(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (/^\.dev\.vars(\.|$)/.test(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (/^wrangler(\..*)?\.toml$/.test(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (DENYLISTED_EXTENSIONS.has(extension)) return 'PACKAGE_DENYLISTED_FILE';
  if (comparable === '.github' || comparable.startsWith('.github/')) return 'PACKAGE_DENYLISTED_FILE';
  return null;
}

function normalizeManifestAssetPath(value) {
  const path = normalizeAssetPath(value);
  if (path === '/') throwCoded('ASSET_MANIFEST_INVALID');
  return path;
}

function normalizeModuleName(value) {
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
  const parts = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || parts.includes('..')) {
    throwCoded('PUBLISH_PLAN_INVALID');
  }
  return normalized;
}

function normalizePartName(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.includes('\0') || normalized.length > 128) throwCoded('PUBLISH_PLAN_INVALID');
  return normalized;
}

function normalizeContentType(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEnum(value, values) {
  if (typeof value !== 'string' || !values.has(value)) throwCoded('PUBLISH_PLAN_INVALID');
  return value;
}

function decisionRequiresWorker(decision) {
  return decision?.deploymentShape === 'worker-only' || decision?.deploymentShape === 'worker-with-assets';
}

function decisionRequiresAssets(decision) {
  return decision?.deploymentShape === 'assets-only' || decision?.deploymentShape === 'worker-with-assets';
}

function throwCoded(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function throwAssetManifestInvalid() {
  const error = new Error('ASSET_MANIFEST_INVALID');
  error.code = 'ASSET_MANIFEST_INVALID';
  throw error;
}

function normalizeAssetPath(value) {
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');
  return `/${normalized}`;
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

async function rollbackVersion(request, env, config, store, actor, versionId) {
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return idempotencyKeyRequired();

  let body;
  try {
    body = await readOptionalJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const version = await store.getSiteVersion(versionId, config.environment);
  if (!version) return jsonError('VERSION_NOT_FOUND', 'Version not found.', 404, 'Check the version id.');
  const requestedSiteError = await validateRequestedRollbackSite(store, version, body, config.environment);
  if (requestedSiteError) return requestedSiteError;
  const site = await store.getSiteForUser(version.siteId, actor.userId, actor, config.environment);
  if (!site || !actorCanDeploy(actor, site, 'rollback:site')) {
    return jsonError('ROLLBACK_FORBIDDEN', 'Actor cannot rollback this site.', 403, 'Use a token scoped to this site.');
  }

  const versionAvailabilityError = await validateRollbackVersion(store, version, config.environment);
  if (versionAvailabilityError) return versionAvailabilityError;
  const currentRoute = await store.getRouteBySiteId(site.id, config.environment);
  const requestHash = await canonicalRequestHash({
    operation: 'rollback',
    versionId,
    siteId: body.siteId || null,
    siteSlug: body.siteSlug || null,
  });
  const deploymentResult = await store.createDeploymentForIdempotency({
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
    visibility: currentRoute.visibility,
    status: 'pending',
    versionId,
    previousVersionId: currentRoute.activeVersionId,
  });

  if (deploymentResult.kind === 'conflict') return idempotencyConflict();
  if (deploymentResult.kind === 'existing') {
    const reconciled = await reconcileCommittedDeployment(store, deploymentResult.deployment, config.environment, env);
    return jsonOk(await deploymentEnvelope(store, reconciled, {}, config.environment));
  }

  const route = await store.activateSiteVersion(
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
      updatedAt: readNow(env),
    },
    config.environment,
    currentRoute
  );
  if (!route) {
    const latestVersion = await store.getSiteVersion(version.id, config.environment);
    if (latestVersion?.artifactAvailability !== 'active') {
      await store.updateDeployment(deploymentResult.deployment.id, {
        status: 'failed',
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
    await store.updateDeployment(deploymentResult.deployment.id, {
      status: 'failed',
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
  try {
    await writeSnapshot(env, store, { site, route, version });
  } catch {
    const restoredRoute = await restoreSiteRouteAfterSnapshotFailure(store, site.id, currentRoute, route, config.environment);
    await writeRestoredRouteSnapshotAfterFailure(env, store, site, restoredRoute, config.environment);
    await store.updateDeployment(deploymentResult.deployment.id, {
      status: 'failed',
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
      errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
      errorMessage: 'Route snapshot write failed.',
      failureStage: 'rollback_write_route_snapshot',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'rollback_write_route_snapshot',
        executionProvider: version.executionProvider || 'wfp',
        deploymentShape: version.deploymentShape,
        plannedVersionId: version.id,
        plannedWorkerName: version.workerName,
        routeActivatedInD1: true,
        routePointerCommitted: false,
        previousRouteRestored: Boolean(restoredRoute),
        cause: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', class: 'route_snapshot_store_error' },
      }),
      completedAt: readNow(env),
    });
    return jsonError(
      'ROUTE_SNAPSHOT_WRITE_FAILED',
      'Route snapshot could not be written.',
      503,
      'Retry the rollback with a new Idempotency-Key.'
    );
  }

  const completedAt = readNow(env);
  let completed;
  try {
    completed = await store.updateDeployment(deploymentResult.deployment.id, {
      status: 'succeeded',
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
      completedAt,
    });
  } catch {
    completed = synthesizeSucceededDeployment(deploymentResult.deployment, {
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
      completedAt,
    });
  }

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

async function applyPendingDeploySiteCreation(store, site) {
  try {
    const created = await store.createSite({
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
    });
    return {
      site: {
        ...created,
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
  await writeRouteSnapshot(env, buildRouteSnapshot({ ...input, site, aclEntries }));
}

async function restoreSiteRouteAfterSnapshotFailure(store, siteId, previousRoute, expectedRoute, environment) {
  if (typeof store.restoreSiteRouteIfCurrent === 'function') {
    return store.restoreSiteRouteIfCurrent(siteId, previousRoute, expectedRoute, environment);
  }
  return store.restoreSiteRoute(siteId, previousRoute, environment);
}

async function writeRestoredRouteSnapshotAfterFailure(env, store, site, route, environment) {
  if (!route) return false;
  const version = route.activeVersionId
    ? await store.getSiteVersion(route.activeVersionId, environment)
    : inactiveRouteVersion(route);
  if (!version && route.routeStatus === 'active') return false;
  try {
    await writeSnapshot(env, store, { site, route, version });
    return true;
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
  if (typeof provider?.delete !== 'function') return;
  try {
    await provider.delete(uploaded);
  } catch {
    // Best-effort cleanup must not hide the original deployment failure.
  }
}

async function cleanupUploadedWorkerIfInactive(store, provider, uploaded, siteId, versionId, environment) {
  const route = await store.getRouteBySiteId(siteId, environment);
  if (routeReferencesUploadedWorker(route, uploaded, versionId)) return;
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
  if (typeof provider?.cleanupRetainedSlot !== 'function') return;
  if (previousRoute?.executionProvider !== 'normal-worker-slot') return;
  if (!previousRoute.slotId || !previousRoute.activeVersionId) return;
  if (previousRoute.slotId === activeRoute?.slotId) return;
  try {
    await provider.cleanupRetainedSlot({
      slotId: previousRoute.slotId,
      versionId: previousRoute.activeVersionId,
      activeSlotId: activeRoute?.slotId || null,
      updatedAt: readNow(env),
    });
  } catch {
    // Slot cleanup is a capacity optimization. It must fail closed without changing the successful route commit.
  }
}

async function enqueuePreviousWfpWorkerCleanup(store, env, config, previousRoute, activeRoute, deployment) {
  if (typeof store.createDeploymentResourceCleanupTask !== 'function') return;
  if (!previousRoute || previousRoute.routeStatus !== 'active') return;
  if (previousRoute.executionProvider !== 'wfp' && previousRoute.dispatchType !== 'dispatch-namespace') return;
  if (!previousRoute.workerName || !previousRoute.activeVersionId) return;
  if (previousRoute.workerName === activeRoute?.workerName || previousRoute.activeVersionId === activeRoute?.activeVersionId)
    return;
  if (!isManagedWfpWorkerName(previousRoute.workerName, config.environment)) return;

  try {
    await store.createDeploymentResourceCleanupTask({
      id: nextId(env, 'cln'),
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
  } catch {
    // Cleanup is post-commit maintenance. A successful route cutover must stay successful if task enqueueing fails.
  }
}

function cleanupAfterDrainWindow(env) {
  const now = Date.parse(readNow(env));
  const configured = Number(env?.WFP_WORKER_CLEANUP_DRAIN_SECONDS || env?.WFP_CLEANUP_DRAIN_SECONDS || 300);
  const seconds = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 24 * 60 * 60) : 300;
  return new Date(now + seconds * 1000).toISOString();
}

function isManagedWfpWorkerName(workerName, environment) {
  if (typeof workerName !== 'string') return false;
  if (environment === 'staging') return workerName.startsWith('pages-v2-staging-');
  return workerName.startsWith('pages-v2-') && !workerName.startsWith('pages-v2-staging-');
}

async function reconcileCommittedDeployment(store, deployment, environment, env) {
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
  try {
    return (await store.updateDeployment(deployment.id, patch)) || synthesizeSucceededDeployment(deployment, patch);
  } catch {
    return synthesizeSucceededDeployment(deployment, patch);
  }
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
  previousRouteRestored,
  uploadedWorkerCleanup,
  trafficImpact = 'old_version_retained',
  retryable = true,
  operatorAction = 'retry_deploy',
  cause,
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
    previousRouteRestored,
    uploadedWorkerCleanup,
    trafficImpact,
    retryable,
    operatorAction,
    cause,
  });
}

function omitUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

async function markDeploymentStateWriteFailed(store, deploymentId, { env, versionId = null } = {}) {
  try {
    await store.updateDeployment(deploymentId, {
      status: 'failed',
      versionId,
      errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
      errorMessage: 'Deployment state could not be persisted.',
      failureStage: 'persist_deployment_state',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'persist_deployment_state',
        executionProvider: 'unknown',
        plannedVersionId: versionId,
        routePointerCommitted: false,
        cause: { code: 'DEPLOYMENT_STATE_WRITE_FAILED', class: 'deployment_store_error' },
      }),
      completedAt: readNow(env || {}),
    });
  } catch {
    // Best-effort status update after a persistence failure.
  }
}

async function markDeploymentFailed(store, deploymentId, env, { errorCode, errorMessage }) {
  try {
    await store.updateDeployment(deploymentId, {
      status: 'failed',
      errorCode,
      errorMessage,
      failureStage: 'deployment_operation',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'deployment_operation',
        executionProvider: 'unknown',
        cause: { code: errorCode, class: 'deployment_operation_error' },
      }),
      completedAt: readNow(env || {}),
    });
  } catch {
    // Best-effort status update after a deployment-side failure.
  }
}

async function markRuntimeConfigDeploymentFailed(
  store,
  deploymentId,
  env,
  { errorCode = 'RUNTIME_CONFIG_UNSUPPORTED', errorMessage = 'Runtime configuration is unavailable.' } = {}
) {
  try {
    await store.updateDeployment(deploymentId, {
      status: 'failed',
      errorCode,
      errorMessage,
      failureStage: 'runtime_config',
      failureDiagnostics: buildDeploymentFailureDiagnostics({
        stage: 'runtime_config',
        executionProvider: 'unknown',
        cause: { code: errorCode, class: 'runtime_config_error' },
      }),
      completedAt: readNow(env || {}),
    });
  } catch {
    // Best-effort status update after a runtime config failure.
  }
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

function publicProviderErrorCode(error, step) {
  if (error?.code === 'SLOT_CAPACITY_EXHAUSTED') return 'DEPLOYMENT_CAPACITY_EXHAUSTED';
  return step === 'upload' ? 'DEPLOYMENT_UPLOAD_FAILED' : 'DEPLOYMENT_VERIFY_FAILED';
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

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  return newId(prefix);
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

function idempotencyKeyRequired() {
  return jsonError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.', 400, 'Send an Idempotency-Key header.');
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
