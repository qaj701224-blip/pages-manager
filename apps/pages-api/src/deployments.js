import { authenticateApiRequest } from './auth.js';
import { canonicalRequestHash } from './crypto.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newId } from './id.js';
import { buildRouteSnapshot, writeRouteSnapshot } from './route-snapshot.js';

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
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const siteId = typeof body.siteId === 'string' ? body.siteId : '';
  const artifactKind = typeof body.artifactKind === 'string' ? body.artifactKind : '';
  const contentHash = typeof body.contentHash === 'string' ? body.contentHash : '';
  const source = typeof body.source === 'string' ? body.source : 'api';

  if (!siteId) return jsonError('SITE_REQUIRED', 'siteId is required.', 400, 'Pass a siteId.');
  if (!ARTIFACT_KINDS.has(artifactKind)) {
    return jsonError('ARTIFACT_KIND_INVALID', 'Artifact kind is invalid.', 400, 'Use static, spa, or worker.');
  }
  if (!contentHash.startsWith('sha256:')) {
    return jsonError('CONTENT_HASH_INVALID', 'Content hash is invalid.', 400, 'Pass a sha256 content hash.');
  }
  if (!actorCanDeploy(actor, siteId, 'deploy:site')) {
    return jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use a token scoped to this site.');
  }

  const site = await store.getSiteForUser(siteId, actor.userId, actor, config.environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

  const requestHash = await canonicalRequestHash({ operation: 'deploy', siteId, artifactKind, contentHash, source });
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
  const workerName = workerNameFor(site, versionId, config.environment);
  const version = await store.createSiteVersion({
    id: versionId,
    siteId,
    deploymentId: deployment.id,
    workerName,
    runtime: 'wfp',
    artifactKind,
    artifactRef: `dispatch/${workerName}`,
    contentHash,
    createdBy: actor.userId,
  });
  const route = await store.activateSiteVersion(
    siteId,
    {
      activeVersionId: version.id,
      workerName: version.workerName,
      visibility: site.defaultVisibility,
      updatedAt: readNow(env),
    },
    config.environment
  );
  try {
    await writeSnapshot(env, { site, route, version });
  } catch {
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
      'Retry the deployment with the same Idempotency-Key.'
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
      visibility: currentRoute.visibility,
      updatedAt: readNow(env),
    },
    config.environment
  );
  try {
    await writeSnapshot(env, { site, route, version });
  } catch {
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
      'Retry the rollback with the same Idempotency-Key.'
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
    workerName: version.workerName,
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
    workerName: route.workerName,
    activeVersionId: route.activeVersionId,
    visibility: route.visibility,
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    routeStatus: route.routeStatus,
  };
}

async function writeSnapshot(env, input) {
  await writeRouteSnapshot(env.ROUTE_SNAPSHOTS, buildRouteSnapshot(input));
}

function actorCanDeploy(actor, siteId, requiredScope) {
  if (actor.type === 'access_key' && actor.siteId && actor.siteId !== siteId) return false;
  if (actor.type === 'access_key' && !actor.scopes.includes(requiredScope)) return false;
  return true;
}

function workerNameFor(site, deploymentId, environment) {
  const prefix = environment === 'staging' ? 'pages-v2-staging' : 'pages-v2';
  return `${prefix}-${site.slug}-${deploymentId.replaceAll('_', '-')}`;
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
