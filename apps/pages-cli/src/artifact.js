import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'pages.config.json', '.DS_Store']);
const CONTROL_FILE_NAMES = new Set([
  '_worker.js',
  '_headers',
  '_redirects',
  '_routes.json',
  '.assetsignore',
  'pages.config.json',
]);
const SAFE_IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
const DENYLISTED_BASENAMES = new Set(['.env', '.dev.vars', 'wrangler.toml', '.gitlab-ci.yml']);
const DENYLISTED_EXTENSIONS = new Set(['.pem', '.key']);
export const MAX_STATIC_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const MAX_STATIC_ARTIFACT_FILES = 5000;

export async function hashArtifact(targetPath) {
  const absolute = path.resolve(targetPath);
  const stats = await stat(absolute);
  const files = stats.isDirectory()
    ? await collectDirectoryFiles(absolute, absolute)
    : [{ absolutePath: absolute, relativePath: path.basename(absolute) }];

  const hash = createHash('sha256');
  let sizeBytes = 0;
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const bytes = await readFile(file.absolutePath);
    sizeBytes += bytes.byteLength;
    hash.update('file\0');
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }

  return {
    contentHash: `sha256:${hash.digest('hex')}`,
    fileCount: files.length,
    sizeBytes,
  };
}

export async function detectPublishTarget(targetPath, options = {}) {
  const requestedFallback = options.requestedFallback || 'auto';
  if (!['auto', 'index', 'not-found'].includes(requestedFallback)) throw new Error('FALLBACK_INVALID');
  const absolute = path.resolve(targetPath);
  const stats = await stat(absolute);
  if (stats.isFile()) return detectFileTarget(absolute, requestedFallback);
  if (!stats.isDirectory()) throw new Error('DETECT_TARGET_NOT_FOUND');

  const entries = await scanDirectory(absolute);
  const workerEntry = resolveWorkerEntry(entries, options.workerEntry);
  const publicAssets = entries.files.filter((file) => !file.control && file.relativePath !== workerEntry);
  const deploymentShape = workerEntry ? (publicAssets.length > 0 ? 'worker-with-assets' : 'worker-only') : 'assets-only';
  const resolvedFallback = resolveFallback({ requestedFallback, deploymentShape, entries, publicAssets });

  return {
    deploymentShape,
    requestedFallback,
    resolvedFallback,
    routingMode: deploymentShape === 'worker-with-assets' ? 'worker-first' : deploymentShape,
    workerEntry,
    confidence: confidenceFor({ requestedFallback, resolvedFallback, entries }),
    source: requestedFallback === 'auto' ? 'auto' : 'explicit',
    signals: entries.signals,
    diagnostics: entries.diagnostics,
  };
}

export async function createUploadPlan(targetPath, decision) {
  const absolute = path.resolve(targetPath);
  const stats = await stat(absolute);
  if (stats.isFile()) return createFileUploadPlan(absolute, decision);
  if (!stats.isDirectory()) throw new Error('DETECT_TARGET_NOT_FOUND');

  const entries = await scanDirectory(absolute, { failOnDenylist: true });
  const publicFiles = entries.files.filter((file) => !file.control && file.relativePath !== decision.workerEntry);
  if (decision.deploymentShape !== 'worker-only' && publicFiles.length === 0) {
    throw new Error('PACKAGE_NO_PUBLIC_ASSETS_AFTER_EXCLUDES');
  }

  const assetManifest = [];
  const assetFiles = [];
  let sizeBytes = 0;
  for (const [index, file] of publicFiles.sort(compareRelativePath).entries()) {
    const bytes = await readFile(file.absolutePath);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > MAX_STATIC_ARTIFACT_BYTES) throw new Error('ARTIFACT_BUNDLE_TOO_LARGE');
    const contentType = contentTypeFor(file.relativePath);
    const partName = `asset-file-${index}`;
    assetManifest.push({
      path: `/${file.relativePath}`,
      partName,
      hash: hashAsset(bytes, contentType),
      size: bytes.byteLength,
      contentType,
    });
    assetFiles.push({
      relativePath: file.relativePath,
      partName,
      bytes,
      contentType,
    });
  }
  if (assetFiles.length > MAX_STATIC_ARTIFACT_FILES) throw new Error('ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED');

  const workerModules = await workerModulesForDirectory(absolute, decision);
  for (const module of workerModules) {
    sizeBytes += module.size;
    if (sizeBytes > MAX_STATIC_ARTIFACT_BYTES) throw new Error('ARTIFACT_BUNDLE_TOO_LARGE');
  }
  const hashFiles = [
    ...assetFiles.map((file) => ({ relativePath: file.relativePath, contentType: file.contentType, bytes: file.bytes })),
    ...workerModules.map((module) => ({
      relativePath: module.moduleName,
      contentType: module.contentType,
      bytes: Buffer.from(module.content),
    })),
  ];

  return {
    publishPlan: publishPlanFromDecision(decision),
    contentHash: hashUploadPlan(hashFiles, decision),
    fileCount: assetFiles.length,
    sizeBytes,
    assetManifest,
    assetFiles,
    workerMainModuleName: decision.workerEntry,
    workerModules,
    controlSignals: entries.controlSignals,
  };
}

