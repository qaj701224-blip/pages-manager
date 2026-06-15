import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_NAMES = new Set(['.git', 'node_modules', '.pages.json', '.DS_Store']);

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
    const extension = path.extname(absolute);
    if (extension === '.js' || extension === '.mjs' || extension === '.ts') return 'worker';
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
