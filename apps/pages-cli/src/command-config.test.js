import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readCommandConfig, validateCommandConfig } from './command-config.js';

test('reads explicit one-shot command config', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-config-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, 'pages.config.json'),
    JSON.stringify({
      environment: 'staging',
      site: 'docs',
      dir: './dist',
      visibility: 'org',
      artifactKind: 'spa',
    })
  );

  assert.deepEqual(await readCommandConfig('pages.config.json', { cwd: dir }), {
    environment: 'staging',
    site: 'docs',
    dir: './dist',
    visibility: 'org',
    artifactKind: 'spa',
  });
});

test('rejects unknown fields, secret-like fields, old domains, and invalid enums', () => {
  assert.throws(() => validateCommandConfig({ site: 'docs', owner: 'alice' }), /COMMAND_CONFIG_UNKNOWN_FIELD:owner/);
  assert.throws(() => validateCommandConfig({ site: 'docs', accessKey: 'secret' }), /COMMAND_CONFIG_SECRET_FIELD:accessKey/);
  assert.throws(
    () => validateCommandConfig({ site: 'https://demo.workers.xd.team' }),
    /COMMAND_CONFIG_LEGACY_DOMAIN_UNSUPPORTED/
  );
  assert.throws(() => validateCommandConfig({ environment: 'local' }), /COMMAND_CONFIG_ENVIRONMENT_INVALID/);
  assert.throws(() => validateCommandConfig({ visibility: 'public' }), /COMMAND_CONFIG_VISIBILITY_INVALID/);
});
