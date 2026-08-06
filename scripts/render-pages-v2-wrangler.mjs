#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_APPS = new Set([
  'apps/pages-api',
  'apps/pages-auth',
  'apps/pages-router',
  'apps/kv-gateway',
  'apps/pages-console',
]);
const SUPPORTED_ENVIRONMENTS = new Set(['production', 'staging']);
const EXECUTION_MODE_APPS = new Set(['apps/pages-api', 'apps/pages-router']);

const DEFAULTS = {
  PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT: '',
  PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON: '',
  PAGES_USER_WORKER_VPC_TUNNEL_ID: '',
};

const REQUIRED_TOKENS_BY_APP = {
  'apps/pages-api': [
    'CLOUDFLARE_ACCOUNT_ID',
    'D1_DATABASE_ID',
    'IP_ALLOWLIST',
    'ROUTE_SNAPSHOTS_KV_ID',
    'V1_SITES_KV_NAMESPACE_ID',
  ],
  'apps/pages-auth': ['CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID'],
  'apps/pages-router': ['CLOUDFLARE_ACCOUNT_ID', 'ROUTER_IP_ALLOWLIST_CIDRS', 'ROUTE_SNAPSHOTS_KV_ID'],
  'apps/kv-gateway': ['CLOUDFLARE_ACCOUNT_ID', 'SITE_DATA_KV_ID'],
  'apps/pages-console': [
    'CLOUDFLARE_ACCOUNT_ID',
    'IP_ALLOWLIST',
    'PAGES_SESSION_JWT_ACTIVE_KID',
    'PAGES_SESSION_JWT_KEYS',
  ],
};

const OPTIONAL_TOKENS_BY_APP = {
  'apps/pages-api': ['PAGES_USER_WORKER_VPC_TUNNEL_ID'],
  'apps/pages-auth': ['PAGES_USER_WORKER_VPC_TUNNEL_ID'],
  'apps/pages-router': ['PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT', 'PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON'],
  'apps/kv-gateway': [],
  'apps/pages-console': [],
};
const NON_TEMPLATE_TOKENS = new Set(['PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON']);

const TEMPLATE_EXPECTATIONS = {
  production: {
    forbidden: [
      /api-staging\.pages\.xd\.team/,
      /auth-staging\.pages\.xd\.team/,
      /\*-staging\.workers\.xd\.team/,
      /PAGES_ENV = "staging"/,
      /xd-cell-workers-staging/,
      /service = "pages-(?:api|auth)-staging"/,
      /name = "pages-[^"]+-staging"/,
    ],
    required: [/PAGES_ENV = "production"/],
  },
  staging: {
    forbidden: [/PAGES_ENV = "production"/, /xd-cell-workers-production/, /pattern = "\*\.workers\.xd\.team\/\*"/],
    required: [/PAGES_ENV = "staging"/, /-staging/],
  },
};

const [app, environment] = process.argv.slice(2);

try {
  if (!SUPPORTED_APPS.has(app) || !SUPPORTED_ENVIRONMENTS.has(environment)) {
    usage();
    process.exitCode = 2;
  } else {
    await renderWrangler(app, environment);
  }
} catch (error) {
  console.error(`render-pages-v2-wrangler: ${error.message}`);
  process.exitCode = 1;
}

async function renderWrangler(appName, envName) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const templatePath = join(repoRoot, appName, `wrangler.${envName}.template.toml`);
  const outputPath = join(repoRoot, appName, 'wrangler.toml');
  let rendered = await readFile(templatePath, 'utf8');

  const replacements = collectReplacements(appName);
  assertCrossTokenPolicy(replacements);
  for (const [token, value] of Object.entries(replacements)) {
    if (NON_TEMPLATE_TOKENS.has(token)) {
      assertTokenPolicy(token, value, envName);
      continue;
    }
    assertTomlSafe(token, value);
    assertTokenPolicy(token, value, envName);
    rendered = rendered.replaceAll(`__${token}__`, value);
  }
  const executionMode = readExecutionMode(rendered, appName, envName);
  rendered = rendered.replaceAll(
    '__NORMAL_WORKER_SLOT_SERVICES__',
    renderNormalWorkerSlotServices(appName, envName, replacements, executionMode)
  );
  rendered = rendered.replaceAll('__PAGES_API_XDS_VPC_NETWORK__', renderPagesApiXdsVpcNetwork(appName, replacements));
  rendered = rendered.replaceAll('__PAGES_AUTH_XDS_VPC_NETWORK__', renderPagesAuthXdsVpcNetwork(appName, replacements));

  assertRenderedConfigPolicy(rendered, appName, envName);
  assertNoUnresolvedPlaceholders(rendered, templatePath);
  assertNoRuntimeSecrets(rendered, appName);
  assertEnvironmentBoundary(rendered, envName, appName);

  await writeFile(outputPath, `${rendered.trimEnd()}\n`);
  console.log(`generated ${appName}/wrangler.toml from ${appName}/wrangler.${envName}.template.toml`);
}

