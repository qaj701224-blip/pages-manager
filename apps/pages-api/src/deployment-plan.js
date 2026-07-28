import { sha256HexForBytes } from './crypto.js';

const encoder = new globalThis.TextEncoder();
const DEPLOYMENT_SHAPES = new Set(['assets-only', 'worker-only', 'worker-with-assets']);
const ROUTING_MODES = new Set(['assets-only', 'worker-only', 'worker-first']);
const FALLBACK_MODES = new Set(['auto', 'index', 'not-found', 'none', 'single-page-application', '404-page']);

export function normalizePublishPlanDecision({ publishPlan, requestedFallback, assetManifest, workerModules }) {
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

function payloadShapeForParts({ hasAssets, hasWorker }) {
  if (hasAssets && hasWorker) return 'worker-with-assets';
  if (hasWorker) return 'worker-only';
  if (hasAssets) return 'assets-only';
  return null;
}

export async function canonicalDeploymentContentHash({ decision, assetFiles = [], artifactBundle }) {
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

export function concatHashChunks(chunks) {
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

export function normalizeModuleName(value) {
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
  const parts = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || parts.includes('..')) {
    throwCoded('PUBLISH_PLAN_INVALID');
  }
  return normalized;
}

function normalizeEnum(value, values) {
  if (typeof value !== 'string' || !values.has(value)) throwCoded('PUBLISH_PLAN_INVALID');
  return value;
}

export function decisionRequiresWorker(decision) {
  return decision?.deploymentShape === 'worker-only' || decision?.deploymentShape === 'worker-with-assets';
}

export function decisionRequiresAssets(decision) {
  return decision?.deploymentShape === 'assets-only' || decision?.deploymentShape === 'worker-with-assets';
}

export function throwCoded(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
