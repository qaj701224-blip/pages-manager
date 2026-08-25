import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGES_API_ROOT = path.join(REPO_ROOT, 'apps/pages-api');
const PRODUCTION_TEMPLATE = read('apps/pages-api/wrangler.production.template.toml');
const STAGING_TEMPLATE = read('apps/pages-api/wrangler.staging.template.toml');

const TEMPLATE_VARS = [
  'ACCESS_KEY_ACTIVE_PEPPER_ID',
  'ACCESS_KEY_PEPPERS',
  'CINDY_CONNECTION_AUDIENCE',
  'CINDY_CONNECTION_ISSUERS',
  'CLI_ACCESS_KEY_TTL_SECONDS',
  'IP_ALLOWLIST',
  'PAGES_ENV',
  'PAGES_EXECUTION_MODE',
  'PAGES_NORMAL_WORKER_SLOT_EXPAND_BY',
  'PAGES_USER_WORKER_VPC_TUNNEL_ID',
  'PUBLIC_API_BASE',
  'PUBLIC_AUTH_BASE',
  'PUBLIC_SITE_SUFFIX',
  'SITE_METADATA_MUTATIONS_ENABLED',
  'SLACK_PAGES_ALERT_MENTION_USER_ID',
  'WFP_COMPATIBILITY_DATE',
  'WFP_DISPATCH_NAMESPACE',
];

const RUNTIME_ENV_INVENTORY = {
  bindings: ['PAGES_METADATA', 'ROUTE_SNAPSHOTS', 'V1_SITES', 'XD_OFFICE_NET'],
  requiredSecrets: [
    'CF_ACCOUNT_ID',
    'CF_API_TOKEN',
    'CF_ZONE_ID_NEW',
    'SITE_SECRET_ENCRYPTION_KEY',
    'WEBHOOK_URL_ENCRYPTION_KEY',
    'XDS_OPENAI_TOKEN',
  ],
  optionalCapabilities: [
    'CF_API_BASE_URL',
    'DEPLOYMENT_CLEANUP_CRON_LIMIT',
    'HOSTNAME_REUSE_HOLD_SECONDS',
    'PAGES_SECRET_ENCRYPTION_KEY',
    'PAGES_V1_RESERVED_WORKER_NAMES',
    'PAGES_V1_SITES_KV_NAMESPACE_ID',
    'PAGES_V1_ZONE_ID',
    'PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS',
    'PUBLIC_ENVIRONMENT',
    'REQUEST_HASH_PEPPER',
    'RUNTIME_CONFIG_HASH_PEPPER',
    'SITE_COMMIT_LOCK_RENEW_INTERVAL_MS',
    'SITE_COMMIT_LOCK_TIMEOUT_MS',
    'SITE_METADATA_RECONCILIATION_CRON_LIMIT',
    'SLACK_PAGES_ALERT_WEBHOOK_URL',
    'WEBHOOK_DNS_RESOLVER_URL',
    'WFP_CLEANUP_DRAIN_SECONDS',
    'WFP_WORKER_CLEANUP_DRAIN_SECONDS',
  ],
  injectedTestSeams: [
    'ASSETS',
    'NORMAL_WORKER_ADMIN_CLIENT',
    'NORMAL_WORKER_SLOT_PROVIDER',
    'PAGES_STORE',
    'V1_CLOUDFLARE_CLIENT',
    'V1_SITES_ADMIN_CLIENT',
    'WEBHOOK_FETCH',
    'WFP_PROVIDER',
    'WFP_RESOURCE_ADMIN_CLIENT',
    'XDS_FETCH',
  ],
  templateValuesReadAtRuntime: TEMPLATE_VARS.filter(
    (name) => !['IP_ALLOWLIST', 'PAGES_NORMAL_WORKER_SLOT_EXPAND_BY', 'PUBLIC_SITE_SUFFIX'].includes(name)
  ),
};

