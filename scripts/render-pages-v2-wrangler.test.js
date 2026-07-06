import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/render-pages-v2-wrangler.mjs');
const pagesApiWranglerPath = join(repoRoot, 'apps/pages-api/wrangler.toml');
const pagesAuthWranglerPath = join(repoRoot, 'apps/pages-auth/wrangler.toml');
const pagesRouterWranglerPath = join(repoRoot, 'apps/pages-router/wrangler.toml');
const kvGatewayWranglerPath = join(repoRoot, 'apps/kv-gateway/wrangler.toml');
const pagesConsoleWranglerPath = join(repoRoot, 'apps/pages-console/wrangler.toml');
const pagesApiStagingTemplatePath = join(repoRoot, 'apps/pages-api/wrangler.staging.template.toml');
const pagesRouterProductionTemplatePath = join(repoRoot, 'apps/pages-router/wrangler.production.template.toml');
const pagesRouterStagingTemplatePath = join(repoRoot, 'apps/pages-router/wrangler.staging.template.toml');
const pagesAuthProductionTemplatePath = join(repoRoot, 'apps/pages-auth/wrangler.production.template.toml');
const pagesAuthStagingTemplatePath = join(repoRoot, 'apps/pages-auth/wrangler.staging.template.toml');
const originalTemplates = new Map([
  [pagesApiStagingTemplatePath, readFileSync(pagesApiStagingTemplatePath, 'utf8')],
  [pagesRouterProductionTemplatePath, readFileSync(pagesRouterProductionTemplatePath, 'utf8')],
  [pagesRouterStagingTemplatePath, readFileSync(pagesRouterStagingTemplatePath, 'utf8')],
  [pagesAuthProductionTemplatePath, readFileSync(pagesAuthProductionTemplatePath, 'utf8')],
  [pagesAuthStagingTemplatePath, readFileSync(pagesAuthStagingTemplatePath, 'utf8')],
]);

const baseEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
  D1_DATABASE_ID: 'dummy-pages-d1',
  ROUTE_SNAPSHOTS_KV_ID: 'dummy-route-snapshots-kv',
  SITE_DATA_KV_ID: 'dummy-site-data-kv',
  ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_2026_06',
  ACCESS_KEY_PEPPERS: 'pepper_2026_06:ACCESS_KEY_PEPPER_202606',
  PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT: '2',
  PAGES_USER_WORKER_VPC_TUNNEL_ID: '',
  PAGES_SESSION_JWT_ACTIVE_KID: 'pages-session-2026-06',
  PAGES_SESSION_JWT_KEYS: 'pages-session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606',
  PAGES_CAP_JWT_ACTIVE_KID: 'pages-cap-2026-06',
  PAGES_CAP_JWT_KEYS: 'pages-cap-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
  IP_ALLOWLIST: '10.0.0.0/8,192.168.0.0/16',
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
  rmSync(pagesConsoleWranglerPath, { force: true });
  for (const [path, content] of originalTemplates.entries()) {
    writeFileSync(path, content);
  }
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

function renderPagesConsole(environment, env = baseEnv) {
  renderApp('apps/pages-console', environment, env);
  return readFileSync(pagesConsoleWranglerPath, 'utf8');
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

function setRouterTemplateExecutionMode(environment, mode) {
  const path = environment === 'staging' ? pagesRouterStagingTemplatePath : pagesRouterProductionTemplatePath;
  const content = readFileSync(path, 'utf8').replace(
    /PAGES_EXECUTION_MODE = "(?:normal-worker-slot|wfp)"/,
    `PAGES_EXECUTION_MODE = "${mode}"`
  );
  writeFileSync(path, content);
}

function setPagesAuthTemplateSsoTokenUrl(environment, value) {
  const path = environment === 'staging' ? pagesAuthStagingTemplatePath : pagesAuthProductionTemplatePath;
  const content = readFileSync(path, 'utf8').replace(/^SSO_TOKEN_URL = "[^"]+"$/m, `SSO_TOKEN_URL = "${value}"`);
  writeFileSync(path, content);
}

function setPagesApiStagingTemplateWfpDispatchNamespace(value) {
  const content = readFileSync(pagesApiStagingTemplatePath, 'utf8').replace(
    /^WFP_DISPATCH_NAMESPACE = "[^"]+"$/m,
    `WFP_DISPATCH_NAMESPACE = "${value}"`
  );
  writeFileSync(pagesApiStagingTemplatePath, content);
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
      'apps/pages-console/wrangler.toml',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /apps\/pages-api\/wrangler\.toml/);
  assert.match(result.stdout, /apps\/pages-auth\/wrangler\.toml/);
  assert.match(result.stdout, /apps\/pages-router\/wrangler\.toml/);
  assert.match(result.stdout, /apps\/kv-gateway\/wrangler\.toml/);
  assert.match(result.stdout, /apps\/pages-console\/wrangler\.toml/);
});