function collectReplacements(appName) {
  const replacements = {};
  for (const token of REQUIRED_TOKENS_BY_APP[appName]) {
    const value = process.env[token];
    if (!value) throw new Error(`${token} is required`);
    replacements[token] = value;
  }

  for (const token of OPTIONAL_TOKENS_BY_APP[appName]) {
    replacements[token] = process.env[token] || DEFAULTS[token];
  }
  return replacements;
}

function assertTomlSafe(name, value) {
  if (value.includes('"') || value.includes('\\') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${name} contains TOML-unsafe characters`);
  }
}

function assertTokenPolicy(name, value, envName = 'production') {
  if (name === 'SSO_AUTHORIZATION_URL' || name === 'SSO_TOKEN_URL' || name === 'SSO_PROFILE_URL') {
    assertHttpsUrl(name, value);
  }
  if (name.endsWith('_SECONDS')) {
    assertPositiveInteger(name, value);
  }
  if (name === 'WFP_COMPATIBILITY_DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  if (name === 'ACCESS_KEY_ACTIVE_PEPPER_ID' && !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must be a safe id`);
  }
  if (name === 'ACCESS_KEY_PEPPERS') {
    assertAccessKeyPepperRegistry(value);
  }
  if (name === 'PAGES_SESSION_JWT_ACTIVE_KID' || name === 'PAGES_CAP_JWT_ACTIVE_KID') {
    assertSafeKeyId(name, value);
  }
  if (name === 'PAGES_SESSION_JWT_KEYS') {
    assertJwtKeyRegistry(name, value, 'PAGES_SESSION_JWT_SECRET_');
  }
  if (name === 'PAGES_CAP_JWT_KEYS') {
    assertJwtKeyRegistry(name, value, 'PAGES_CAP_JWT_SECRET_');
  }
  if (name === 'PAGES_EXECUTION_MODE' && !/^(normal-worker-slot|wfp)$/.test(value)) {
    throw new Error(`${name} must be normal-worker-slot or wfp`);
  }
  if (name === 'PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT' && value !== '') {
    assertPositiveInteger(name, value);
  }
  if (name === 'PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON' && value !== '') {
    parseNormalWorkerSlotBindingsJson(value, envName);
  }
  if (name === 'IP_ALLOWLIST' || name === 'ROUTER_IP_ALLOWLIST_CIDRS') {
    assertIpAllowlist(name, value);
  }
}

function assertCrossTokenPolicy(replacements) {
  assertActiveKidPresent(
    replacements.PAGES_SESSION_JWT_ACTIVE_KID,
    replacements.PAGES_SESSION_JWT_KEYS,
    'PAGES_SESSION_JWT_ACTIVE_KID',
    'PAGES_SESSION_JWT_KEYS',
    'PAGES_SESSION_JWT_SECRET_'
  );
  assertActiveKidPresent(
    replacements.PAGES_CAP_JWT_ACTIVE_KID,
    replacements.PAGES_CAP_JWT_KEYS,
    'PAGES_CAP_JWT_ACTIVE_KID',
    'PAGES_CAP_JWT_KEYS',
    'PAGES_CAP_JWT_SECRET_'
  );
}

function assertRenderedConfigPolicy(rendered, appName, envName) {
  if (appName === 'apps/pages-api') {
    assertCindyConnectionConfig(rendered, envName);
    return;
  }
  if (appName !== 'apps/pages-auth') return;

  for (const name of ['SSO_AUTHORIZATION_URL', 'SSO_TOKEN_URL', 'SSO_PROFILE_URL']) {
    assertHttpsUrl(name, readTomlStringVar(rendered, name));
  }
  const clientId = readTomlStringVar(rendered, 'SSO_CLIENT_ID');
  if (!/^[A-Za-z0-9_-]+$/.test(clientId)) throw new Error('SSO_CLIENT_ID must be a safe id');
}

