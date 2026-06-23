import { validateSiteSlug } from '@xd/pages-runtime-protocol';

import { authenticateApiRequest } from './auth.js';
import { canonicalRequestHash, sha256HexForBytes } from './crypto.js';
import { jsonError, jsonOk } from './http.js';
import { newId } from './id.js';
import { buildRouteSnapshot, writeRouteSnapshot } from './route-snapshot.js';
import { createDeploymentProvider, normalizeWorkerBundle } from './execution-provider.js';
import { notifyDeploymentCapacityExhausted } from './slack-alerts.js';

const encoder = new globalThis.TextEncoder();
const utf8Decoder = new globalThis.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_DEPLOYMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DEPLOYMENT_METADATA_BYTES = 4 * 1024 * 1024;
const DEPLOYMENT_SHAPES = new Set(['assets-only', 'worker-only', 'worker-with-assets']);
const ROUTING_MODES = new Set(['assets-only', 'worker-only', 'worker-first']);
const FALLBACK_MODES = new Set(['auto', 'index', 'not-found']);
const DENYLISTED_BASENAMES = new Set(['.env', '.dev.vars', 'wrangler.toml', '.gitlab-ci.yml']);
const DENYLISTED_EXTENSIONS = new Set(['.pem', '.key']);
const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Pages 平台保留项，请换一个业务站点名。';
const CONTROL_ASSET_PATHS = new Set([
  '/_worker.js',
  '/_headers',
  '/_redirects',
  '/_routes.json',
  '/.assetsignore',
  '/pages.config.json',
]);

