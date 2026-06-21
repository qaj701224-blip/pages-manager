import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_STATIC_ARTIFACT_BYTES,
  MAX_STATIC_ARTIFACT_FILES,
  createUploadPlan,
  detectPublishTarget,
  hashArtifact,
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

test('detectPublishTarget treats JavaScript file targets as worker-only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-file-worker-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'worker.mjs'), 'export default {};');
  await writeFile(path.join(dir, 'worker.MJS'), 'export default {};');
  await writeFile(path.join(dir, 'worker.ts'), 'export default {};');

  assert.deepEqual(await detectPublishTarget(path.join(dir, 'worker.mjs')), {
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    workerEntry: 'worker.mjs',
    confidence: 'high',
    source: 'auto',
    signals: [{ code: 'WORKER_FILE_TARGET', path: 'worker.mjs' }],
    diagnostics: [],
  });
  assert.equal((await detectPublishTarget(path.join(dir, 'worker.MJS'))).workerEntry, 'worker.MJS');
  await assert.rejects(() => detectPublishTarget(path.join(dir, 'worker.ts')), /WORKER_TYPESCRIPT_UNSUPPORTED/);
});

test('detectPublishTarget rejects non-worker single file targets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-file-static-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');

  await assert.rejects(() => detectPublishTarget(path.join(dir, 'index.html')), /STATIC_ARTIFACT_DIRECTORY_REQUIRED/);
});

test('createUploadPlan packages worker-only file targets without absolute paths', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-worker-plan-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const workerPath = path.join(dir, 'worker.mjs');
  const content = 'export default { fetch() { return new Response("ok"); } };';
  await writeFile(workerPath, content);

  const decision = await detectPublishTarget(workerPath);
  const plan = await createUploadPlan(workerPath, decision);

  assert.equal(plan.fileCount, 1);
  assert.equal(plan.sizeBytes, content.length);
  assert.equal(plan.workerMainModuleName, 'worker.mjs');
  assert.deepEqual(plan.assetManifest, []);
  assert.deepEqual(plan.workerModules, [
    {
      moduleName: 'worker.mjs',
      partName: 'worker-main',
      content,
      contentType: 'application/javascript+module',
      hash: hashAsset(Buffer.from(content), 'application/javascript+module'),
      size: content.length,
    },
  ]);
  assert.equal(JSON.stringify(plan).includes(dir), false);
});

test('createUploadPlan rejects worker-only file targets above upload limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-worker-file-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const workerPath = path.join(dir, 'worker.mjs');
  await writeFile(workerPath, 'x'.repeat(MAX_STATIC_ARTIFACT_BYTES + 1));

  const decision = await detectPublishTarget(workerPath);

  await assert.rejects(() => createUploadPlan(workerPath, decision), /ARTIFACT_BUNDLE_TOO_LARGE/);
});

test('detectPublishTarget treats static and app behavior as fallback decisions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<div id="app"></div>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("app");');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'assets-only');
  assert.equal(decision.requestedFallback, 'auto');
  assert.equal(decision.resolvedFallback, 'index');
  assert.equal(decision.routingMode, 'assets-only');
  assert.equal(decision.confidence, 'medium');
  assert.equal(decision.workerEntry, null);
});

test('detectPublishTarget prefers not-found for multi-page static exports', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-static-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Home</h1>');
  await writeFile(path.join(dir, 'about.html'), '<h1>About</h1>');
  await writeFile(path.join(dir, '404.html'), '<h1>Missing</h1>');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'assets-only');
  assert.equal(decision.resolvedFallback, 'not-found');
  assert.equal(decision.routingMode, 'assets-only');
});

test('detectPublishTarget only treats SPA _redirects rewrites as index fallback signals', async () => {
  const spa = await mkdtemp(path.join(tmpdir(), 'pages-cli-redirects-spa-'));
  const redirects = await mkdtemp(path.join(tmpdir(), 'pages-cli-redirects-ordinary-'));
  test.after(() => rm(spa, { recursive: true, force: true }));
  test.after(() => rm(redirects, { recursive: true, force: true }));
  await writeFile(path.join(spa, 'index.html'), '<div id="app"></div>');
  await writeFile(path.join(spa, '_redirects'), '/* /index.html 200\n');
  await writeFile(path.join(redirects, 'index.html'), '<div id="app"></div>');
  await writeFile(path.join(redirects, 'about.html'), '<h1>About</h1>');
  await writeFile(path.join(redirects, '_redirects'), '/old /new 301\n');

  const spaDecision = await detectPublishTarget(spa, { requestedFallback: 'auto' });
  const ordinaryDecision = await detectPublishTarget(redirects, { requestedFallback: 'auto' });

  assert.equal(spaDecision.resolvedFallback, 'index');
  assert.ok(spaDecision.signals.some((signal) => signal.code === 'EXPLICIT_INDEX_REWRITE_FOUND'));
  assert.equal(ordinaryDecision.resolvedFallback, 'not-found');
  assert.equal(ordinaryDecision.signals.some((signal) => signal.code === 'EXPLICIT_INDEX_REWRITE_FOUND'), false);
});

