import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readProjectConfig, validateProjectConfig, writeProjectConfig } from './project-config.js';

test('reads null when .pages.json is absent and writes stable project binding', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-project-'));
  tAfter(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await readProjectConfig(dir), null);

  await writeProjectConfig(dir, {
    version: 1,
    environment: 'production',
    siteId: 'site_1',
    slug: 'docs',
    defaultArtifactKind: 'static',
  });

  assert.equal(
    await readFile(path.join(dir, '.pages.json'), 'utf8'),
    `${JSON.stringify(
      {
        version: 1,
        environment: 'production',
        siteId: 'site_1',
        slug: 'docs',
        defaultArtifactKind: 'static',
      },
      null,
      2
    )}\n`
  );
  assert.deepEqual(await readProjectConfig(dir), {
    version: 1,
    environment: 'production',
    siteId: 'site_1',
    slug: 'docs',
    defaultArtifactKind: 'static',
  });
});

test('rejects secrets, Cloudflare ids, and v1 domains in .pages.json', () => {
  assert.throws(() => validateProjectConfig({ version: 1, token: 'secret' }), /PROJECT_CONFIG_SECRET_FIELD/);
  assert.throws(() => validateProjectConfig({ version: 1, nested: { accessKey: 'secret' } }), /PROJECT_CONFIG_SECRET_FIELD/);
  assert.throws(() => validateProjectConfig({ version: 1, cloudflareAccountId: 'abc' }), /PROJECT_CONFIG_SECRET_FIELD/);
  assert.throws(() => validateProjectConfig({ version: 1, url: 'https://demo.workers.xd.team' }), /PROJECT_CONFIG_V1_DOMAIN/);
});

test('rejects malformed project binding fields', () => {
  assert.throws(() => validateProjectConfig(null), /PROJECT_CONFIG_INVALID/);
  assert.throws(() => validateProjectConfig({ version: 2 }), /PROJECT_CONFIG_VERSION_INVALID/);
  assert.throws(() => validateProjectConfig({ version: 1, environment: 'preview' }), /PROJECT_CONFIG_ENV_INVALID/);
  assert.throws(() => validateProjectConfig({ version: 1, defaultArtifactKind: 'zip' }), /PROJECT_CONFIG_ARTIFACT_INVALID/);
});

function tAfter(fn) {
  test.after(fn);
}
