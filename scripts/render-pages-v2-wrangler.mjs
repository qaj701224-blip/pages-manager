#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_APPS = new Set(['apps/pages-api', 'apps/pages-auth', 'apps/pages-router', 'apps/kv-gateway']);
const SUPPORTED_ENVIRONMENTS = new Set(['production', 'staging']);

const DEFAULTS = {
  WFP_COMPATIBILITY_DATE: '2026-06-15',
  PAGES_NORMAL_WORKER_SLOT_COUNT: '',
  OAUTH_STATE_TTL_SECONDS: '300',
  CLI_LOGIN_TTL_SECONDS: '600',
  AUTH_SESSION_IDLE_TTL_SECONDS: '1209600',
  AUTH_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
  SITE_SESSION_IDLE_TTL_SECONDS: '604800',
  SITE_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
  SITE_SESSION_FRESHNESS_TTL_SECONDS: '900',
  INTERNAL_WORKER_JWT_TTL_SECONDS: '60',
  ROUTE_CACHE_TTL_SECONDS: '10',
  SSO_ALLOWED_USER_SCOPE: 'xindong',
};

const REQUIRED_TOKENS_BY_APP = {
  'apps/pages-api': [
    'CLOUDFLARE_ACCOUNT_ID',
    'D1_DATABASE_ID',
    'ROUTE_SNAPSHOTS_KV_ID',
    'ACCESS_KEY_ACTIVE_PEPPER_ID',
    'ACCESS_KEY_PEPPERS',
    'PAGES_EXECUTION_MODE',
  ],
  'apps/pages-auth': [
    'CLOUDFLARE_ACCOUNT_ID',
    'PAGES_SESSION_JWT_ACTIVE_KID',
    'PAGES_SESSION_JWT_KEYS',
    'SSO_AUTHORIZATION_URL',
    'SSO_TOKEN_URL',
    'SSO_PROFILE_URL',
    'SSO_CLIENT_ID',
  ],
  'apps/pages-router': [
    'CLOUDFLARE_ACCOUNT_ID',
    'ROUTER_IP_ALLOWLIST_CIDRS',
    'ROUTE_SNAPSHOTS_KV_ID',
    'PAGES_SESSION_JWT_ACTIVE_KID',
    'PAGES_SESSION_JWT_KEYS',
    'PAGES_CAP_JWT_ACTIVE_KID',
    'PAGES_CAP_JWT_KEYS',
    'PAGES_EXECUTION_MODE',
  ],
  'apps/kv-gateway': [
    'CLOUDFLARE_ACCOUNT_ID',
    'SITE_DATA_KV_ID',
    'PAGES_CAP_JWT_ACTIVE_KID',
    'PAGES_CAP_JWT_KEYS',
  ],
};

const OPTIONAL_TOKENS_BY_APP = {
  'apps/pages-api': ['WFP_COMPATIBILITY_DATE'],
  'apps/pages-auth': [
    'OAUTH_STATE_TTL_SECONDS',
    'CLI_LOGIN_TTL_SECONDS',
    'AUTH_SESSION_IDLE_TTL_SECONDS',
    'AUTH_SESSION_ABSOLUTE_TTL_SECONDS',
    'SITE_SESSION_IDLE_TTL_SECONDS',
    'SITE_SESSION_ABSOLUTE_TTL_SECONDS',
    'SSO_ALLOWED_USER_SCOPE',
  ],
  'apps/pages-router': [
    'PAGES_NORMAL_WORKER_SLOT_COUNT',
    'ROUTE_CACHE_TTL_SECONDS',
    'SITE_SESSION_IDLE_TTL_SECONDS',
    'SITE_SESSION_FRESHNESS_TTL_SECONDS',
    'INTERNAL_WORKER_JWT_TTL_SECONDS',
  ],
  'apps/kv-gateway': [],
};

const TEMPLATE_EXPECTATIONS = {
  production: {
    forbidden: [
      /api-staging\.pages\.xd\.team/,
      /auth-staging\.pages\.xd\.team/,
      /PAGES_ENV = "staging"/,
      /pages-staging/,
      /service = "pages-(?:api|auth)-staging"/,
      /name = "pages-[^"]+-staging"/,
    ],
    required: [/PAGES_ENV = "production"/],
  },
  staging: {
    forbidden: [/PAGES_ENV = "production"/, /namespace = "pages-production"/],
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
    assertTomlSafe(token, value);
    assertTokenPolicy(token, value);
    rendered = rendered.replaceAll(`__${token}__`, value);
  }
  rendered = rendered.replaceAll(
    '__NORMAL_WORKER_SLOT_SERVICES__',
    renderNormalWorkerSlotServices(appName, envName, replacements)
  );
  rendered = rendered.replaceAll(
    '__WFP_DISPATCH_NAMESPACE_BINDING__',
    renderWfpDispatchNamespaceBinding(appName, envName, replacements)
  );

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

function assertTokenPolicy(name, value) {
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
  if (name === 'PAGES_NORMAL_WORKER_SLOT_COUNT' && value !== '') {
    assertPositiveInteger(name, value);
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

function renderNormalWorkerSlotServices(appName, envName, replacements) {
  if (appName !== 'apps/pages-router') return '';
  if (replacements.PAGES_EXECUTION_MODE !== 'normal-worker-slot' && replacements.PAGES_NORMAL_WORKER_SLOT_COUNT === '') {
    return '';
  }

  const count = Number(replacements.PAGES_NORMAL_WORKER_SLOT_COUNT);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('PAGES_NORMAL_WORKER_SLOT_COUNT is required when PAGES_EXECUTION_MODE=normal-worker-slot');
  }
  if (count > 999) throw new Error('PAGES_NORMAL_WORKER_SLOT_COUNT must be 999 or less');

  const servicePrefix = envName === 'staging' ? 'pages-v2-staging-slot' : 'pages-v2-production-slot';
  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const slotNumber = String(index).padStart(3, '0');
    entries.push(`[[services]]
binding = "SITE_SLOT_${slotNumber}"
service = "${servicePrefix}-${slotNumber}"`);
  }
  return entries.join('\n\n');
}

function renderWfpDispatchNamespaceBinding(appName, envName, replacements) {
  if (appName !== 'apps/pages-router') return '';
  if (replacements.PAGES_EXECUTION_MODE === 'normal-worker-slot') return '';

  const namespace = envName === 'staging' ? 'pages-staging' : 'pages-production';
  return `[[dispatch_namespaces]]
binding = "PAGES_DISPATCH"
namespace = "${namespace}"`;
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
  console.error('Supported apps: apps/pages-api, apps/pages-auth, apps/pages-router, apps/kv-gateway');
}
