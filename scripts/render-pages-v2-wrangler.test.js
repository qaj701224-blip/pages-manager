import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/render-pages-v2-wrangler.mjs');
const pagesApiWranglerPath = join(repoRoot, 'apps/pages-api/wrangler.toml');
const pagesAuthWranglerPath = join(repoRoot, 'apps/pages-auth/wrangler.toml');
const pagesRouterWranglerPath = join(repoRoot, 'apps/pages-router/wrangler.toml');
const kvGatewayWranglerPath = join(repoRoot, 'apps/kv-gateway/wrangler.toml');

const baseEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
  D1_DATABASE_ID: 'dummy-pages-d1',
  ROUTE_SNAPSHOTS_KV_ID: 'dummy-route-snapshots-kv',
  SITE_DATA_KV_ID: 'dummy-site-data-kv',
  ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_2026_06',
  ACCESS_KEY_PEPPERS: 'pepper_2026_06:ACCESS_KEY_PEPPER_202606',
  PAGES_EXECUTION_MODE: 'normal-worker-slot',
  PAGES_NORMAL_WORKER_SLOT_COUNT: '2',
  PAGES_SESSION_JWT_ACTIVE_KID: 'pages-session-2026-06',
  PAGES_SESSION_JWT_KEYS: 'pages-session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606',
  PAGES_CAP_JWT_ACTIVE_KID: 'pages-cap-2026-06',
  PAGES_CAP_JWT_KEYS: 'pages-cap-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
  ROUTER_IP_ALLOWLIST_CIDRS: '10.0.0.0/8,192.168.0.0/16',
  SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
  SSO_TOKEN_URL: 'https://sso.example.test/oauth/token',
  SSO_PROFILE_URL: 'https://sso.example.test/oauth/profile',
  SSO_CLIENT_ID: 'xd_pages_test',
};

afterEach(() => {
  rmSync(pagesApiWranglerPath, { force: true });
  rmSync(pagesAuthWranglerPath, { force: true });
  rmSync(pagesRouterWranglerPath, { force: true });
  rmSync(kvGatewayWranglerPath, { force: true });
});

