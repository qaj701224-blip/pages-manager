import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashArtifact, inferArtifactKind } from './artifact.js';

test('hashArtifact is deterministic for directories and ignores .pages.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-artifact-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("hi");');

  const first = await hashArtifact(dir);
  await writeFile(path.join(dir, '.pages.json'), '{"siteId":"site_1"}');
  const second = await hashArtifact(dir);

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.fileCount, 2);
  assert.equal(first.sizeBytes, '<h1>Hello</h1>'.length + 'console.log("hi");'.length);
});

test('inferArtifactKind detects worker files and SPA directories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-kind-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'worker.mjs'), 'export default {};');
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'dist', 'index.html'), '<div id="app"></div>');

  assert.equal(await inferArtifactKind(path.join(dir, 'worker.mjs')), 'worker');
  assert.equal(await inferArtifactKind(path.join(dir, 'dist')), 'spa');
});