async function collectDirectoryFiles(root, dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDirectoryFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      absolutePath,
      relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
    });
  }
  return files;
}

function detectFileTarget(absolute, requestedFallback) {
  const extension = path.extname(absolute).toLowerCase();
  if (extension === '.ts') throw new Error('WORKER_TYPESCRIPT_UNSUPPORTED');
  if (extension === '.js' || extension === '.mjs') {
    if (requestedFallback !== 'auto') throw new Error('FALLBACK_REQUIRES_ASSETS');
    return {
      deploymentShape: 'worker-only',
      requestedFallback,
      resolvedFallback: null,
      routingMode: 'worker-only',
      workerEntry: path.basename(absolute),
      confidence: 'high',
      source: 'auto',
      signals: [{ code: 'WORKER_FILE_TARGET', path: path.basename(absolute) }],
      diagnostics: [],
    };
  }
  throw new Error('STATIC_ARTIFACT_DIRECTORY_REQUIRED');
}

async function scanDirectory(root, options = {}) {
  const files = [];
  const signals = [];
  const diagnostics = [];
  const controlSignals = [];
  await scanDirectoryInner(root, root, { files, signals, diagnostics, controlSignals }, options);
  addDirectorySignals(files, signals, controlSignals);
  return { files, signals, diagnostics, controlSignals };
}

async function scanDirectoryInner(root, dir, output, options) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SAFE_IGNORED_NAMES.has(entry.name)) continue;
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    const entryStats = await lstat(absolutePath);
    if (entryStats.isSymbolicLink()) {
      const resolved = await realpath(absolutePath);
      const rootReal = await realpath(root);
      if (!isInsidePath(rootReal, resolved)) {
        if (options.failOnDenylist) throw new Error('DETECT_SYMLINK_OUTSIDE_SOURCE');
        output.diagnostics.push({
          code: 'DETECT_SYMLINK_OUTSIDE_SOURCE',
          severity: 'danger',
          stage: 'package',
          path: relativePath,
        });
        continue;
      }
      const resolvedRelativePath = path.relative(rootReal, resolved).split(path.sep).join('/');
      if (isIgnoredPath(resolvedRelativePath) || denylistCodeFor(resolvedRelativePath)) {
        if (options.failOnDenylist) throw new Error('PACKAGE_DENYLISTED_FILE');
        output.diagnostics.push({
          code: 'PACKAGE_DENYLISTED_FILE',
          severity: 'danger',
          stage: 'package',
          path: relativePath,
        });
        continue;
      }
      const resolvedStats = await stat(absolutePath);
      if (resolvedStats.isDirectory()) {
        if (options.failOnDenylist) throw new Error('DETECT_SYMLINK_DIRECTORY_UNSUPPORTED');
        output.diagnostics.push({
          code: 'DETECT_SYMLINK_DIRECTORY_UNSUPPORTED',
          severity: 'danger',
          stage: 'package',
          path: relativePath,
        });
        continue;
      }
      if (!resolvedStats.isFile()) continue;
    }
    if (entry.isDirectory()) {
      await scanDirectoryInner(root, absolutePath, output, options);
      continue;
    }
    const isFile = entry.isFile() || entryStats.isSymbolicLink();
    if (!isFile) continue;

    const denylistCode = denylistCodeFor(relativePath);
    if (denylistCode) {
      if (options.failOnDenylist) throw new Error(denylistCode);
      output.diagnostics.push({
        code: denylistCode,
        severity: 'danger',
        stage: 'package',
        path: relativePath,
      });
      continue;
    }

    const control = isControlFile(relativePath);
    output.files.push({ absolutePath, relativePath, control });
    if (control) {
      output.controlSignals.push(await controlSignalFor(absolutePath, relativePath));
    }
  }
}

