import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/gen-wrangler.sh');
const serverWranglerPath = join(repoRoot, 'apps/server/wrangler.toml');
const xdadsWranglerPath = join(repoRoot, 'apps/xdads-302/wrangler.toml');

const baseEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
  SITES_KV_NAMESPACE_ID: 'dummy-kv',
  IP_ALLOWLIST: '127.0.0.1,::1',
};

afterEach(() => {
  rmSync(serverWranglerPath, { force: true });
  rmSync(xdadsWranglerPath, { force: true });
});

function renderApp(app, envName, env = baseEnv) {
  execFileSync(scriptPath, [app, envName], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function renderServer(envName, env = baseEnv) {
  renderApp('apps/server', envName, env);
  return readFileSync(serverWranglerPath, 'utf8');
}

function renderXdads(envName, env = { ...baseEnv, OLD_ZONE_ID: 'dummy-old-zone' }) {
  renderApp('apps/xdads-302', envName, env);
  return readFileSync(xdadsWranglerPath, 'utf8');
}

function runGenerator(args, env = baseEnv) {
  return spawnSync(scriptPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function withoutEnv(name) {
  const env = { ...baseEnv };
  delete env[name];
  return env;
}

test('production server config renders production values only', () => {
  const config = renderServer('production');

  assert.match(config, /name = "pages-manager"/);
  assert.match(config, /PUBLIC_ENVIRONMENT = "production"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.workers\.xd\.team"/);
  assert.match(config, /PUBLIC_MANAGER_DEV_BASE = "https:\/\/pages-manager\.xd-cf-2022\.workers\.dev"/);
  assert.match(config, /WORKER_PREFIX = "pages-"/);
  assert.doesNotMatch(config, /KV_GATEWAY_SERVICE/);
  assert.doesNotMatch(config, /PAGES_CAP_JWT_ACTIVE_KID/);
  assert.doesNotMatch(config, /PAGES_CAP_JWT_KEYS/);
  assert.match(config, /pattern = "api\.workers\.xd\.team"/);
  assert.doesNotMatch(config, /api-staging/);
  assert.doesNotMatch(config, /pages-staging-/);
  assert.doesNotMatch(config, /pages-kv-gateway-staging/);
});

test('staging server config renders staging values', () => {
  const config = renderServer('staging');

  assert.match(config, /name = "pages-manager-staging"/);
  assert.match(config, /PUBLIC_ENVIRONMENT = "staging"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.workers\.xd\.team"/);
  assert.match(config, /PUBLIC_MANAGER_DEV_BASE = "https:\/\/pages-manager-staging\.xd-cf-2022\.workers\.dev"/);
  assert.match(config, /DOMAIN_LABEL = "-staging"/);
  assert.match(config, /WORKER_PREFIX = "pages-staging-"/);
  assert.doesNotMatch(config, /KV_GATEWAY_SERVICE/);
  assert.doesNotMatch(config, /PAGES_CAP_JWT_ACTIVE_KID/);
  assert.doesNotMatch(config, /PAGES_CAP_JWT_KEYS/);
  assert.match(config, /pattern = "api-staging\.workers\.xd\.team"/);
});

test('rejects unknown environment', () => {
  const result = runGenerator(['apps/server', 'preview']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /environment/i);
});

test('v1 wrangler generator rejects kv-gateway because v2 renderer owns it', () => {
  const result = runGenerator(['apps/kv-gateway', 'production']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /unsupported app: apps\/kv-gateway/);
});

test('rejects unsafe IP_ALLOWLIST values', () => {
  const result = runGenerator(['apps/server', 'production'], {
    ...baseEnv,
    IP_ALLOWLIST: '127.0.0.1"bad',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /IP_ALLOWLIST/);
});

test('server config does not require capability registry env vars', () => {
  const result = runGenerator(['apps/server', 'production'], withoutEnv('PAGES_CAP_JWT_KEYS'));

  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  const config = readFileSync(serverWranglerPath, 'utf8');
  assert.doesNotMatch(config, /PAGES_CAP_JWT/);
  assert.doesNotMatch(config, /KV_GATEWAY_SERVICE/);
});

test('xdads production config renders account id and old zone id', () => {
  const config = renderXdads('production');
  const zoneMatches = [...config.matchAll(/zone_id = "dummy-old-zone"/g)];

  assert.match(config, /account_id = "dummy-account"/);
  assert.equal(zoneMatches.length, 2);
  assert.doesNotMatch(config, /<OLD_ZONE_ID>/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
  assert.doesNotMatch(config, /<[^>]+>/);
});

test('xdads production config requires OLD_ZONE_ID', () => {
  const result = runGenerator(['apps/xdads-302', 'production']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /OLD_ZONE_ID/);
});

test('xdads staging config is rejected', () => {
  const result = runGenerator(['apps/xdads-302', 'staging'], {
    ...baseEnv,
    OLD_ZONE_ID: 'dummy-old-zone',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /only supports production/);
});