test('detectPublishTarget recognizes top-level _worker.js as Worker with Assets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-worker-assets-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '_worker.js'), 'export default { fetch() {} };');
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'worker-with-assets');
  assert.equal(decision.workerEntry, '_worker.js');
  assert.equal(decision.routingMode, 'worker-first');
  assert.equal(decision.resolvedFallback, 'index');
});

test('detectPublishTarget does not auto-detect ordinary worker files in directories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-ordinary-worker-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'worker.mjs'), 'export default { fetch() {} };');
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'assets-only');
  assert.equal(decision.workerEntry, null);
});

test('createUploadPlan returns multipart assets with content-type-versioned hashes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-upload-plan-asset-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const content = '<div id="app"></div>';
  await writeFile(path.join(dir, 'index.html'), content);
  await writeFile(path.join(dir, 'same.txt'), content);
  await writeFile(path.join(dir, 'pages.config.json'), '{"site":"ignored"}');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });
  const plan = await createUploadPlan(dir, decision);
  const indexAsset = plan.assetManifest.find((asset) => asset.path === '/index.html');
  const textAsset = plan.assetManifest.find((asset) => asset.path === '/same.txt');
  const legacyContentHash = createHash('sha256').update(content).digest('hex').slice(0, 32);

  assert.equal(plan.fileCount, 2);
  assert.equal(plan.sizeBytes, content.length * 2);
  assert.equal(indexAsset.contentType, 'text/html; charset=utf-8');
  assert.notEqual(indexAsset.hash, legacyContentHash);
  assert.notEqual(indexAsset.hash, textAsset.hash);
  assert.equal(plan.assetFiles.every((file) => file.relativePath.includes(dir) === false), true);
  assert.equal(JSON.stringify(plan).includes('base64'), false);
});

test('createUploadPlan rejects static bundles above asset upload limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), 'x'.repeat(MAX_STATIC_ARTIFACT_BYTES + 1));

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /ARTIFACT_BUNDLE_TOO_LARGE/);
});

test('createUploadPlan counts worker module bytes in upload limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-worker-assets-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), 'x'.repeat(MAX_STATIC_ARTIFACT_BYTES - 2));
  await writeFile(path.join(dir, '_worker.js'), 'export default {};');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /ARTIFACT_BUNDLE_TOO_LARGE/);
});

test('createUploadPlan rejects unbundled relative Worker imports', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-worker-import-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, '_worker.js'), 'import{ok}from"./handler.mjs";\nexport{ok}from"./handler.mjs";');
  await writeFile(path.join(dir, 'handler.mjs'), 'export const ok = true;');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /WORKER_UNBUNDLED_IMPORT_UNSUPPORTED/);
});

test('createUploadPlan rejects too many static files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-static-file-limit-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  for (let index = 0; index <= MAX_STATIC_ARTIFACT_FILES; index += 1) {
    await writeFile(path.join(dir, `${index}.txt`), 'x');
  }

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED/);
});

test('createUploadPlan excludes control files and rejects denylisted files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-upload-plan-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, '_redirects'), '/* /index.html 200');
  await writeFile(path.join(dir, '.env'), 'SECRET=bad');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /PACKAGE_DENYLISTED_FILE/);
});

test('createUploadPlan rejects denylisted files case-insensitively', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-denylist-case-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, '.ENV'), 'SECRET=bad');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /PACKAGE_DENYLISTED_FILE/);
});

test('createUploadPlan rejects symlinks escaping source', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-symlink-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'pages-cli-outside-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  test.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'secret-link.txt'));

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /DETECT_SYMLINK_OUTSIDE_SOURCE/);
});

test('createUploadPlan rejects symlinks resolving into ignored source trees', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-symlink-ignored-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, '.git'));
  await writeFile(path.join(dir, '.git', 'config'), 'secret');
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await symlink(path.join(dir, '.git', 'config'), path.join(dir, 'public-config.txt'));

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /PACKAGE_DENYLISTED_FILE/);
});

test('createUploadPlan rejects symlinked directories inside source', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-symlink-dir-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("ok");');
  await symlink(path.join(dir, 'assets'), path.join(dir, 'linked-assets'));

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /DETECT_SYMLINK_DIRECTORY_UNSUPPORTED/);
});

function hashAsset(bytes, contentType) {
  return createHash('sha256')
    .update('xd-pages-asset-v2\0')
    .update(contentType || 'application/octet-stream')
    .update('\0')
    .update(bytes)
    .digest('hex')
    .slice(0, 32);
}
