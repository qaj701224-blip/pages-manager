import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'pages.config.json', '.DS_Store']);
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

export async function inferArtifactKind(targetPath) {
  const absolute = path.resolve(targetPath);
  const stats = await stat(absolute);
  if (stats.isFile()) {
    const extension = path.extname(absolute).toLowerCase();
    if (extension === '.ts') throw new Error('WORKER_TYPESCRIPT_UNSUPPORTED');
    if (extension === '.js' || extension === '.mjs') return 'worker';
    return 'static';
  }

  try {
    const indexStats = await stat(path.join(absolute, 'index.html'));
    if (indexStats.isFile()) return 'spa';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return 'static';
}

export async function buildArtifactBundle(targetPath, artifactKind) {
  const kind = artifactKind || (await inferArtifactKind(targetPath));
  const absolute = path.resolve(targetPath);
  if (kind === 'worker') return buildWorkerBundle(absolute);
  if (kind === 'static' || kind === 'spa') throw new Error('STATIC_ASSET_MULTIPART_REQUIRED');
  throw new Error('ARTIFACT_KIND_INVALID');
}

export async function buildAssetArtifact(targetPath, artifactKind) {
  const kind = artifactKind || (await inferArtifactKind(targetPath));
  if (kind !== 'static' && kind !== 'spa') throw new Error('STATIC_ARTIFACT_KIND_REQUIRED');
  const absolute = path.resolve(targetPath);
  const stats = await stat(absolute);
  if (!stats.isDirectory()) throw new Error('STATIC_ARTIFACT_DIRECTORY_REQUIRED');

  const files = await collectDirectoryFiles(absolute, absolute);
  if (files.length > MAX_STATIC_ARTIFACT_FILES) throw new Error('ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED');

  const manifest = {};
  const assetFiles = [];
  let sizeBytes = 0;
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const bytes = await readFile(file.absolutePath);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > MAX_STATIC_ARTIFACT_BYTES) throw new Error('ARTIFACT_BUNDLE_TOO_LARGE');
    const key = `/${file.relativePath}`;
    const contentType = contentTypeFor(file.relativePath);
    manifest[key] = {
      hash: hashBytes(bytes),
      size: bytes.byteLength,
      content_type: contentType,
    };
    assetFiles.push({
      relativePath: file.relativePath,
      bytes,
      contentType,
    });
  }

  return {
    kind,
    manifest,
    files: assetFiles,
    fileCount: assetFiles.length,
    sizeBytes,
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

async function buildWorkerBundle(absolutePath) {
  const stats = await stat(absolutePath);
  if (!stats.isFile()) throw new Error('WORKER_ARTIFACT_FILE_REQUIRED');
  if (path.extname(absolutePath).toLowerCase() === '.ts') throw new Error('WORKER_TYPESCRIPT_UNSUPPORTED');
  const name = path.basename(absolutePath);
  return {
    kind: 'worker',
    mainModule: name,
    modules: [
      {
        name,
        content: await readFile(absolutePath, 'utf8'),
        type: 'application/javascript+module',
      },
    ],
  };
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

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}