test('production pages-api config renders explicit production template values only', () => {
  const config = renderPagesApi('production');

  assert.match(config, /name = "pages-api"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /\[observability\.logs\]\nenabled = true\nhead_sampling_rate = 1/);
  assert.match(config, /pattern = "api\.pages\.xd\.team\/\*"/);
  assert.match(config, /zone_name = "xd\.team"/);
  assert.doesNotMatch(config, /custom_domain = true/);
  assert.match(config, /PAGES_ENV = "production"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_SITE_SUFFIX = "workers\.xd\.team"/);
  assert.match(config, /WFP_DISPATCH_NAMESPACE = "xd-cell-workers-production"/);
  assert.match(config, /PAGES_EXECUTION_MODE = "wfp"/);
  assert.match(config, /PAGES_NORMAL_WORKER_SLOT_EXPAND_BY = "2"/);
  assert.match(config, /SLACK_PAGES_ALERT_MENTION_USER_ID = "U06QLFY2XCK"/);
  assert.match(config, /WFP_COMPATIBILITY_DATE = "2026-06-15"/);
  assert.match(config, /ACCESS_KEY_ACTIVE_PEPPER_ID = "pepper_2026_06"/);
  assert.match(config, /ACCESS_KEY_PEPPERS = "pepper_2026_06:ACCESS_KEY_PEPPER_202606"/);
  assert.match(config, /IP_ALLOWLIST = "10\.0\.0\.0\/8,192\.168\.0\.0\/16"/);
  assert.match(config, /database_name = "pages-v2-metadata"/);
  assert.match(config, /database_id = "dummy-pages-d1"/);
  assert.match(config, /binding = "ROUTE_SNAPSHOTS"/);
  assert.match(config, /id = "dummy-route-snapshots-kv"/);
  assert.match(config, /binding = "PAGES_AUTH"/);
  assert.match(config, /service = "pages-auth"/);
  assert.doesNotMatch(config, /api-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /auth-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /xd-cell-workers-staging/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging pages-api config renders explicit staging template values', () => {
  const config = renderPagesApi('staging');

  assert.match(config, /name = "pages-api-staging"/);
  assert.doesNotMatch(config, /\[observability/);
  assert.match(config, /pattern = "api-staging\.pages\.xd\.team\/\*"/);
  assert.match(config, /zone_name = "xd\.team"/);
  assert.doesNotMatch(config, /custom_domain = true/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth-staging\.pages\.xd\.team"/);
  assert.match(config, /WFP_DISPATCH_NAMESPACE = "xd-cell-workers-staging"/);
  assert.match(config, /PAGES_EXECUTION_MODE = "wfp"/);
  assert.match(config, /PAGES_NORMAL_WORKER_SLOT_EXPAND_BY = "20"/);
  assert.match(config, /SLACK_PAGES_ALERT_MENTION_USER_ID = "U06QLFY2XCK"/);
  assert.match(config, /ACCESS_KEY_ACTIVE_PEPPER_ID = "pepper_2026_06"/);
  assert.match(config, /ACCESS_KEY_PEPPERS = "pepper_2026_06:ACCESS_KEY_PEPPER_202606"/);
  assert.match(config, /IP_ALLOWLIST = "10\.0\.0\.0\/8,192\.168\.0\.0\/16"/);
  assert.match(config, /database_name = "pages-v2-metadata-staging"/);
  assert.match(config, /service = "pages-auth-staging"/);
});

test('staging pages-api config rejects production WFP namespace', () => {
  setPagesApiStagingTemplateWfpDispatchNamespace('xd-cell-workers-production');
  const result = runRenderer(['apps/pages-api', 'staging']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /cross-environment value/);
});

test('pages-api config keeps committed WFP compatibility date', () => {
  const config = renderPagesApi('production', {
    ...baseEnv,
    WFP_COMPATIBILITY_DATE: '2026-07-01',
  });

  assert.match(config, /WFP_COMPATIBILITY_DATE = "2026-06-15"/);
  assert.doesNotMatch(config, /2026-07-01/);
});

test('pages-api config renders optional user Worker VPC Tunnel ID from deployment env', () => {
  const config = renderPagesApi('production', {
    ...baseEnv,
    PAGES_USER_WORKER_VPC_TUNNEL_ID: 'test-office-tunnel-id',
  });

  assert.match(config, /PAGES_USER_WORKER_VPC_TUNNEL_ID = "test-office-tunnel-id"/);

  const emptyConfig = renderPagesApi('staging', withoutEnv('PAGES_USER_WORKER_VPC_TUNNEL_ID'));
  assert.match(emptyConfig, /PAGES_USER_WORKER_VPC_TUNNEL_ID = ""/);
});

test('pages-api config binds XDS outbound requests to the office VPC network', () => {
  const config = renderPagesApi('production', {
    ...baseEnv,
    PAGES_USER_WORKER_VPC_TUNNEL_ID: 'test-office-tunnel-id',
  });

  assert.match(config, /\[\[vpc_networks\]\]\nbinding = "XD_OFFICE_NET"\ntunnel_id = "test-office-tunnel-id"/);

  const emptyConfig = renderPagesApi('staging', withoutEnv('PAGES_USER_WORKER_VPC_TUNNEL_ID'));
  assert.doesNotMatch(emptyConfig, /\[\[vpc_networks\]\]/);
});

test('pages-api config requires resource ids and keeps template execution mode', () => {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'ROUTE_SNAPSHOTS_KV_ID', 'IP_ALLOWLIST']) {
    const result = runRenderer(['apps/pages-api', 'production'], withoutEnv(name));

    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(`${result.stderr}${result.stdout}`, new RegExp(name));
  }

  const config = renderPagesApi('production', { ...baseEnv, PAGES_EXECUTION_MODE: 'normal-worker-slot' });
  assert.match(config, /PAGES_EXECUTION_MODE = "wfp"/);
});

test('production pages-auth config renders explicit production auth settings only', () => {
  const config = renderPagesAuth('production');

  assert.match(config, /name = "pages-auth"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /\[observability\.logs\]\nenabled = true\nhead_sampling_rate = 1\ninvocation_logs = false/);
  assert.match(config, /pattern = "auth\.pages\.xd\.team\/\*"/);
  assert.match(config, /zone_name = "xd\.team"/);
  assert.doesNotMatch(config, /custom_domain = true/);
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
  assert.match(config, /PAGES_SESSION_JWT_KEYS = "pages-session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606"/);
  assert.match(config, /SSO_AUTHORIZATION_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/authorize"/);
  assert.match(config, /SSO_REDIRECT_URI = "https:\/\/auth\.pages\.xd\.team\/\.xd-pages\/auth\/callback"/);
  assert.match(config, /SSO_TOKEN_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/accessToken"/);
  assert.match(config, /SSO_PROFILE_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/profile"/);
  assert.match(config, /SSO_CLIENT_ID = "xd_pages"/);
  assert.doesNotMatch(config, /SSO_ALLOWED_USER_SCOPE/);
  assert.doesNotMatch(config, /binding = "PAGES_API"/);
  assert.doesNotMatch(config, /service = "pages-api"/);
  assert.match(config, /binding = "PAGES_METADATA"/);
  assert.match(config, /database_name = "pages-v2-metadata"/);
  assert.match(config, /database_id = "dummy-pages-d1"/);
  assert.doesNotMatch(config, /api-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /auth-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /service = "pages-api-staging"/);
  assert.doesNotMatch(config, /SSO_CLIENT_SECRET|CF_API_TOKEN|CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging pages-auth config renders explicit staging auth settings', () => {
  const config = renderPagesAuth('staging');

  assert.match(config, /name = "pages-auth-staging"/);
  assert.doesNotMatch(config, /\[observability/);
  assert.match(config, /pattern = "auth-staging\.pages\.xd\.team\/\*"/);
  assert.match(config, /zone_name = "xd\.team"/);
  assert.doesNotMatch(config, /custom_domain = true/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.pages\.xd\.team"/);
  assert.match(config, /SSO_REDIRECT_URI = "https:\/\/auth-staging\.pages\.xd\.team\/\.xd-pages\/auth\/callback"/);
  assert.match(config, /SSO_AUTHORIZATION_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/authorize"/);
  assert.match(config, /SSO_TOKEN_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/accessToken"/);
  assert.match(config, /SSO_PROFILE_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/profile"/);
  assert.match(config, /SSO_CLIENT_ID = "xd_pages_staging"/);
  assert.match(config, /database_name = "pages-v2-metadata-staging"/);
  assert.doesNotMatch(config, /binding = "PAGES_API"/);
  assert.doesNotMatch(config, /service = "pages-api-staging"/);
});

test('pages-auth config binds XDS outbound requests to the office VPC network when configured', () => {
  const config = renderPagesAuth('production', {
    ...baseEnv,
    PAGES_USER_WORKER_VPC_TUNNEL_ID: 'test-office-tunnel-id',
  });

  assert.match(config, /\[\[vpc_networks\]\]\nbinding = "XD_OFFICE_NET"\ntunnel_id = "test-office-tunnel-id"/);
  assert.doesNotMatch(config, /binding = "PAGES_API"/);

  const emptyConfig = renderPagesAuth('staging', withoutEnv('PAGES_USER_WORKER_VPC_TUNNEL_ID'));
  assert.doesNotMatch(emptyConfig, /\[\[vpc_networks\]\]/);
});

test('pages-auth config keeps committed ttl, SSO endpoints, and client id defaults', () => {
  const config = renderPagesAuth('production', {
    ...baseEnv,
    AUTH_SESSION_IDLE_TTL_SECONDS: '2592000',
    SITE_SESSION_IDLE_TTL_SECONDS: '2592000',
    SSO_AUTHORIZATION_URL: 'https://sso.example.test/oauth/authorize',
    SSO_TOKEN_URL: 'https://sso.example.test/oauth/token',
    SSO_PROFILE_URL: 'https://sso.example.test/oauth/profile',
    SSO_CLIENT_ID: 'xd_pages_test',
  });

  assert.match(config, /AUTH_SESSION_IDLE_TTL_SECONDS = "1209600"/);
  assert.match(config, /SITE_SESSION_IDLE_TTL_SECONDS = "604800"/);
  assert.match(config, /SSO_AUTHORIZATION_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/authorize"/);
  assert.match(config, /SSO_TOKEN_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/accessToken"/);
  assert.match(config, /SSO_PROFILE_URL = "https:\/\/sso\.security\.xindong\.com\/cas\/oauth2\.0\/profile"/);
  assert.match(config, /SSO_CLIENT_ID = "xd_pages"/);
  assert.doesNotMatch(config, /SSO_ALLOWED_USER_SCOPE/);
  assert.doesNotMatch(config, /sso\.example\.test/);
  assert.doesNotMatch(config, /xd_pages_test/);
});

test('pages-auth config no longer requires GitHub SSO vars', () => {
  for (const name of ['SSO_AUTHORIZATION_URL', 'SSO_TOKEN_URL', 'SSO_PROFILE_URL', 'SSO_CLIENT_ID']) {
    const result = runRenderer(['apps/pages-auth', 'production'], withoutEnv(name));

    assert.equal(result.status, 0, `${name} should come from the committed template`);
  }
});

test('pages-auth config requires the shared metadata D1 id', () => {
  const result = runRenderer(['apps/pages-auth', 'production'], withoutEnv('D1_DATABASE_ID'));

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /D1_DATABASE_ID/);
});

test('renderer validates committed production SSO URLs', () => {
  setPagesAuthTemplateSsoTokenUrl('production', 'http://sso.example.test/oauth/token');
  const result = runRenderer(['apps/pages-auth', 'production']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /SSO_TOKEN_URL must be an HTTPS URL/);
});

test('renderer rejects invalid template execution mode', () => {
  setRouterTemplateExecutionMode('production', 'auto');
  const result = runRenderer(['apps/pages-router', 'production']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_EXECUTION_MODE/);
});

test('production pages-router config renders explicit production fast-path settings only', () => {
  const config = renderPagesRouter('production');

  assert.match(config, /name = "pages-router"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /\[observability\.logs\]\nenabled = true\nhead_sampling_rate = 1\ninvocation_logs = false/);
  assert.match(config, /pattern = "\*\.pages\.xd\.team\/\*"/);
  assert.match(config, /pattern = "\*\.workers\.xd\.team\/\*"/);
  assert.match(config, /zone_name = "xd\.team"/);
  assert.match(config, /PAGES_ENV = "production"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_SITE_SUFFIX = "workers\.xd\.team"/);
  assert.match(config, /PAGES_EXECUTION_MODE = "wfp"/);
  assert.match(config, /PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE = "20"/);
  assert.match(config, /PAGES_NORMAL_WORKER_SLOT_EXPAND_BY = "20"/);
  assert.match(config, /PAGES_NORMAL_WORKER_SLOT_MAX_TOTAL = "100"/);
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
  assert.match(config, /binding = "PAGES_DISPATCH"/);
  assert.match(config, /namespace = "xd-cell-workers-production"/);
  assert.doesNotMatch(config, /api-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /auth-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /\*-staging\.workers\.xd\.team/);
  assert.doesNotMatch(config, /namespace = "xd-cell-workers-staging"/);
  assert.doesNotMatch(config, /service = "pages-auth-staging"/);
  assert.doesNotMatch(config, /CF_API_TOKEN|CLOUDFLARE_API_TOKEN|SSO_CLIENT_SECRET/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging pages-router config renders explicit staging fast-path settings', () => {
  const config = renderPagesRouter('staging');

  assert.match(config, /name = "pages-router-staging"/);
  assert.doesNotMatch(config, /\[observability/);
  assert.match(config, /pattern = "\*-staging\.pages\.xd\.team\/\*"/);
  assert.match(config, /pattern = "\*-staging\.workers\.xd\.team\/\*"/);
  assert.match(config, /zone_name = "xd\.team"/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.pages\.xd\.team"/);
  assert.match(config, /PAGES_EXECUTION_MODE = "wfp"/);
  assert.match(config, /PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE = "20"/);
  assert.match(config, /PAGES_NORMAL_WORKER_SLOT_EXPAND_BY = "20"/);
  assert.match(config, /ROUTER_JWKS_URL = "https:\/\/auth-staging\.pages\.xd\.team\/\.xd-pages\/jwks\.json"/);
  assert.match(config, /service = "pages-auth-staging"/);
  assert.match(config, /binding = "XD_PAGES_KV_GATEWAY"/);
  assert.match(config, /service = "pages-kv-gateway-staging"/);
  assert.match(config, /binding = "SITE_SLOT_001"/);
  assert.match(config, /service = "pages-v2-staging-slot-001"/);
  assert.match(config, /binding = "SITE_SLOT_002"/);
  assert.match(config, /service = "pages-v2-staging-slot-002"/);
  assert.match(config, /binding = "PAGES_DISPATCH"/);
  assert.match(config, /namespace = "xd-cell-workers-staging"/);
  assert.doesNotMatch(config, /pattern = "\*\.workers\.xd\.team\/\*"/);
});

test('pages-router config keeps static WFP dispatch namespace in wfp mode without historical slots', () => {
  setRouterTemplateExecutionMode('production', 'wfp');
  const config = renderPagesRouter('production', {
    ...baseEnv,
    PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT: '',
  });

  assert.doesNotMatch(config, /SITE_SLOT_001/);
  assert.doesNotMatch(config, /pages-v2-production-slot-001/);
  assert.match(config, /binding = "PAGES_DISPATCH"/);
  assert.match(config, /namespace = "xd-cell-workers-production"/);
});

test('pages-router config can keep slot bindings in wfp mode while draining slot routes', () => {
  setRouterTemplateExecutionMode('production', 'wfp');
  const config = renderPagesRouter('production', {
    ...baseEnv,
    PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT: '2',
  });

  assert.match(config, /binding = "PAGES_DISPATCH"/);
  assert.match(config, /namespace = "xd-cell-workers-production"/);
  assert.match(config, /binding = "SITE_SLOT_001"/);
  assert.match(config, /service = "pages-v2-production-slot-001"/);
  assert.match(config, /binding = "SITE_SLOT_002"/);
  assert.match(config, /service = "pages-v2-production-slot-002"/);
});

test('pages-router config requires deploy-computed binding count in normal worker slot mode', () => {
  setRouterTemplateExecutionMode('production', 'normal-worker-slot');
  const env = { ...baseEnv };
  delete env.PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT;
  const result = runRenderer(['apps/pages-router', 'production'], env);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT/);
});

test('pages-router config keeps committed cache and JWT ttl defaults', () => {
  const config = renderPagesRouter('production', {
    ...baseEnv,
    ROUTE_CACHE_TTL_SECONDS: '5',
    SITE_SESSION_FRESHNESS_TTL_SECONDS: '300',
    INTERNAL_WORKER_JWT_TTL_SECONDS: '30',
  });

  assert.match(config, /ROUTE_CACHE_TTL_SECONDS = "10"/);
  assert.match(config, /SITE_SESSION_FRESHNESS_TTL_SECONDS = "900"/);
  assert.match(config, /INTERNAL_WORKER_JWT_TTL_SECONDS = "60"/);
});

test('pages-router config requires allowlist and route snapshot store', () => {
  for (const name of ['ROUTER_IP_ALLOWLIST_CIDRS', 'ROUTE_SNAPSHOTS_KV_ID']) {
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
  assert.match(config, /\[observability\.logs\]\nenabled = true\nhead_sampling_rate = 1/);
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
  assert.doesNotMatch(config, /\[observability/);
  assert.doesNotMatch(config, /name = "pages-kv-gateway"/);
});

test('kv-gateway config requires site data KV id', () => {
  for (const name of ['SITE_DATA_KV_ID']) {
    const result = runRenderer(['apps/kv-gateway', 'production'], withoutEnv(name));

    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(`${result.stderr}${result.stdout}`, new RegExp(name));
  }
});

test('production pages-console config renders exact console host without wildcard route', () => {
  const config = renderPagesConsole('production');

  assert.match(config, /name = "pages-console"/);
  assert.match(config, /account_id = "dummy-account"/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /\[observability\.logs\]\nenabled = true\nhead_sampling_rate = 1/);
  assert.match(config, /pattern = "workers\.xd\.team\/\*"/);
  assert.match(config, /zone_name = "xd\.team"/);
  assert.match(config, /PAGES_ENV = "production"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_CONSOLE_BASE = "https:\/\/workers\.xd\.team"/);
  assert.match(config, /IP_ALLOWLIST = "10\.0\.0\.0\/8,192\.168\.0\.0\/16"/);
  assert.match(config, /PAGES_SESSION_JWT_ISSUER = "pages-auth"/);
  assert.match(config, /PAGES_SESSION_JWT_ACTIVE_KID = "pages-session-2026-06"/);
  assert.match(config, /PAGES_SESSION_JWT_KEYS = "pages-session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606"/);
  assert.match(config, /binding = "PAGES_API"/);
  assert.match(config, /service = "pages-api"/);
  assert.match(config, /binding = "PAGES_AUTH"/);
  assert.match(config, /service = "pages-auth"/);
  assert.match(config, /\[assets\]\ndirectory = "\.\/dist\/client"\nbinding = "ASSETS"/);
  assert.match(config, /run_worker_first = true/);
  assert.doesNotMatch(config, /pattern = "\*\.workers\.xd\.team\/\*"/);
  assert.doesNotMatch(config, /api-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /auth-staging\.pages\.xd\.team/);
  assert.doesNotMatch(config, /service = "pages-(?:api|auth)-staging"/);
  assert.doesNotMatch(config, /CF_API_TOKEN|CLOUDFLARE_API_TOKEN|SSO_CLIENT_SECRET|CONSOLE_SESSION_SECRET/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
});

test('staging pages-console config renders staging admin-only console host', () => {
  const config = renderPagesConsole('staging');

  assert.match(config, /name = "pages-console-staging"/);
  assert.match(config, /pattern = "staging\.workers\.xd\.team\/\*"/);
  assert.match(config, /PAGES_ENV = "staging"/);
  assert.match(config, /PUBLIC_API_BASE = "https:\/\/api-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_AUTH_BASE = "https:\/\/auth-staging\.pages\.xd\.team"/);
  assert.match(config, /PUBLIC_CONSOLE_BASE = "https:\/\/staging\.workers\.xd\.team"/);
  assert.match(config, /IP_ALLOWLIST = "10\.0\.0\.0\/8,192\.168\.0\.0\/16"/);
  assert.match(config, /PAGES_SESSION_JWT_ISSUER = "pages-auth"/);
  assert.match(config, /PAGES_SESSION_JWT_ACTIVE_KID = "pages-session-2026-06"/);
  assert.match(config, /PAGES_SESSION_JWT_KEYS = "pages-session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606"/);
  assert.match(config, /service = "pages-api-staging"/);
  assert.match(config, /service = "pages-auth-staging"/);
  assert.match(config, /run_worker_first = true/);
  assert.doesNotMatch(config, /pattern = "\*-staging\.workers\.xd\.team\/\*"/);
});

test('pages-console config requires account id, IP allowlist, and session signing key registry', () => {
  for (const name of [
    'CLOUDFLARE_ACCOUNT_ID',
    'IP_ALLOWLIST',
    'PAGES_SESSION_JWT_ACTIVE_KID',
    'PAGES_SESSION_JWT_KEYS',
  ]) {
    const result = runRenderer(['apps/pages-console', 'production'], withoutEnv(name));

    assert.notEqual(result.status, 0, `${name} should be required`);
    assert.match(`${result.stderr}${result.stdout}`, new RegExp(name));
  }
});

test('pages-console config validates IP allowlist and rejects unresolved placeholders', () => {
  const unsafeAllowlist = runRenderer(['apps/pages-console', 'production'], {
    ...baseEnv,
    IP_ALLOWLIST: '10.0.0.0/8;bad',
  });

  assert.notEqual(unsafeAllowlist.status, 0);
  assert.match(`${unsafeAllowlist.stderr}${unsafeAllowlist.stdout}`, /IP_ALLOWLIST contains unsupported characters/);
});

test('renderer rejects unsupported apps and environments', () => {
  const unsupportedApp = runRenderer(['apps/server', 'production']);
  const unsupportedEnv = runRenderer(['apps/pages-api', 'preview']);

  assert.notEqual(unsupportedApp.status, 0);
  assert.match(`${unsupportedApp.stderr}${unsupportedApp.stdout}`, /Supported apps/);
  assert.notEqual(unsupportedEnv.status, 0);
  assert.match(`${unsupportedEnv.stderr}${unsupportedEnv.stdout}`, /production\|staging/);
});