function readTomlStringVar(rendered, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = rendered.match(new RegExp(`^${escaped} = "([^"]+)"$`, 'm'));
  if (!match) throw new Error(`${name} is required`);
  return match[1];
}

function readExecutionMode(rendered, appName, envName) {
  const matches = [...rendered.matchAll(/^PAGES_EXECUTION_MODE = "([^"]+)"$/gm)];
  if (!EXECUTION_MODE_APPS.has(appName)) {
    if (matches.length > 0) throw new Error(`${appName} must not define PAGES_EXECUTION_MODE`);
    return '';
  }
  if (matches.length !== 1) throw new Error(`${appName} template must define exactly one PAGES_EXECUTION_MODE`);

  const mode = matches[0][1];
  assertTokenPolicy('PAGES_EXECUTION_MODE', mode, envName);
  return mode;
}

function renderNormalWorkerSlotServices(appName, envName, replacements, executionMode) {
  if (appName !== 'apps/pages-router') return '';
  const explicitBindings = parseNormalWorkerSlotBindingsJson(replacements.PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON || '', envName);
  if (explicitBindings.length > 0) return renderServiceBindingEntries(explicitBindings);

  const rawCount = replacements.PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT;
  if (rawCount === '' && executionMode !== 'normal-worker-slot') {
    return '';
  }

  const count = Number(rawCount);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT is required when PAGES_EXECUTION_MODE=normal-worker-slot');
  }
  if (count > 999) throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT must be 999 or less');

  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const slotNumber = String(index).padStart(3, '0');
    entries.push({
      bindingName: `SITE_SLOT_${slotNumber}`,
      workerName: `${servicePrefixForEnvironment(envName)}-${slotNumber}`,
    });
  }
  return renderServiceBindingEntries(entries);
}

function parseNormalWorkerSlotBindingsJson(value, envName) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON must be an array');

  const servicePrefix = servicePrefixForEnvironment(envName);
  const seenBindings = new Set();
  const seenWorkers = new Set();
  const bindings = parsed.map((entry) => {
    const bindingName = String(entry?.bindingName || entry?.binding_name || '').trim();
    const workerName = String(entry?.workerName || entry?.worker_name || entry?.service || '').trim();
    if (!/^SITE_SLOT_\d{3,}$/.test(bindingName)) {
      throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON contains an invalid bindingName');
    }
    if (!new RegExp(`^${servicePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{3,}$`).test(workerName)) {
      throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON contains an invalid workerName');
    }
    if (seenBindings.has(bindingName)) throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON contains duplicate bindings');
    if (seenWorkers.has(workerName)) throw new Error('PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON contains duplicate workers');
    seenBindings.add(bindingName);
    seenWorkers.add(workerName);
    return { bindingName, workerName };
  });

  return bindings.sort((left, right) => left.bindingName.localeCompare(right.bindingName));
}

function renderServiceBindingEntries(bindings) {
  return bindings
    .map(
      ({ bindingName, workerName }) => `[[services]]
binding = "${bindingName}"
service = "${workerName}"`
    )
    .join('\n\n');
}

function servicePrefixForEnvironment(envName) {
  return envName === 'staging' ? 'pages-v2-staging-slot' : 'pages-v2-production-slot';
}

function renderPagesApiXdsVpcNetwork(appName, replacements) {
  if (appName !== 'apps/pages-api') return '';

  const tunnelId = String(replacements.PAGES_USER_WORKER_VPC_TUNNEL_ID || '').trim();
  if (!tunnelId) return '';

  return `[[vpc_networks]]
binding = "XD_OFFICE_NET"
tunnel_id = "${tunnelId}"`;
}

function renderPagesAuthXdsVpcNetwork(appName, replacements) {
  if (appName !== 'apps/pages-auth') return '';

  const tunnelId = String(replacements.PAGES_USER_WORKER_VPC_TUNNEL_ID || '').trim();
  if (!tunnelId) return '';

  return `[[vpc_networks]]
binding = "XD_OFFICE_NET"
tunnel_id = "${tunnelId}"`;
}

function assertHttpsUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or fragment`);
  }
}

function assertPositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertIpAllowlist(name, value) {
  if (!/^[0-9A-Fa-f:\s.,/_-]+$/.test(value)) throw new Error(`${name} contains unsupported characters`);
}

function assertAccessKeyPepperRegistry(value) {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error('ACCESS_KEY_PEPPERS must not be empty');

  for (const entry of entries) {
    const [pepperId, secretEnvName, extra] = entry.split(':').map((part) => part.trim());
    if (extra !== undefined || !pepperId || !secretEnvName) {
      throw new Error('ACCESS_KEY_PEPPERS entries must be pepperId:secretEnvName');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(pepperId)) throw new Error('ACCESS_KEY_PEPPERS contains an unsafe pepper id');
    if (!/^ACCESS_KEY_PEPPER_[A-Z0-9_]+$/.test(secretEnvName)) {
      throw new Error('ACCESS_KEY_PEPPERS secret env names must use ACCESS_KEY_PEPPER_*');
    }
  }
}

function assertCindyConnectionConfig(rendered, envName) {
  const audience = readTomlStringVar(rendered, 'CINDY_CONNECTION_AUDIENCE');
  if (audience.length > 64 || !/^[a-z0-9][a-z0-9-]{0,30}:[a-z0-9][a-z0-9-]{0,30}$/.test(audience)) {
    throw new Error('CINDY_CONNECTION_AUDIENCE must use the <orgSlug>:<plugin-slug> format');
  }

  const issuers = readTomlStringVar(rendered, 'CINDY_CONNECTION_ISSUERS')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (issuers.length === 0) throw new Error('CINDY_CONNECTION_ISSUERS must not be empty');
  for (const issuer of issuers) {
    let url;
    try {
      url = new URL(issuer);
    } catch {
      throw new Error('CINDY_CONNECTION_ISSUERS entries must be https origins');
    }
    if (url.protocol !== 'https:' || url.origin !== issuer) {
      throw new Error('CINDY_CONNECTION_ISSUERS entries must be https origins');
    }
  }
  if (envName === 'production' && issuers.some((issuer) => new URL(issuer).hostname.startsWith('auth-dev.'))) {
    throw new Error('Production CINDY_CONNECTION_ISSUERS must not trust a dev issuer');
  }
}

function assertActiveKidPresent(activeKid, registry, activeName, registryName, secretPrefix) {
  if (!activeKid && !registry) return;
  if (!activeKid || !registry) return;
  const kids = assertJwtKeyRegistry(registryName, registry, secretPrefix);
  if (!kids.has(activeKid)) throw new Error(`${activeName} is not present in ${registryName}`);
}

function assertJwtKeyRegistry(name, value, secretPrefix) {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error(`${name} must not be empty`);

  const kids = new Set();
  for (const entry of entries) {
    const [kid, alg, secretEnvName, extra] = entry.split(':').map((part) => part.trim());
    if (extra !== undefined || !kid || !alg || !secretEnvName) {
      throw new Error(`${name} entries must be kid:HS256:${secretPrefix}*`);
    }
    assertSafeKeyId(name, kid);
    if (alg !== 'HS256') throw new Error(`${name} only supports HS256`);
    if (!new RegExp(`^${secretPrefix}[A-Z0-9_]+$`).test(secretEnvName)) {
      throw new Error(`${name} secret env names must use ${secretPrefix}*`);
    }
    if (kids.has(kid)) throw new Error(`${name} contains duplicate kid`);
    kids.add(kid);
  }
  return kids;
}

function assertSafeKeyId(name, value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} must be a safe key id`);
}

function assertNoUnresolvedPlaceholders(rendered, templatePath) {
  if (/__[A-Za-z0-9_]+__/.test(rendered) || /<[^>]+>/.test(rendered)) {
    throw new Error(`unresolved template placeholders remain in ${templatePath}`);
  }
}

function assertNoRuntimeSecrets(rendered, appName) {
  const forbidden = ['CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'SSO_CLIENT_SECRET'];
  for (const name of forbidden) {
    if (rendered.includes(name)) {
      throw new Error(`${appName} wrangler config must not include ${name}`);
    }
  }
}

function assertEnvironmentBoundary(rendered, envName, appName) {
  const expectations = TEMPLATE_EXPECTATIONS[envName];
  for (const pattern of expectations.required) {
    if (!pattern.test(rendered)) throw new Error(`${appName} ${envName} config is missing ${pattern}`);
  }
  for (const pattern of expectations.forbidden) {
    if (pattern.test(rendered)) throw new Error(`${appName} ${envName} config contains cross-environment value`);
  }
}

function usage() {
  console.error('Usage: node scripts/render-pages-v2-wrangler.mjs <app> <production|staging>');
  console.error('Supported apps: apps/pages-api, apps/pages-auth, apps/pages-router, apps/kv-gateway, apps/pages-console');
}
