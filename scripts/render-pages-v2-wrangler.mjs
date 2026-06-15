#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_APPS = new Set(['apps/pages-api', 'apps/pages-auth', 'apps/pages-router']);
const SUPPORTED_ENVIRONMENTS = new Set(['production', 'staging']);

const DEFAULTS = {
  WFP_COMPATIBILITY_DATE: '2026-06-15',
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
  'apps/pages-api': ['CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'ROUTE_SNAPSHOTS_KV_ID'],
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
    'ROUTE_CACHE_TTL_SECONDS',
    'SITE_SESSION_IDLE_TTL_SECONDS',
    'SITE_SESSION_FRESHNESS_TTL_SECONDS',
    'INTERNAL_WORKER_JWT_TTL_SECONDS',
  ],
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
  for (const [token, value] of Object.entries(replacements)) {
    assertTomlSafe(token, value);
    assertTokenPolicy(token, value);
    rendered = rendered.replaceAll(`__${token}__`, value);
  }

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
  console.error('Supported apps: apps/pages-api, apps/pages-auth, apps/pages-router');
}
