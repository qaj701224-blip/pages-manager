import { authenticateApiRequest } from './auth.js';
import { canonicalRequestHash } from './crypto.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newId } from './id.js';
import { buildRouteSnapshot, writeRouteSnapshot } from './route-snapshot.js';
import { createDeploymentProvider, normalizeArtifactBundle } from './execution-provider.js';
import { notifyDeploymentCapacityExhausted } from './slack-alerts.js';

const ARTIFACT_KINDS = new Set(['static', 'spa', 'worker']);

export async function handleDeploymentsApi(request, env, config, store) {
  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return authErrorResponse(auth.error);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/api/deployments') {
    if (request.method === 'POST') return createDeployment(request, env, config, store, auth.actor);
    return methodNotAllowed();
  }

  const deploymentId = matchDeploymentId(url.pathname);
  if (deploymentId && request.method === 'GET') return getDeployment(store, auth.actor, deploymentId, config.environment);
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

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'JSON_BODY_TOO_LARGE') {
      return jsonError(
        'PAYLOAD_TOO_LARGE',
        'Deployment payload is too large.',
        413,
        'Reduce artifact size or use an asset store backed deployment path.'
      );
    }
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const requestedSiteId = normalizeOptionalString(body.siteId);
  const requestedSiteSlug = normalizeOptionalSlug(body.siteSlug ?? body.slug);
  const artifactKind = typeof body.artifactKind === 'string' ? body.artifactKind : '';
  const contentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  const source = typeof body.source === 'string' ? body.source : 'api';
  let artifactBundle;

  if (!requestedSiteId && !requestedSiteSlug) {
    return jsonError('SITE_REQUIRED', 'Site is required.', 400, 'Pass siteId or siteSlug.');
  }
  if (!ARTIFACT_KINDS.has(artifactKind)) {
    return jsonError('ARTIFACT_KIND_INVALID', 'Artifact kind is invalid.', 400, 'Use static, spa, or worker.');
  }
  if (!contentHash.startsWith('sha256:')) {
    return jsonError('CONTENT_HASH_INVALID', 'Content hash is invalid.', 400, 'Pass a sha256 content hash.');
  }
  try {
    artifactBundle = normalizeArtifactBundle({ artifactKind, contentHash, artifactBundle: body.artifactBundle });
  } catch (error) {
    if (error?.message === 'ARTIFACT_BUNDLE_REQUIRED') {
      return jsonError('ARTIFACT_BUNDLE_REQUIRED', 'artifactBundle is required.', 400, 'Send an artifact bundle.');
    }
    return jsonError('ARTIFACT_BUNDLE_INVALID', 'Artifact bundle is invalid.', 400, 'Send a valid artifact bundle.');
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
    artifactKind,
    contentHash,
    artifactBundle,
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
    return jsonOk(await deploymentEnvelope(store, deploymentResult.deployment, {}, config.environment));
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

  await store.updateDeployment(deployment.id, { status: 'uploading' });
  let uploaded;
  try {
    uploaded = await provider.upload({
      site,
      workerName: plannedWorkerName,
      versionId,
      artifactKind,
      contentHash,
      artifactBundle,
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
      artifactKind,
      artifactRef: uploaded.artifactRef,
      contentHash,
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

  const completed = await store.updateDeployment(deployment.id, {
    status: 'succeeded',
    versionId: version.id,
    completedAt: readNow(env),
  });

  return jsonOk(await deploymentEnvelope(store, completed, { version, route }), 201);
}

async function getDeployment(store, actor, deploymentId, environment) {
  const deployment = await store.getDeployment(deploymentId, environment);
  if (!deployment) return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  if (!actorCanReadSite(actor, deployment.siteId)) {
    return jsonError('DEPLOYMENT_READ_FORBIDDEN', 'Actor cannot read this deployment.', 403, 'Use a token with read:site scope.');
  }
  const site = await store.getSiteForUser(deployment.siteId, actor.userId, actor, environment);
  if (!site) return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  return jsonOk(await deploymentEnvelope(store, deployment, {}, environment));
}

async function rollbackVersion(request, env, config, store, actor, versionId) {
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return idempotencyKeyRequired();

  const version = await store.getSiteVersion(versionId, config.environment);
  if (!version) return jsonError('VERSION_NOT_FOUND', 'Version not found.', 404, 'Check the version id.');
  if (!actorCanDeploy(actor, version.siteId, 'rollback:site')) {
    return jsonError('ROLLBACK_FORBIDDEN', 'Actor cannot rollback this site.', 403, 'Use a token scoped to this site.');
  }

  const site = await store.getSiteForUser(version.siteId, actor.userId, actor, config.environment);
  if (!site) return jsonError('VERSION_NOT_FOUND', 'Version not found.', 404, 'Check the version id.');
  const versionAvailabilityError = await validateRollbackVersion(store, version, config.environment);
  if (versionAvailabilityError) return versionAvailabilityError;
  const currentRoute = await store.getRouteBySiteId(site.id, config.environment);
  const requestHash = await canonicalRequestHash({ operation: 'rollback', versionId });
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
    return jsonOk(await deploymentEnvelope(store, deploymentResult.deployment, {}, config.environment));
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

  const completed = await store.updateDeployment(deploymentResult.deployment.id, {
    status: 'succeeded',
    versionId: version.id,
    previousVersionId: currentRoute.activeVersionId,
    completedAt: readNow(env),
  });

  return jsonOk(await deploymentEnvelope(store, completed, { version, route }), 201);
}

async function resolveDeploySite(store, actor, environment, { siteId, siteSlug }) {
  if (siteId) {
    const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
    return site || siteNotFound('Check the site id.');
  }
  const bySlug = typeof store.findSiteBySlug === 'function' ? await store.findSiteBySlug(environment, siteSlug) : null;
  if (!bySlug) return siteNotFound('Check the site slug.');
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
    artifactKind: version.artifactKind,
    contentHash: version.contentHash,
    createdAt: version.createdAt,
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

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