function addDirectorySignals(files, signals, controlSignals) {
  if (files.some((file) => file.relativePath === 'index.html')) {
    signals.push({ code: 'ROOT_INDEX_HTML_FOUND', path: 'index.html' });
  }
  if (files.some((file) => file.relativePath === '404.html')) {
    signals.push({ code: 'STATIC_EXPORT_SIGNALS_FOUND', path: '404.html' });
  }
  const htmlFiles = files.filter((file) => !file.control && file.relativePath.endsWith('.html'));
  if (htmlFiles.length === 1 && htmlFiles[0].relativePath === 'index.html') signals.push({ code: 'SINGLE_HTML_ENTRY' });
  if (htmlFiles.length > 1) signals.push({ code: 'STATIC_EXPORT_SIGNALS_FOUND' });
  if (controlSignals.some((signal) => signal.effect === 'fallback-index')) signals.push({ code: 'EXPLICIT_INDEX_REWRITE_FOUND' });
}

function resolveWorkerEntry(entries, workerEntry) {
  if (workerEntry) {
    const normalized = normalizeRelativeEntry(workerEntry);
    const match = entries.files.find((file) => file.relativePath === normalized);
    if (!match) throw new Error('WORKER_ENTRY_NOT_FOUND');
    assertWorkerEntryExtension(normalized);
    return normalized;
  }
  return entries.files.some((file) => file.relativePath === '_worker.js') ? '_worker.js' : null;
}

function resolveFallback({ requestedFallback, deploymentShape, entries, publicAssets }) {
  if (deploymentShape === 'worker-only') {
    if (requestedFallback !== 'auto') throw new Error('FALLBACK_REQUIRES_ASSETS');
    return null;
  }
  if (requestedFallback === 'index') {
    if (!entries.files.some((file) => file.relativePath === 'index.html')) throw new Error('FALLBACK_INDEX_REQUIRES_INDEX_HTML');
    return 'index';
  }
  if (requestedFallback === 'not-found') return 'not-found';
  if (entries.signals.some((signal) => signal.code === 'STATIC_EXPORT_SIGNALS_FOUND')) return 'not-found';
  if (entries.signals.some((signal) => signal.code === 'EXPLICIT_INDEX_REWRITE_FOUND')) return 'index';
  const htmlFiles = publicAssets.filter((file) => file.relativePath.endsWith('.html'));
  if (htmlFiles.length === 1 && htmlFiles[0].relativePath === 'index.html') return 'index';
  return 'not-found';
}

function confidenceFor({ requestedFallback, resolvedFallback, entries }) {
  if (requestedFallback !== 'auto') return 'high';
  if (entries.signals.some((signal) => signal.code === 'EXPLICIT_INDEX_REWRITE_FOUND')) return 'high';
  if (entries.signals.some((signal) => signal.code === 'STATIC_EXPORT_SIGNALS_FOUND')) return 'high';
  if (resolvedFallback === 'index') return 'medium';
  return 'low';
}

async function createFileUploadPlan(absolute, decision) {
  if (decision.deploymentShape !== 'worker-only') throw new Error('STATIC_ARTIFACT_DIRECTORY_REQUIRED');
  const bundle = await buildWorkerBundle(absolute);
  const bytes = Buffer.from(bundle.modules[0].content);
  if (bytes.byteLength > MAX_STATIC_ARTIFACT_BYTES) throw new Error('ARTIFACT_BUNDLE_TOO_LARGE');
  const hashFiles = [{ relativePath: bundle.mainModule, contentType: 'application/javascript+module', bytes }];
  return {
    publishPlan: publishPlanFromDecision(decision),
    contentHash: hashUploadPlan(hashFiles, decision),
    fileCount: 1,
    sizeBytes: bytes.byteLength,
    assetManifest: [],
    assetFiles: [],
    workerMainModuleName: bundle.mainModule,
    workerModules: [
      {
        moduleName: bundle.mainModule,
        partName: 'worker-main',
        content: bundle.modules[0].content,
        contentType: 'application/javascript+module',
        hash: hashAsset(bytes, 'application/javascript+module'),
        size: bytes.byteLength,
      },
    ],
    controlSignals: [],
  };
}

