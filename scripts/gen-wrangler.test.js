import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/gen-wrangler.sh');
const serverWranglerPath = join(repoRoot, 'apps/server/wrangler.toml');
const kvGatewayWranglerPath = join(repoRoot, 'apps/kv-gateway/wrangler.toml');
const xdadsWranglerPath = join(repoRoot, 'apps/xdads-302/wrangler.toml');

const baseEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
  SITES_KV_NAMESPACE_ID: 'dummy-kv',
  IP_ALLOWLIST: '127.0.0.1,::1',
};

const kvEnv = {
  ...baseEnv,
  SITE_DATA_KV_NAMESPACE_ID: 'dummy-site-data-kv',
  PAGES_CAP_JWT_ACTIVE_KID: 'prod-hs-2026-06',
  PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
};

afterEach(() => {
  rmSync(serverWranglerPath, { force: true });
  rmSync(kvGatewayWranglerPath, { force: true });
  rmSync(xdadsWranglerPath, { force: true });
});

function renderApp(app, envName, env = baseEnv) {
  execFileSync(scriptPath, [app, envName], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function renderServer(envName, env = kvEnv) {
  renderApp('apps/server', envName, env);
  return readFileSync(serverWranglerPath, 'utf8');
}

function renderKvGateway(envName, env = kvEnv) {
  renderApp('apps/kv-gateway', envName, env);
  return readFileSync(kvGatewayWranglerPath, 'utf8');
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
  const env = { ...kvEnv };
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
  assert.match(config, /KV_GATEWAY_SERVICE = "pages-kv-gateway"/);
  assert.match(config, /PAGES_CAP_JWT_ACTIVE_KID = "prod-hs-2026-06"/);
  assert.match(
    config,
    /PAGES_CAP_JWT_KEYS = "prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606"/,
  );
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
  assert.match(config, /KV_GATEWAY_SERVICE = "pages-kv-gateway-staging"/);
  assert.match(config, /pattern = "api-staging\.workers\.xd\.team"/);
});

test('production kv-gateway config renders private production gateway', () => {
  const config = renderKvGateway('production');

  assert.match(config, /name = "pages-kv-gateway"/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /XD_PAGES_ENV = "production"/);
  assert.match(config, /binding = "SITE_DATA"/);
  assert.match(config, /id = "dummy-site-data-kv"/);
  assert.doesNotMatch(config, /pages-kv-gateway-staging/);
  assert.doesNotMatch(config, /staging/);
});

test('staging kv-gateway config renders staging gateway only', () => {
  const config = renderKvGateway('staging');

  assert.match(config, /name = "pages-kv-gateway-staging"/);
  assert.match(config, /XD_PAGES_ENV = "staging"/);
  assert.doesNotMatch(config, /name = "pages-kv-gateway"/);
});

test('server config renders environment-specific kv gateway service name', () => {
  const production = renderServer('production', kvEnv);
  assert.match(production, /KV_GATEWAY_SERVICE = "pages-kv-gateway"/);

  const staging = renderServer('staging', kvEnv);
  assert.match(staging, /KV_GATEWAY_SERVICE = "pages-kv-gateway-staging"/);
});

test('rejects unknown environment', () => {
  const result = runGenerator(['apps/server', 'preview']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /environment/i);
});

test('rejects unsafe IP_ALLOWLIST values', () => {
  const result = runGenerator(['apps/server', 'production'], {
    ...kvEnv,
    IP_ALLOWLIST: '127.0.0.1"bad',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /IP_ALLOWLIST/);
});

test('server config requires PAGES_CAP_JWT_ACTIVE_KID', () => {
  const result = runGenerator(
    ['apps/server', 'production'],
    withoutEnv('PAGES_CAP_JWT_ACTIVE_KID'),
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_CAP_JWT_ACTIVE_KID/);
});

test('server config requires PAGES_CAP_JWT_KEYS', () => {
  const result = runGenerator(['apps/server', 'production'], withoutEnv('PAGES_CAP_JWT_KEYS'));

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_CAP_JWT_KEYS/);
});

test('kv-gateway config requires SITE_DATA_KV_NAMESPACE_ID', () => {
  const result = runGenerator(
    ['apps/kv-gateway', 'production'],
    withoutEnv('SITE_DATA_KV_NAMESPACE_ID'),
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /SITE_DATA_KV_NAMESPACE_ID/);
});

test('kv-gateway config requires PAGES_CAP_JWT_ACTIVE_KID', () => {
  const result = runGenerator(
    ['apps/kv-gateway', 'production'],
    withoutEnv('PAGES_CAP_JWT_ACTIVE_KID'),
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_CAP_JWT_ACTIVE_KID/);
});

test('kv-gateway config requires PAGES_CAP_JWT_KEYS', () => {
  const result = runGenerator(
    ['apps/kv-gateway', 'production'],
    withoutEnv('PAGES_CAP_JWT_KEYS'),
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_CAP_JWT_KEYS/);
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
