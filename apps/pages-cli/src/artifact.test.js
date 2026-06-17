import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_STATIC_ARTIFACT_BYTES,
  MAX_STATIC_ARTIFACT_FILES,
  buildAssetArtifact,
  buildArtifactBundle,
  hashArtifact,
  inferArtifactKind,
} from './artifact.js';

test('hashArtifact is deterministic for directories and ignores default command config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-artifact-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("hi");');

  const first = await hashArtifact(dir);
  await writeFile(path.join(dir, 'pages.config.json'), '{"site":"docs"}');
  const second = await hashArtifact(dir);

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.fileCount, 2);
  assert.equal(first.sizeBytes, '<h1>Hello</h1>'.length + 'console.log("hi");'.length);
});

test('inferArtifactKind detects worker files and SPA directories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-kind-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'worker.mjs'), 'export default {};');
  await writeFile(path.join(dir, 'worker.MJS'), 'export default {};');
  await writeFile(path.join(dir, 'worker.ts'), 'export default {};');
  await writeFile(path.join(dir, 'worker.TS'), 'export default {};');
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'dist', 'index.html'), '<div id="app"></div>');

  assert.equal(await inferArtifactKind(path.join(dir, 'worker.mjs')), 'worker');
  assert.equal(await inferArtifactKind(path.join(dir, 'worker.MJS')), 'worker');
  await assert.rejects(() => inferArtifactKind(path.join(dir, 'worker.ts')), /WORKER_TYPESCRIPT_UNSUPPORTED/);
  await assert.rejects(() => inferArtifactKind(path.join(dir, 'worker.TS')), /WORKER_TYPESCRIPT_UNSUPPORTED/);
  assert.equal(await inferArtifactKind(path.join(dir, 'dist')), 'spa');
});

test('buildArtifactBundle rejects TypeScript worker sources until bundling exists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-ts-worker-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const workerPath = path.join(dir, 'worker.ts');
  await writeFile(workerPath, 'export default { fetch() { return new Response("ok"); } };');

  await assert.rejects(() => buildArtifactBundle(workerPath, 'worker'), /WORKER_TYPESCRIPT_UNSUPPORTED/);
});

test('buildArtifactBundle returns worker module content without absolute paths', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-worker-bundle-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const workerPath = path.join(dir, 'worker.mjs');
  await writeFile(workerPath, 'export default { fetch() { return new Response("ok"); } };');

  assert.deepEqual(await buildArtifactBundle(workerPath, 'worker'), {
    kind: 'worker',
    mainModule: 'worker.mjs',
    modules: [
      {
        name: 'worker.mjs',
        content: 'export default { fetch() { return new Response("ok"); } };',
        type: 'application/javascript+module',
      },
    ],
  });
});

test('buildAssetArtifact returns a manifest and raw files without generated worker source', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-asset-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<div id="app"></div>');
  await writeFile(path.join(dir, 'style.css'), 'body { color: red; }');
  await writeFile(path.join(dir, 'pages.config.json'), '{"secret":"ignored"}');

  const artifact = await buildAssetArtifact(dir, 'spa');

  assert.equal(artifact.kind, 'spa');
  assert.equal(artifact.fileCount, 2);
  assert.equal(artifact.sizeBytes, '<div id="app"></div>'.length + 'body { color: red; }'.length);
  assert.deepEqual(Object.keys(artifact.manifest), ['/index.html', '/style.css']);
  assert.equal(artifact.manifest['/index.html'].content_type, 'text/html; charset=utf-8');
  assert.equal(artifact.files.length, 2);
  assert.equal(artifact.files[0].relativePath.includes(dir), false);
  assert.equal(JSON.stringify(artifact).includes('spaFallback'), false);
  assert.equal(JSON.stringify(artifact).includes('base64'), false);
});

test('buildAssetArtifact versions asset hashes with content type to avoid stale remote MIME reuse', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-asset-hash-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const content = '<div id="app"></div>';
  await writeFile(path.join(dir, 'index.html'), content);
  await writeFile(path.join(dir, 'same.txt'), content);

  const artifact = await buildAssetArtifact(dir, 'spa');
  const legacyContentHash = createHash('sha256').update(content).digest('hex').slice(0, 32);

  assert.notEqual(artifact.manifest['/index.html'].hash, legacyContentHash);
  assert.notEqual(artifact.manifest['/index.html'].hash, artifact.manifest['/same.txt'].hash);
});

test('buildArtifactBundle rejects static and SPA artifacts because assets use multipart upload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-no-generated-worker-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<div id="app"></div>');

  await assert.rejects(() => buildArtifactBundle(dir, 'spa'), /STATIC_ASSET_MULTIPART_REQUIRED/);
  await assert.rejects(() => buildArtifactBundle(dir, 'static'), /STATIC_ASSET_MULTIPART_REQUIRED/);
});

test('buildAssetArtifact rejects static bundles above asset upload limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), 'x'.repeat(MAX_STATIC_ARTIFACT_BYTES + 1));

  await assert.rejects(() => buildAssetArtifact(dir, 'static'), /ARTIFACT_BUNDLE_TOO_LARGE/);
});

test('buildAssetArtifact rejects too many static files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-file-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  for (let index = 0; index <= MAX_STATIC_ARTIFACT_FILES; index += 1) {
    await writeFile(path.join(dir, `${index}.txt`), 'x');
  }

  await assert.rejects(() => buildAssetArtifact(dir, 'static'), /ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED/);
});
