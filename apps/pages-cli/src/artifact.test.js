import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_STATIC_ARTIFACT_BYTES,
  MAX_STATIC_ARTIFACT_FILES,
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

test('buildArtifactBundle generates static and SPA worker modules from files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-bundle-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<div id="app"></div>');
  await writeFile(path.join(dir, 'style.css'), 'body { color: red; }');
  await writeFile(path.join(dir, 'pages.config.json'), '{"secret":"ignored"}');

  const bundle = await buildArtifactBundle(dir, 'spa');

  assert.equal(bundle.kind, 'spa');
  assert.equal(bundle.mainModule, 'worker.mjs');
  assert.equal(bundle.modules.length, 1);
  assert.equal(bundle.modules[0].name, 'worker.mjs');
  assert.equal(bundle.modules[0].type, 'application/javascript+module');
  assert.match(bundle.modules[0].content, /index\.html/);
  assert.match(bundle.modules[0].content, /style\.css/);
  assert.match(bundle.modules[0].content, /spaFallback/);
  assert.equal(bundle.modules[0].content.includes(dir), false);
  assert.equal(bundle.modules[0].content.includes('pages.config.json'), false);
});

test('buildArtifactBundle rejects static bundles above first-version limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), 'x'.repeat(MAX_STATIC_ARTIFACT_BYTES + 1));

  await assert.rejects(() => buildArtifactBundle(dir, 'static'), /ARTIFACT_BUNDLE_TOO_LARGE/);
});

test('buildArtifactBundle rejects too many static files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-file-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  for (let index = 0; index <= MAX_STATIC_ARTIFACT_FILES; index += 1) {
    await writeFile(path.join(dir, `${index}.txt`), 'x');
  }

  await assert.rejects(() => buildArtifactBundle(dir, 'static'), /ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED/);
});
