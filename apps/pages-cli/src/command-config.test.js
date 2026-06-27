import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readCommandConfig, validateCommandConfig } from './command-config.js';

test('reads explicit xd-cell deploy template and resolves paths from config directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-config-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'project'));
  await writeFile(
    path.join(dir, 'project', 'xd-cell.config.json'),
    JSON.stringify({
      name: 'docs',
      main: './src/index.js',
      assets: {
        directory: './dist',
        not_found_handling: 'single-page-application',
      },
      vars: {
        API_BASE: 'https://api.example.com',
      },
      visibility: 'org',
    })
  );

  assert.deepEqual(await readCommandConfig('project/xd-cell.config.json', { cwd: dir }), {
    name: 'docs',
    main: './src/index.js',
    assets: {
      directory: './dist',
      not_found_handling: 'single-page-application',
    },
    vars: {
      API_BASE: 'https://api.example.com',
    },
    visibility: 'org',
    configPath: 'project/xd-cell.config.json',
    configDir: path.join(dir, 'project'),
  });
}
);

test('auto-discovers xd-cell.config.json only in the current working directory', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-config-'));
  const child = path.join(parent, 'child');
  test.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(child);
  await writeFile(path.join(parent, 'xd-cell.config.json'), JSON.stringify({ name: 'parent', assets: { directory: './dist' } }));
  await writeFile(path.join(parent, 'pages.config.json'), JSON.stringify({ site: 'legacy', source: './dist' }));

  assert.equal(await readCommandConfig(null, { cwd: child, discover: true }), null);
  assert.equal(await readCommandConfig(null, { cwd: child }), null);

  await writeFile(path.join(child, 'xd-cell.config.json'), JSON.stringify({ name: 'child', assets: { directory: './dist' } }));
  assert.deepEqual(await readCommandConfig(null, { cwd: child, discover: true }), {
    name: 'child',
    assets: { directory: './dist', not_found_handling: 'none' },
    configPath: 'xd-cell.config.json',
    configDir: child,
  });
});

test('missing auto-discovered config is ignored but missing explicit config is an error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-config-'));
  test.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await readCommandConfig(null, { cwd: dir, discover: true }), null);
  await assert.rejects(() => readCommandConfig('xd-cell.config.json', { cwd: dir }), { code: 'ENOENT' });
});

test('normalizes worker-only assets-only and worker-with-assets templates', () => {
  assert.deepEqual(
    validateCommandConfig({
      name: 'demo',
      main: './src/index.js',
      vars: { FEATURE_FLAG: 'true' },
      visibility: 'owner',
    }),
    {
      name: 'demo',
      main: './src/index.js',
      vars: { FEATURE_FLAG: 'true' },
      visibility: 'owner',
    }
  );

  assert.deepEqual(
    validateCommandConfig({
      name: 'demo',
      assets: {
        directory: './dist',
        not_found_handling: '404-page',
      },
    }),
    {
      name: 'demo',
      assets: {
        directory: './dist',
        not_found_handling: '404-page',
      },
    }
  );

  assert.deepEqual(
    validateCommandConfig({
      name: 'demo',
      main: './src/index.js',
      assets: { directory: './dist' },
    }),
    {
      name: 'demo',
      main: './src/index.js',
      assets: {
        directory: './dist',
        not_found_handling: 'none',
      },
    }
  );
});

test('rejects old config fields and fallback aliases with actionable errors', () => {
  for (const field of ['site', 'source', 'dir', 'env', 'secrets', 'environment', 'fallback']) {
    assert.throws(() => validateCommandConfig({ [field]: 'legacy' }), new RegExp(`COMMAND_CONFIG_LEGACY_FIELD:${field}`));
  }
  assert.throws(
    () => validateCommandConfig({ name: 'demo', worker: { entry: './worker.mjs' } }),
    /COMMAND_CONFIG_LEGACY_FIELD:worker/
  );
  assert.throws(
    () => validateCommandConfig({ name: 'demo', assets: { directory: './dist', fallback: 'spa' } }),
    /COMMAND_CONFIG_LEGACY_FIELD:assets\.fallback/
  );
});

test('rejects unknown fields secret-like fields invalid paths legacy API origins and invalid enums', () => {
  assert.throws(() => validateCommandConfig({ name: 'docs', owner: 'alice' }), /COMMAND_CONFIG_UNKNOWN_FIELD:owner/);
  assert.throws(() => validateCommandConfig({ name: 'docs', accessKey: 'secret' }), /COMMAND_CONFIG_SECRET_FIELD:accessKey/);
  assert.throws(() => validateCommandConfig({ name: 'https://demo.workers.xd.team' }), /COMMAND_CONFIG_NAME_INVALID/);
  assert.throws(
    () => validateCommandConfig({ assets: { directory: 'https://api.workers.xd.team/deploy' } }),
    /COMMAND_CONFIG_LEGACY_API_UNSUPPORTED/
  );
  assert.throws(() => validateCommandConfig({ visibility: 'public' }), /COMMAND_CONFIG_VISIBILITY_INVALID/);
  assert.throws(
    () => validateCommandConfig({ assets: { directory: './dist', not_found_handling: 'spa' } }),
    /COMMAND_CONFIG_NOT_FOUND_HANDLING_INVALID/
  );
  assert.throws(() => validateCommandConfig({ main: '../worker.mjs' }), /COMMAND_CONFIG_MAIN_INVALID/);
  assert.throws(() => validateCommandConfig({ assets: { directory: '../dist' } }), /COMMAND_CONFIG_ASSETS_DIRECTORY_INVALID/);
});

test('validates vars as non-sensitive Worker binding strings', () => {
  assert.deepEqual(validateCommandConfig({ vars: { API_BASE: 'https://api.example.com' } }), {
    vars: { API_BASE: 'https://api.example.com' },
  });
  assert.throws(() => validateCommandConfig({ vars: null }), /COMMAND_CONFIG_VARS_INVALID/);
  assert.throws(() => validateCommandConfig({ vars: ['API_BASE'] }), /COMMAND_CONFIG_VARS_INVALID/);
  assert.throws(() => validateCommandConfig({ vars: { API_BASE: 1 } }), /COMMAND_CONFIG_VAR_VALUE_INVALID:API_BASE/);
  assert.throws(() => validateCommandConfig({ vars: { 'api-base': 'x' } }), /COMMAND_CONFIG_BINDING_NAME_INVALID:api-base/);
  assert.throws(() => validateCommandConfig({ vars: { API_TOKEN: 'x' } }), /COMMAND_CONFIG_VAR_SECRET_LIKE:API_TOKEN/);
  assert.throws(() => validateCommandConfig({ vars: { XD_CELL_FLAG: 'x' } }), /COMMAND_CONFIG_BINDING_RESERVED:XD_CELL_FLAG/);
  assert.throws(() => validateCommandConfig({ vars: { ASSETS: 'x' } }), /COMMAND_CONFIG_BINDING_RESERVED:ASSETS/);
});