export async function handleDeploymentsApi(request, env, config, store) {
  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return authErrorResponse(auth.error);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/api/deployments') {
    if (request.method === 'POST') return createDeployment(request, env, config, store, auth.actor);
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

async function createDeployment(request, env, config, store, actor) {
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
        'Upload index.html or use --fallback not-found.'
      );
    }
    if (error?.code === 'PUBLISH_PLAN_VERSION_UNSUPPORTED') {
      return jsonError(
        'PUBLISH_PLAN_VERSION_UNSUPPORTED',
        'Publish plan version is unsupported.',
        400,
        'Upgrade the XD Pages CLI and retry.'
      );
    }
    if (error?.code === 'PUBLISH_PLAN_INVALID') {
      return jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run pages deploy --dry-run and retry.');
    }
    if (error?.code === 'CONTENT_HASH_MISMATCH') {
      return jsonError(
        'CONTENT_HASH_MISMATCH',
        'Content hash does not match uploaded files.',
        400,
        'Run pages deploy --dry-run and retry.'
      );
    }
    if (error?.code === 'CLI_UPLOAD_PROTOCOL_REQUIRED') return cliUploadProtocolRequired();
    return jsonError('INVALID_MULTIPART', 'Invalid multipart body.', 400, 'Run pages deploy --dry-run and retry.');
  }

  const requestedSiteId = normalizeOptionalString(body.siteId);
  const requestedSiteSlug = normalizeOptionalSlug(body.siteSlug ?? body.slug);
  const clientContentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  const source = typeof body.source === 'string' ? body.source : 'api';
  const decision = body.decision;
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
  if (!clientContentHash.startsWith('sha256:')) {
    return jsonError('CONTENT_HASH_INVALID', 'Content hash is invalid.', 400, 'Pass a sha256 content hash.');
  }
  if (decisionRequiresWorker(decision)) {
    try {
      artifactBundle = normalizeWorkerBundle(body.artifactBundle);
    } catch {
      return jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run pages deploy --dry-run and retry.');
    }
  }
  if (decisionRequiresAssets(decision)) {
    assetManifest = body.assetManifest;
    assetFiles = body.assetFiles;
    if (!assetManifest || typeof assetManifest !== 'object' || Array.isArray(assetManifest)) {
      return jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Run pages deploy --dry-run and retry.');
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
      return jsonError('ASSET_MANIFEST_INVALID', 'Asset manifest is invalid.', 400, 'Run pages deploy --dry-run and retry.');
    }
    if (error?.code === 'PUBLISH_PLAN_INVALID') {
      return jsonError('PUBLISH_PLAN_INVALID', 'Publish plan is invalid.', 400, 'Run pages deploy --dry-run and retry.');
    }
    throw error;
  }
  if (clientContentHash !== canonicalContentHash) {
    return jsonError(
      'CONTENT_HASH_MISMATCH',
      'Content hash does not match uploaded files.',
      400,
      'Run pages deploy --dry-run and retry.'
    );
  }
  const site = await resolveDeploySite(store, actor, config.environment, {
    siteId: requestedSiteId,
    siteSlug: requestedSiteSlug,
  });
  if (site instanceof Response) return site;
  const siteId = site.id;
  if (!actorCanDeploy(actor, siteId, 'deploy:site')) {
    return jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use a token scoped to this site.');
  }

  const requestHash = await canonicalRequestHash({
    operation: 'deploy',
    siteId,
    decision,
    contentHash: canonicalContentHash,
    artifactBundle,
    assetManifest,
    source,
  });
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
    visibility: site.defaultVisibility,
    status: 'pending',
  });

  if (deploymentResult.kind === 'conflict') return idempotencyConflict();
  if (deploymentResult.kind === 'existing') {
    const reconciled = await reconcileCommittedDeployment(store, deploymentResult.deployment, config.environment, env);
    return jsonOk(await deploymentEnvelope(store, reconciled, {}, config.environment));
  }

  const deployment = deploymentResult.deployment;
  const versionId = nextId(env, 'ver');
  const plannedWorkerName = workerNameFor(site, versionId, config.environment);
  let provider;
  try {
    provider = createDeploymentProvider(env, config, store, site);
  } catch {
    await store.updateDeployment(deployment.id, {
      status: 'failed',
      errorCode: 'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
      errorMessage: 'Deployment platform configuration is invalid.',
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
    });
  } catch (error) {
    const code = publicProviderErrorCode(error, 'upload');
    await store.updateDeployment(deployment.id, {
      status: 'failed',
      errorCode: code,
      errorMessage: 'Deployment upload failed.',
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
      completedAt: readNow(env),
    });
    return jsonError(code, 'Deployment verification failed.', 502, 'Retry the deployment with a new Idempotency-Key.');
  }

  let version;
  let previousRoute;
  let route;
  try {
    await store.updateDeployment(deployment.id, { status: 'verified' });
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
      artifactAvailability: 'active',
      createdBy: actor.userId,
    });
    previousRoute = await store.getRouteBySiteId(siteId, config.environment);
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
    await markDeploymentStateWriteFailed(store, deployment.id, { env, versionId: version?.id });
    return deploymentStateWriteFailed();
  }
  if (!route) {
    await cleanupUploadedWorker(provider, uploaded);
    await store.updateDeployment(deployment.id, {
      status: 'failed',
      versionId: version.id,
      errorCode: 'ROUTE_ACTIVATION_CONFLICT',
      errorMessage: 'Route changed while deployment was activating.',
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
    await restoreSiteRouteAfterSnapshotFailure(store, siteId, previousRoute, route, config.environment);
    await cleanupUploadedWorker(provider, uploaded);
    await store.updateDeployment(deployment.id, {
      status: 'failed',
      versionId: version.id,
      errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
      errorMessage: 'Route snapshot write failed.',
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

  return jsonOk(await deploymentEnvelope(store, completed, { version, route, decision }), 201);
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

  return {
    siteId: metadata.siteId,
    siteSlug: metadata.siteSlug,
    source: typeof metadata.source === 'string' && metadata.source.trim() ? metadata.source.trim() : 'cli',
    contentHash: typeof metadata.contentHash === 'string' ? metadata.contentHash : '',
    decision,
    publishPlan: metadata.publishPlan,
    assetManifest: assetManifestObjectForProvider(assetManifest),
    assetFiles: await assetFilesForProvider(assetManifest, uploadedParts),
    artifactBundle: await artifactBundleForProvider(metadata, workerModules, uploadedParts),
  };
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
  }
  else throwCoded('PUBLISH_PLAN_INVALID');
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
    if (requested !== 'auto' || publishPlan.resolvedFallback !== null) throwCoded('FALLBACK_REQUIRES_ASSETS');
  } else if (publishPlan.resolvedFallback !== 'index' && publishPlan.resolvedFallback !== 'not-found') {
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

  const expectedNotFoundHandling = publishPlan.resolvedFallback === 'index' ? 'single-page-application' : '404-page';
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
    assetsConfig: decision.resolvedFallback
      ? {
          notFoundHandling: decision.resolvedFallback === 'index' ? 'single-page-application' : '404-page',
        }
      : null,
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
  const normalized = String(assetPath || '').replaceAll('\\', '/').replace(/^\/+/, '');
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
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
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
  if (!actorCanReadSite(actor, deployment.siteId)) {
    return jsonError('DEPLOYMENT_READ_FORBIDDEN', 'Actor cannot read this deployment.', 403, 'Use a token with read:site scope.');
  }
  const site = await store.getSiteForUser(deployment.siteId, actor.userId, actor, environment);
  if (!site) return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  deployment = await reconcileCommittedDeployment(store, deployment, environment, env);
  return jsonOk(await deploymentEnvelope(store, deployment, {}, environment));
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
  if (!actorCanDeploy(actor, version.siteId, 'rollback:site')) {
    return jsonError('ROLLBACK_FORBIDDEN', 'Actor cannot rollback this site.', 403, 'Use a token scoped to this site.');
  }

  const site = await store.getSiteForUser(version.siteId, actor.userId, actor, config.environment);
  if (!site) return jsonError('VERSION_NOT_FOUND', 'Version not found.', 404, 'Check the version id.');
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
      updatedAt: readNow(env),
    },
    config.environment,
    currentRoute
  );
  if (!route) {
    await store.updateDeployment(deploymentResult.deployment.id, {
      status: 'failed',
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
      errorCode: 'ROUTE_ACTIVATION_CONFLICT',
      errorMessage: 'Route changed while rollback was activating.',
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
    await restoreSiteRouteAfterSnapshotFailure(store, site.id, currentRoute, route, config.environment);
    await store.updateDeployment(deploymentResult.deployment.id, {
      status: 'failed',
      versionId: version.id,
      previousVersionId: currentRoute.activeVersionId,
      errorCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
      errorMessage: 'Route snapshot write failed.',
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

async function resolveDeploySite(store, actor, environment, { siteId, siteSlug }) {
  if (siteId) {
    const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
    return site || siteNotFound('Check the site id.');
  }
  const bySlug = typeof store.findSiteBySlug === 'function' ? await store.findSiteBySlug(environment, siteSlug) : null;
  if (!bySlug) {
    const slugError = validateDeploySiteSlug(siteSlug, environment);
    return slugError || siteNotFound('Check the site slug.');
  }
  const site = await store.getSiteForUser(bySlug.id, actor.userId, actor, environment);
  return site || siteNotFound('Check the site slug and access key scope.');
}

async function validateRollbackVersion(store, version, environment) {
  const deployment = await store.getDeployment(version.deploymentId, environment);
  if (!deployment || deployment.status !== 'succeeded') {
    return jsonError(
      'ROLLBACK_VERSION_UNAVAILABLE',
      'Version is not available for rollback.',
      409,
      'Rollback to a version from a succeeded deployment.'
    );
  }

  if (version.executionProvider !== 'normal-worker-slot') return null;
  const slot = version.slotId && typeof store.getWorkerSlot === 'function' ? await store.getWorkerSlot(version.slotId) : null;
  if (
    !slot ||
    slot.environment !== environment ||
    slot.status !== 'assigned' ||
    slot.assignedVersionId !== version.id ||
    slot.workerName !== version.workerName ||
    slot.bindingName !== version.dispatchBindingName
  ) {
    return jsonError(
      'ROLLBACK_VERSION_UNAVAILABLE',
      'Version is not available for rollback.',
      409,
      'The worker slot for this version is no longer active. Deploy a new version instead.'
    );
  }
  return null;
}

async function deploymentEnvelope(store, deployment, preloaded = {}, environment) {
  const version =
    preloaded.version || (deployment.versionId ? await store.getSiteVersion(deployment.versionId, environment) : null);
  const route = preloaded.route || (deployment.siteId ? await store.getRouteBySiteId(deployment.siteId, environment) : null);
  return {
    deployment: formatDeployment(deployment),
    version: version ? formatVersion(version) : null,
    route: route ? formatRoute(route) : null,
    decision: preloaded.decision ? formatDecision(preloaded.decision) : formatVersionDecision(version),
  };
}

function formatDeployment(deployment) {
  return {
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
    not_found_handling: decision.resolvedFallback === 'index' ? 'single-page-application' : '404-page',
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

async function cleanupUploadedWorker(provider, uploaded) {
  if (typeof provider?.delete !== 'function') return;
  try {
    await provider.delete(uploaded);
  } catch {
    // Best-effort cleanup must not hide the original deployment failure.
  }
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
  };
}

async function markDeploymentStateWriteFailed(store, deploymentId, { env, versionId = null } = {}) {
  try {
    await store.updateDeployment(deploymentId, {
      status: 'failed',
      versionId,
      errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
      errorMessage: 'Deployment state could not be persisted.',
      completedAt: readNow(env || {}),
    });
  } catch {
    // Best-effort status update after a persistence failure.
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

function publicProviderErrorCode(error, step) {
  if (error?.code === 'SLOT_CAPACITY_EXHAUSTED') return 'DEPLOYMENT_CAPACITY_EXHAUSTED';
  return step === 'upload' ? 'DEPLOYMENT_UPLOAD_FAILED' : 'DEPLOYMENT_VERIFY_FAILED';
}

function actorCanDeploy(actor, siteId, requiredScope) {
  if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return false;
  if (actor.type === 'access_key' && !actor.scopes.includes(requiredScope)) return false;
  return true;
}

function actorCanReadSite(actor, siteId) {
  if (actor.type !== 'access_key') return true;
  if (actor.siteId && actor.siteId !== siteId) return false;
  return actor.scopes.includes('read:site');
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

function siteNotFound(action) {
  return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, action);
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  return newId(prefix);
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
    'Deployment uploads must be generated by the XD Pages CLI.',
    400,
    'Run `pages deploy` or `pages deploy --dry-run --json` and retry.'
  );
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