async function workerModulesForDirectory(root, decision) {
  if (!decision.workerEntry) return [];
  const absolutePath = path.join(root, decision.workerEntry);
  const bytes = await readFile(absolutePath);
  const content = bytes.toString('utf8');
  assertNoUnbundledRelativeImports(content);
  return [
    {
      moduleName: decision.workerEntry,
      partName: 'worker-main',
      content,
      contentType: 'application/javascript+module',
      hash: hashAsset(bytes, 'application/javascript+module'),
      size: bytes.byteLength,
    },
  ];
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

function hashUploadPlan(files, decision) {
  const hash = createHash('sha256');
  hash.update('xd-pages-upload-plan-v1\0');
  hash.update(JSON.stringify(publishPlanFromDecision(decision)));
  hash.update('\0');
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update('file\0');
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes.byteLength));
    hash.update('\0');
    hash.update(file.contentType || 'application/octet-stream');
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function compareRelativePath(left, right) {
  return left.relativePath.localeCompare(right.relativePath);
}

function normalizeRelativeEntry(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error('WORKER_ENTRY_INVALID');
  return normalized;
}

function assertWorkerEntryExtension(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.ts') throw new Error('WORKER_TYPESCRIPT_UNSUPPORTED');
  if (extension !== '.js' && extension !== '.mjs') throw new Error('WORKER_ENTRY_FILE_UNSUPPORTED');
}

function isControlFile(relativePath) {
  return !relativePath.includes('/') && CONTROL_FILE_NAMES.has(relativePath);
}

async function controlSignalFor(absolutePath, relativePath) {
  if (relativePath === '_redirects') {
    const content = await readFile(absolutePath, 'utf8');
    return { path: relativePath, kind: 'redirects', effect: hasSpaRedirectRule(content) ? 'fallback-index' : 'ignored' };
  }
  return { path: relativePath, kind: relativePath.replace(/^_/, ''), effect: 'ignored' };
}

function denylistCodeFor(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const comparable = normalized.toLowerCase();
  const basename = path.posix.basename(normalized);
  const comparableBasename = basename.toLowerCase();
  const extension = path.posix.extname(basename).toLowerCase();
  if (DENYLISTED_BASENAMES.has(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (/^\.env(\.|$)/.test(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (/^\.dev\.vars(\.|$)/.test(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (/^wrangler(\..*)?\.toml$/.test(comparableBasename)) return 'PACKAGE_DENYLISTED_FILE';
  if (DENYLISTED_EXTENSIONS.has(extension)) return 'PACKAGE_DENYLISTED_FILE';
  if (comparable === '.github' || comparable.startsWith('.github/')) return 'PACKAGE_DENYLISTED_FILE';
  return null;
}

function isIgnoredPath(relativePath) {
  return relativePath
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => SAFE_IGNORED_NAMES.has(segment));
}

function isInsidePath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function buildWorkerBundle(absolutePath) {
  const stats = await stat(absolutePath);
  if (!stats.isFile()) throw new Error('WORKER_ARTIFACT_FILE_REQUIRED');
  if (path.extname(absolutePath).toLowerCase() === '.ts') throw new Error('WORKER_TYPESCRIPT_UNSUPPORTED');
  const name = path.basename(absolutePath);
  const content = await readFile(absolutePath, 'utf8');
  assertNoUnbundledRelativeImports(content);
  return {
    mainModule: name,
    modules: [
      {
        name,
        content,
        type: 'application/javascript+module',
      },
    ],
  };
}

function hasSpaRedirectRule(content) {
  return String(content || '')
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      const [from, to, status] = trimmed.split(/\s+/);
      return from === '/*' && to === '/index.html' && /^200!?$/.test(status || '');
    });
}

function assertNoUnbundledRelativeImports(content) {
  const withoutComments = stripJavaScriptComments(content);
  const patterns = [
    /(?:^|[;\n\r])\s*import(?:\s+[^'"]*?\s+from\s*|\s*[^'"]*?from\s*|\s*)(['"])(\.{1,2}\/[^'"]+)\1/gms,
    /(?:^|[;\n\r])\s*export\s+(?:\*|{[^}]*})(?:\s+as\s+\w+)?\s*from\s*(['"])(\.{1,2}\/[^'"]+)\1/gms,
    /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1/gms,
  ];
  if (patterns.some((pattern) => pattern.test(withoutComments))) {
    throw new Error('WORKER_UNBUNDLED_IMPORT_UNSUPPORTED');
  }
}

function stripJavaScriptComments(content) {
  let output = '';
  let index = 0;
  let quote = null;
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (quote) {
      output += char;
      if (char === '\\') {
        output += next || '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < content.length && content[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        output += content[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < content.length) {
        output += '  ';
        index += 2;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function contentTypeFor(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function hashAsset(bytes, contentType) {
  return createHash('sha256')
    .update('xd-pages-asset-v2\0')
    .update(contentType)
    .update('\0')
    .update(bytes)
    .digest('hex')
    .slice(0, 32);
}