test('production and staging templates preserve the pages-api Cloudflare topology', () => {
  assert.deepEqual(templateShape(PRODUCTION_TEMPLATE), {
    workerName: 'pages-api',
    main: 'src/index.js',
    cron: '*/15 * * * *',
    route: 'api.pages.xd.team/*',
    d1Bindings: ['PAGES_METADATA'],
    kvBindings: ['ROUTE_SNAPSHOTS', 'V1_SITES'],
    durableObjectBindings: ['ROUTE_POINTER_LOCKS'],
    serviceBindings: [],
    migrationTags: ['v1'],
    sqliteClasses: ['RoutePointerDO'],
    vars: TEMPLATE_VARS,
    vpcPlaceholderCount: 1,
  });
  assert.deepEqual(templateShape(STAGING_TEMPLATE), {
    workerName: 'pages-api-staging',
    main: 'src/index.js',
    cron: '*/15 * * * *',
    route: 'api-staging.pages.xd.team/*',
    d1Bindings: ['PAGES_METADATA'],
    kvBindings: ['ROUTE_SNAPSHOTS', 'V1_SITES'],
    durableObjectBindings: ['ROUTE_POINTER_LOCKS'],
    serviceBindings: [],
    migrationTags: ['v1'],
    sqliteClasses: ['RoutePointerDO'],
    vars: TEMPLATE_VARS,
    vpcPlaceholderCount: 1,
  });

  assert.equal(tomlString(PRODUCTION_TEMPLATE, 'PAGES_ENV'), 'production');
  assert.equal(tomlString(STAGING_TEMPLATE, 'PAGES_ENV'), 'staging');
  assert.equal(tomlString(PRODUCTION_TEMPLATE, 'WFP_DISPATCH_NAMESPACE'), 'xd-cell-workers-production');
  assert.equal(tomlString(STAGING_TEMPLATE, 'WFP_DISPATCH_NAMESPACE'), 'xd-cell-workers-staging');
  assert.equal(tomlString(PRODUCTION_TEMPLATE, 'SITE_METADATA_MUTATIONS_ENABLED'), 'false');
  assert.equal(tomlString(STAGING_TEMPLATE, 'SITE_METADATA_MUTATIONS_ENABLED'), 'false');
  assert.notEqual(tomlString(PRODUCTION_TEMPLATE, 'database_name'), tomlString(STAGING_TEMPLATE, 'database_name'));
});

test('runtime env reads are classified in the capability inventory', () => {
  const expected = Object.values(RUNTIME_ENV_INVENTORY).flat().sort();
  assert.deepEqual([...new Set(expected)], expected, 'runtime env inventory must not classify a key twice');
  assert.deepEqual(runtimeEnvReads(), expected);
});

test('production workflow remains manual-only', () => {
  const workflow = read('.github/workflows/deploy-pages-v2.yml');
  const triggerBlock = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1] || '';
  assert.match(triggerBlock, /^[ ]{2}workflow_dispatch:/m);
  assert.doesNotMatch(triggerBlock, /^[ ]{2}(?:push|pull_request|schedule):/m);
});

function templateShape(source) {
  return {
    workerName: tomlString(source, 'name'),
    main: tomlString(source, 'main'),
    cron: source.match(/^crons = \["([^"]+)"\]$/m)?.[1],
    route: blockStrings(source, 'routes', 'pattern')[0],
    d1Bindings: blockStrings(source, 'd1_databases', 'binding').sort(),
    kvBindings: blockStrings(source, 'kv_namespaces', 'binding').sort(),
    durableObjectBindings: blockStrings(source, 'durable_objects.bindings', 'name').sort(),
    serviceBindings: blockStrings(source, 'services', 'binding').sort(),
    migrationTags: blockStrings(source, 'migrations', 'tag').sort(),
    sqliteClasses: blockArrays(source, 'migrations', 'new_sqlite_classes').flat().sort(),
    vars: sectionKeys(source, 'vars').sort(),
    vpcPlaceholderCount: source.split('__PAGES_API_XDS_VPC_NETWORK__').length - 1,
  };
}

function blockStrings(source, section, key) {
  return blocks(source, section)
    .map((block) => block.match(new RegExp(`^${key} = "([^"]+)"$`, 'm'))?.[1])
    .filter(Boolean);
}

function blockArrays(source, section, key) {
  return blocks(source, section).map((block) => {
    const value = block.match(new RegExp(`^${key} = \\[(.*)\\]$`, 'm'))?.[1] || '';
    return [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  });
}

function blocks(source, section) {
  const escaped = section.replaceAll('.', '\\.');
  return [
    ...source.matchAll(new RegExp(`^\\[\\[${escaped}\\]\\]\\n([\\s\\S]*?)(?=^\\[|^__|(?![\\s\\S]))`, 'gm')),
  ].map((match) => match[1]);
}

function sectionKeys(source, section) {
  const escaped = section.replaceAll('.', '\\.');
  const body = source.match(new RegExp(`^\\[${escaped}\\]\\n([\\s\\S]*?)(?=^\\[|^__|(?![\\s\\S]))`, 'm'))?.[1] || '';
  return [...body.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1]);
}

function tomlString(source, key) {
  const matches = [...source.matchAll(new RegExp(`^${key} = "([^"]+)"$`, 'gm'))];
  assert.ok(matches.length > 0, `${key} must exist in template`);
  return matches[0][1];
}

function runtimeEnvReads() {
  const names = new Set();
  for (const file of productionJavaScriptFiles(path.join(PAGES_API_ROOT, 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)\b/g)) names.add(match[1]);
    for (const match of source.matchAll(/\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) names.add(match[1]);
  }
  return [...names].sort();
}

function productionJavaScriptFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...productionJavaScriptFiles(file));
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(file);
  }
  return files;
}

function read(file) {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}
