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
      site: 'docs',
      source: './dist',
      visibility: 'org',
      fallback: 'auto',
    })
  );

  assert.deepEqual(await readCommandConfig('pages.config.json', { cwd: dir }), {
    site: 'docs',
    source: './dist',
    visibility: 'org',
    fallback: 'auto',
  });
});

test('auto-discovers pages.config.json when requested', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-config-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'pages.config.json'), JSON.stringify({ site: 'docs', source: './dist' }));

  assert.deepEqual(await readCommandConfig(null, { cwd: dir, discover: true }), {
    site: 'docs',
    source: './dist',
  });
  assert.equal(await readCommandConfig(null, { cwd: dir }), null);
});

test('missing auto-discovered config is ignored but missing explicit config is an error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-config-'));
  test.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await readCommandConfig(null, { cwd: dir, discover: true }), null);
  await assert.rejects(() => readCommandConfig('pages.config.json', { cwd: dir }), { code: 'ENOENT' });
});

test('accepts source fallback and worker entry command config', () => {
  assert.deepEqual(
    validateCommandConfig({
      site: 'demo',
      source: './dist',
      fallback: 'index',
      worker: { entry: './worker.mjs' },
    }),
    {
      site: 'demo',
      source: './dist',
      fallback: 'index',
      worker: { entry: 'worker.mjs' },
    }
  );
});

test('rejects worker entries outside source and legacy intent fields', () => {
  assert.throws(
    () => validateCommandConfig({ source: './dist', worker: { entry: '../worker.mjs' } }),
    /COMMAND_CONFIG_WORKER_ENTRY_INVALID/
  );
  assert.throws(() => validateCommandConfig({ artifactKind: 'spa' }), /COMMAND_CONFIG_UNKNOWN_FIELD:artifactKind/);
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

test('keeps environment config support hidden for backwards compatibility', () => {
  assert.deepEqual(validateCommandConfig({ environment: 'staging' }), { environment: 'staging' });
});
