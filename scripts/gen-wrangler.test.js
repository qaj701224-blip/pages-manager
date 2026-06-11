import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/gen-wrangler.sh');
const serverWranglerPath = join(repoRoot, 'apps/server/wrangler.toml');

const baseEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
  SITES_KV_NAMESPACE_ID: 'dummy-kv',
  IP_ALLOWLIST: '127.0.0.1,::1',
};

afterEach(() => {
  rmSync(serverWranglerPath, { force: true });
});

function renderServer(envName, env = baseEnv) {
  execFileSync(scriptPath, ['apps/server', envName], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });

  return readFileSync(serverWranglerPath, 'utf8');
}

function runGenerator(args, env = baseEnv) {
  return spawnSync(scriptPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

test('production server config renders production values only', () => {
  const config = renderServer('production');

  assert.match(config, /name = "pages-manager"/);
  assert.match(config, /PUBLIC_ENVIRONMENT = "production"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.workers\.xd\.team"/);
  assert.match(config, /PUBLIC_MANAGER_DEV_BASE = "https:\/\/pages-manager\.xd-cf-2022\.workers\.dev"/);
  assert.match(config, /WORKER_PREFIX = "pages-"/);
  assert.match(config, /pattern = "api\.workers\.xd\.team"/);
  assert.doesNotMatch(config, /api-staging/);
  assert.doesNotMatch(config, /pages-staging-/);
});

test('staging server config renders staging values', () => {
  const config = renderServer('staging');

  assert.match(config, /name = "pages-manager-staging"/);
  assert.match(config, /PUBLIC_ENVIRONMENT = "staging"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.workers\.xd\.team"/);
  assert.match(config, /PUBLIC_MANAGER_DEV_BASE = "https:\/\/pages-manager-staging\.xd-cf-2022\.workers\.dev"/);
  assert.match(config, /DOMAIN_LABEL = "-staging"/);
  assert.match(config, /WORKER_PREFIX = "pages-staging-"/);
  assert.match(config, /pattern = "api-staging\.workers\.xd\.team"/);
});

test('rejects unknown environment', () => {
  const result = runGenerator(['apps/server', 'preview']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /environment/i);
});

test('rejects unsafe IP_ALLOWLIST values', () => {
  const result = runGenerator(['apps/server', 'production'], {
    ...baseEnv,
    IP_ALLOWLIST: '127.0.0.1"bad',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /IP_ALLOWLIST/);
});
