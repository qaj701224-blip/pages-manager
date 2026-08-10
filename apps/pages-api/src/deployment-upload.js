import { sha256HexForBytes } from './crypto.js';
import {
  concatHashChunks,
  decisionRequiresWorker,
  normalizeModuleName,
  normalizePublishPlanDecision,
  throwCoded,
} from './deployment-plan.js';
import { normalizeRuntimeVars } from './runtime-config.js';

const encoder = new globalThis.TextEncoder();
const utf8Decoder = new globalThis.TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_DEPLOYMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DEPLOYMENT_METADATA_BYTES = 4 * 1024 * 1024;
const DENYLISTED_BASENAMES = new Set(['.env', '.dev.vars', 'wrangler.toml', '.gitlab-ci.yml']);
const DENYLISTED_EXTENSIONS = new Set(['.pem', '.key']);
const CONTROL_ASSET_PATHS = new Set([
  '/_worker.js',
  '/_headers',
  '/_redirects',
  '/_routes.json',
  '/.assetsignore',
  '/pages.config.json',
  '/xd-cell.config.json',
]);

export function isMultipartRequest(request) {
  const mediaType = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'multipart/form-data';
}

export async function readMultipartDeploymentBody(request) {
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

async function hashUploadedAsset(bytes, contentType) {
  return (
    await sha256HexForBytes(concatHashChunks(['xd-pages-asset-v2\0', contentType || 'application/octet-stream', '\0', bytes]))
  ).slice(0, 32);
}

function isShortHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

export function validateAssetFiles(manifest, files) {
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

function normalizePartName(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.includes('\0') || normalized.length > 128) throwCoded('PUBLISH_PLAN_INVALID');
  return normalized;
}

function normalizeContentType(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