function renderApp(app, environment, env = baseEnv) {
  execFileSync(process.execPath, [scriptPath, app, environment], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function renderPagesApi(environment, env = baseEnv) {
  renderApp('apps/pages-api', environment, env);
  return readFileSync(pagesApiWranglerPath, 'utf8');
}

function renderPagesAuth(environment, env = baseEnv) {
  renderApp('apps/pages-auth', environment, env);
  return readFileSync(pagesAuthWranglerPath, 'utf8');
}

function renderPagesRouter(environment, env = baseEnv) {
  renderApp('apps/pages-router', environment, env);
  return readFileSync(pagesRouterWranglerPath, 'utf8');
}

function renderKvGateway(environment, env = baseEnv) {
  renderApp('apps/kv-gateway', environment, env);
  return readFileSync(kvGatewayWranglerPath, 'utf8');
}

function runRenderer(args, env = baseEnv) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
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

test('generated pages v2 wrangler configs are ignored', () => {
  const result = spawnSync(
    'git',
    [
      'check-ignore',
      'apps/pages-api/wrangler.toml',
      'apps/pages-auth/wrangler.toml',
      'apps/pages-router/wrangler.toml',
      'apps/kv-gateway/wrangler.toml',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /apps\/pages-api\/wrangler\.toml/);
  assert.match(result.stdout, /apps\/pages-auth\/wrangler\.toml/);
  assert.match(result.stdout, /apps\/pages-router\/wrangler\.toml/);
  assert.match(result.stdout, /apps\/kv-gateway\/wrangler\.toml/);
});

test('production pages-api config renders explicit production template values only', () => {
  const config = renderPagesApi('production');

  assert.match(config, /name = "pages-api"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /PAGES_ENV = "production"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_SITE_SUFFIX = "pages\.xd\.team"/);
  assert.match(config, /WFP_DISPATCH_NAMESPACE = "pages-production"/);
  assert.match(config, /PAGES_EXECUTION_MODE = "normal-worker-slot"/);
  assert.match(config, /WFP_COMPATIBILITY_DATE = "2026-06-15"/);
  assert.match(config, /ACCESS_KEY_ACTIVE_PEPPER_ID = "pepper_2026_06"/);
  assert.match(config, /ACCESS_KEY_PEPPERS = "pepper_2026_06:ACCESS_KEY_PEPPER_202606"/);
  assert.match(config, /database_name = "pages-v2-metadata"/);
  assert.match(config, /database_id = "dummy-pages-d1"/);
  assert.match(config, /binding = "ROUTE_SNAPSHOTS"/);
  assert.match(config, /id = "dummy-route-snapshots-kv"/);
  assert.match(config, /binding = "PAGES_AUTH"/);
  assert.match(config, /service = "pages-auth"/);
  assert.doesNotMatch(config, /api-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /auth-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /pages-staging/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging pages-api config renders explicit staging template values', () => {
  const config = renderPagesApi('staging');

  assert.match(config, /name = "pages-api-staging"/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth-staging\.pages\.xd\.team"/);
  assert.match(config, /WFP_DISPATCH_NAMESPACE = "pages-staging"/);
  assert.match(config, /ACCESS_KEY_ACTIVE_PEPPER_ID = "pepper_2026_06"/);
  assert.match(config, /ACCESS_KEY_PEPPERS = "pepper_2026_06:ACCESS_KEY_PEPPER_202606"/);
  assert.match(config, /database_name = "pages-v2-metadata-staging"/);
  assert.match(config, /service = "pages-auth-staging"/);
});

test('pages-api config accepts explicit WFP compatibility date', () => {
  const config = renderPagesApi('production', {
    ...baseEnv,
    WFP_COMPATIBILITY_DATE: '2026-07-01',
  });

  assert.match(config, /WFP_COMPATIBILITY_DATE = "2026-07-01"/);
});

test('pages-api config requires resource ids and access key pepper registry', () => {
  for (const name of [
    'CLOUDFLARE_ACCOUNT_ID',
    'D1_DATABASE_ID',
    'ROUTE_SNAPSHOTS_KV_ID',
    'ACCESS_KEY_ACTIVE_PEPPER_ID',
    'ACCESS_KEY_PEPPERS',
    'PAGES_EXECUTION_MODE',
  ]) {
    const result = runRenderer(['apps/pages-api', 'production'], withoutEnv(name));

    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(`${result.stderr}${result.stdout}`, new RegExp(name));
  }
});

test('production pages-auth config renders explicit production auth settings only', () => {
  const config = renderPagesAuth('production');

  assert.match(config, /name = "pages-auth"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /PAGES_ENV = "production"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.pages\.xd\.team"/);
  assert.match(config, /OAUTH_STATE_TTL_SECONDS = "300"/);
  assert.match(config, /CLI_LOGIN_TTL_SECONDS = "600"/);
  assert.match(config, /AUTH_SESSION_IDLE_TTL_SECONDS = "1209600"/);
  assert.match(config, /AUTH_SESSION_ABSOLUTE_TTL_SECONDS = "2592000"/);
  assert.match(config, /SITE_SESSION_IDLE_TTL_SECONDS = "604800"/);
  assert.match(config, /SITE_SESSION_ABSOLUTE_TTL_SECONDS = "2592000"/);
  assert.match(config, /PAGES_SESSION_JWT_ACTIVE_KID = "pages-session-2026-06"/);
  assert.match(
    config,
    /PAGES_SESSION_JWT_KEYS = "pages-session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606"/,
  );
  assert.match(config, /SSO_AUTHORIZATION_URL = "https:\/\/sso\.example\.test\/oauth\/authorize"/);
  assert.match(
    config,
    /SSO_REDIRECT_URI = "https:\/\/auth\.pages\.xd\.team\/\.xd-pages\/auth\/callback"/,
  );
  assert.match(config, /SSO_TOKEN_URL = "https:\/\/sso\.example\.test\/oauth\/token"/);
  assert.match(config, /SSO_PROFILE_URL = "https:\/\/sso\.example\.test\/oauth\/profile"/);
  assert.match(config, /SSO_CLIENT_ID = "xd_pages_test"/);
  assert.match(config, /SSO_ALLOWED_USER_SCOPE = "xindong"/);
  assert.match(config, /binding = "PAGES_API"/);
  assert.match(config, /service = "pages-api"/);
  assert.doesNotMatch(config, /api-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /auth-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /service = "pages-api-staging"/);
  assert.doesNotMatch(config, /SSO_CLIENT_SECRET|CF_API_TOKEN|CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging pages-auth config renders explicit staging auth settings', () => {
  const config = renderPagesAuth('staging');

  assert.match(config, /name = "pages-auth-staging"/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.pages\.xd\.team"/);
  assert.match(
    config,
    /SSO_REDIRECT_URI = "https:\/\/auth-staging\.pages\.xd\.team\/\.xd-pages\/auth\/callback"/,
  );
  assert.match(config, /service = "pages-api-staging"/);
});

test('pages-auth config supports explicit ttl and SSO scope overrides', () => {
  const config = renderPagesAuth('production', {
    ...baseEnv,
    AUTH_SESSION_IDLE_TTL_SECONDS: '2592000',
    SITE_SESSION_IDLE_TTL_SECONDS: '2592000',
    SSO_ALLOWED_USER_SCOPE: 'company-all',
  });

  assert.match(config, /AUTH_SESSION_IDLE_TTL_SECONDS = "2592000"/);
  assert.match(config, /SITE_SESSION_IDLE_TTL_SECONDS = "2592000"/);
  assert.match(config, /SSO_ALLOWED_USER_SCOPE = "company-all"/);
});

test('pages-auth config requires session signing registry and SSO config', () => {
  for (const name of [
    'PAGES_SESSION_JWT_ACTIVE_KID',
    'PAGES_SESSION_JWT_KEYS',
    'SSO_AUTHORIZATION_URL',
    'SSO_TOKEN_URL',
    'SSO_PROFILE_URL',
    'SSO_CLIENT_ID',
  ]) {
    const result = runRenderer(['apps/pages-auth', 'production'], withoutEnv(name));

    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(`${result.stderr}${result.stdout}`, new RegExp(name));
  }
});

test('pages-auth config rejects TOML-unsafe SSO values', () => {
  const result = runRenderer(['apps/pages-auth', 'production'], {
    ...baseEnv,
    SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/"bad"',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /SSO_AUTHORIZATION_URL/);
});

test('pages-auth config requires production SSO URLs to use HTTPS', () => {
  const result = runRenderer(['apps/pages-auth', 'production'], {
    ...baseEnv,
    SSO_TOKEN_URL: 'http://sso.example.test/oauth/token',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /SSO_TOKEN_URL must be an HTTPS URL/);
});

test('pages-auth config rejects invalid TTL overrides', () => {
  const result = runRenderer(['apps/pages-auth', 'production'], {
    ...baseEnv,
    AUTH_SESSION_IDLE_TTL_SECONDS: '0',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /AUTH_SESSION_IDLE_TTL_SECONDS/);
});

test('pages-api config rejects invalid WFP compatibility date', () => {
  const result = runRenderer(['apps/pages-api', 'production'], {
    ...baseEnv,
    WFP_COMPATIBILITY_DATE: 'June 15 2026',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /WFP_COMPATIBILITY_DATE/);
});

test('pages-api config rejects invalid execution mode', () => {
  const result = runRenderer(['apps/pages-api', 'production'], {
    ...baseEnv,
    PAGES_EXECUTION_MODE: 'auto',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_EXECUTION_MODE/);
});

test('pages-api config rejects unsafe access key pepper registry', () => {
  const unsafeId = runRenderer(['apps/pages-api', 'production'], {
    ...baseEnv,
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'bad:id',
  });
  const unsafeSecretName = runRenderer(['apps/pages-api', 'production'], {
    ...baseEnv,
    ACCESS_KEY_PEPPERS: 'pepper_2026_06:REAL_SECRET_VALUE',
  });

  assert.notEqual(unsafeId.status, 0);
  assert.match(`${unsafeId.stderr}${unsafeId.stdout}`, /ACCESS_KEY_ACTIVE_PEPPER_ID/);
  assert.notEqual(unsafeSecretName.status, 0);
  assert.match(`${unsafeSecretName.stderr}${unsafeSecretName.stdout}`, /ACCESS_KEY_PEPPERS/);
});

test('pages v2 renderer rejects unsafe JWT key registries', () => {
  const badSessionSecret = runRenderer(['apps/pages-auth', 'production'], {
    ...baseEnv,
    PAGES_SESSION_JWT_KEYS: 'pages-session-2026-06:HS256:REAL_SECRET_VALUE',
  });
  const badCapabilityAlg = runRenderer(['apps/pages-router', 'production'], {
    ...baseEnv,
    PAGES_CAP_JWT_KEYS: 'pages-cap-2026-06:RS256:PAGES_CAP_JWT_SECRET_202606',
  });
  const missingActiveKid = runRenderer(['apps/kv-gateway', 'production'], {
    ...baseEnv,
    PAGES_CAP_JWT_ACTIVE_KID: 'pages-cap-missing',
  });

  assert.notEqual(badSessionSecret.status, 0);
  assert.match(`${badSessionSecret.stderr}${badSessionSecret.stdout}`, /PAGES_SESSION_JWT_KEYS/);
  assert.notEqual(badCapabilityAlg.status, 0);
  assert.match(`${badCapabilityAlg.stderr}${badCapabilityAlg.stdout}`, /PAGES_CAP_JWT_KEYS/);
  assert.notEqual(missingActiveKid.status, 0);
  assert.match(`${missingActiveKid.stderr}${missingActiveKid.stdout}`, /PAGES_CAP_JWT_ACTIVE_KID/);
});

test('production pages-router config renders explicit production fast-path settings only', () => {
  const config = renderPagesRouter('production');

  assert.match(config, /name = "pages-router"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /PAGES_ENV = "production"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_SITE_SUFFIX = "pages\.xd\.team"/);
  assert.match(config, /ROUTE_CACHE_TTL_SECONDS = "10"/);
  assert.match(config, /ROUTER_IP_ALLOWLIST_CIDRS = "10\.0\.0\.0\/8,192\.168\.0\.0\/16"/);
  assert.match(config, /ROUTER_JWKS_URL = "https:\/\/auth\.pages\.xd\.team\/\.xd-pages\/jwks\.json"/);
  assert.match(config, /PAGES_SESSION_JWT_ISSUER = "pages-router"/);
  assert.match(config, /PAGES_SESSION_JWT_ACTIVE_KID = "pages-session-2026-06"/);
  assert.match(config, /PAGES_CAP_JWT_ACTIVE_KID = "pages-cap-2026-06"/);
  assert.match(config, /PAGES_CAP_JWT_KEYS = "pages-cap-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606"/);
  assert.match(config, /SITE_SESSION_IDLE_TTL_SECONDS = "604800"/);
  assert.match(config, /SITE_SESSION_FRESHNESS_TTL_SECONDS = "900"/);
  assert.match(config, /INTERNAL_WORKER_JWT_TTL_SECONDS = "60"/);
  assert.match(config, /binding = "PAGES_AUTH"/);
  assert.match(config, /service = "pages-auth"/);
  assert.match(config, /binding = "XD_PAGES_KV_GATEWAY"/);
  assert.match(config, /service = "pages-kv-gateway"/);
  assert.match(config, /binding = "SITE_SLOT_001"/);
  assert.match(config, /service = "pages-v2-production-slot-001"/);
  assert.match(config, /binding = "SITE_SLOT_002"/);
  assert.match(config, /service = "pages-v2-production-slot-002"/);
  assert.match(config, /binding = "ROUTE_SNAPSHOTS"/);
  assert.match(config, /id = "dummy-route-snapshots-kv"/);
  assert.doesNotMatch(config, /binding = "PAGES_DISPATCH"/);
  assert.doesNotMatch(config, /namespace = "pages-production"/);
  assert.doesNotMatch(config, /api-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /auth-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /namespace = "pages-staging"/);
  assert.doesNotMatch(config, /service = "pages-auth-staging"/);
  assert.doesNotMatch(config, /CF_API_TOKEN|CLOUDFLARE_API_TOKEN|SSO_CLIENT_SECRET/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging pages-router config renders explicit staging fast-path settings', () => {
  const config = renderPagesRouter('staging');

  assert.match(config, /name = "pages-router-staging"/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.pages\.xd\.team"/);
  assert.match(
    config,
    /ROUTER_JWKS_URL = "https:\/\/auth-staging\.pages\.xd\.team\/\.xd-pages\/jwks\.json"/,
  );
  assert.match(config, /service = "pages-auth-staging"/);
  assert.match(config, /binding = "XD_PAGES_KV_GATEWAY"/);
  assert.match(config, /service = "pages-kv-gateway-staging"/);
  assert.match(config, /binding = "SITE_SLOT_001"/);
  assert.match(config, /service = "pages-v2-staging-slot-001"/);
  assert.match(config, /binding = "SITE_SLOT_002"/);
  assert.match(config, /service = "pages-v2-staging-slot-002"/);
  assert.doesNotMatch(config, /binding = "PAGES_DISPATCH"/);
  assert.doesNotMatch(config, /namespace = "pages-staging"/);
});

test('pages-router config renders WFP dispatch namespace and omits slot bindings in wfp mode', () => {
  const config = renderPagesRouter('production', {
    ...baseEnv,
    PAGES_EXECUTION_MODE: 'wfp',
    PAGES_NORMAL_WORKER_SLOT_COUNT: '',
  });

  assert.doesNotMatch(config, /SITE_SLOT_001/);
  assert.doesNotMatch(config, /pages-v2-production-slot-001/);
  assert.match(config, /binding = "PAGES_DISPATCH"/);
  assert.match(config, /namespace = "pages-production"/);
});

test('pages-router config can keep slot bindings in wfp mode while draining slot routes', () => {
  const config = renderPagesRouter('production', {
    ...baseEnv,
    PAGES_EXECUTION_MODE: 'wfp',
    PAGES_NORMAL_WORKER_SLOT_COUNT: '2',
  });

  assert.match(config, /binding = "PAGES_DISPATCH"/);
  assert.match(config, /namespace = "pages-production"/);
  assert.match(config, /binding = "SITE_SLOT_001"/);
  assert.match(config, /service = "pages-v2-production-slot-001"/);
  assert.match(config, /binding = "SITE_SLOT_002"/);
  assert.match(config, /service = "pages-v2-production-slot-002"/);
});

test('pages-router config requires slot count in normal worker slot mode', () => {
  const env = { ...baseEnv };
  delete env.PAGES_NORMAL_WORKER_SLOT_COUNT;
  const result = runRenderer(['apps/pages-router', 'production'], env);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_NORMAL_WORKER_SLOT_COUNT/);
});

test('pages-router config supports explicit cache and JWT ttl overrides', () => {
  const config = renderPagesRouter('production', {
    ...baseEnv,
    ROUTE_CACHE_TTL_SECONDS: '5',
    SITE_SESSION_FRESHNESS_TTL_SECONDS: '300',
    INTERNAL_WORKER_JWT_TTL_SECONDS: '30',
  });

  assert.match(config, /ROUTE_CACHE_TTL_SECONDS = "5"/);
  assert.match(config, /SITE_SESSION_FRESHNESS_TTL_SECONDS = "300"/);
  assert.match(config, /INTERNAL_WORKER_JWT_TTL_SECONDS = "30"/);
});

test('pages-router config requires allowlist, route snapshot store, and signing registry', () => {
  for (const name of [
    'ROUTER_IP_ALLOWLIST_CIDRS',
    'ROUTE_SNAPSHOTS_KV_ID',
    'PAGES_SESSION_JWT_ACTIVE_KID',
    'PAGES_SESSION_JWT_KEYS',
    'PAGES_CAP_JWT_ACTIVE_KID',
    'PAGES_CAP_JWT_KEYS',
    'PAGES_EXECUTION_MODE',
  ]) {
    const result = runRenderer(['apps/pages-router', 'production'], withoutEnv(name));

    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(`${result.stderr}${result.stdout}`, new RegExp(name));
  }
});

test('production kv-gateway config renders explicit production site data settings only', () => {
  const config = renderKvGateway('production');

  assert.match(config, /name = "pages-kv-gateway"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /PAGES_ENV = "production"/);
  assert.match(config, /PAGES_CAP_JWT_ACTIVE_KID = "pages-cap-2026-06"/);
  assert.match(config, /PAGES_CAP_JWT_KEYS = "pages-cap-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606"/);
  assert.match(config, /binding = "SITE_DATA"/);
  assert.match(config, /id = "dummy-site-data-kv"/);
  assert.doesNotMatch(config, /name = "pages-kv-gateway-staging"/);
  assert.doesNotMatch(config, /PAGES_ENV = "staging"/);
  assert.doesNotMatch(config, /CF_API_TOKEN|CLOUDFLARE_API_TOKEN|SSO_CLIENT_SECRET/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging kv-gateway config renders explicit staging site data settings', () => {
  const config = renderKvGateway('staging');

  assert.match(config, /name = "pages-kv-gateway-staging"/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.doesNotMatch(config, /name = "pages-kv-gateway"/);
});

test('kv-gateway config requires site data KV id and capability registry', () => {
  for (const name of ['SITE_DATA_KV_ID', 'PAGES_CAP_JWT_ACTIVE_KID', 'PAGES_CAP_JWT_KEYS']) {
    const result = runRenderer(['apps/kv-gateway', 'production'], withoutEnv(name));

    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(`${result.stderr}${result.stdout}`, new RegExp(name));
  }
});

test('renderer rejects unsupported apps and environments', () => {
  const unsupportedApp = runRenderer(['apps/server', 'production']);
  const unsupportedEnv = runRenderer(['apps/pages-api', 'preview']);

  assert.notEqual(unsupportedApp.status, 0);
  assert.match(`${unsupportedApp.stderr}${unsupportedApp.stdout}`, /Supported apps/);
  assert.notEqual(unsupportedEnv.status, 0);
  assert.match(`${unsupportedEnv.stderr}${unsupportedEnv.stdout}`, /production\|staging/);
});
