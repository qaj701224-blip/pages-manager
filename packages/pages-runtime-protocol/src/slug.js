const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const RESERVED_SITE_SLUGS = new Set([
  'api',
  'api-staging',
  'auth',
  'auth-staging',
  'admin',
  'admin-staging',
  'manager',
  'manager-staging',
  'router',
  'router-staging',
  'kv-gateway',
  'kv-gateway-staging',
  'pages',
  'www',
  'mail',
  'static',
  'assets',
  'login',
  'logout',
  'callback',
  'oauth',
  'sso',
  'internal',
  'status',
  'health',
  'docs',
  'readme',
  'skill',
  'openapi',
  'help',
  'support',
  'console',
  'dashboard',
  'portal',
  'site',
  'sites',
  'deploy',
  'deployments',
  'version',
  'versions',
  'rollback',
  'access',
  'access-keys',
  'token',
  'tokens',
  'env',
  'environments',
  'runtime',
  'data',
  'kv',
  'storage',
  'worker',
  'workers',
  'dispatch',
  'gateway',
  'metrics',
  'logs',
  'audit',
  'events',
  'webhook',
  'webhooks',
  'monitor',
  'monitoring',
  'pages-api',
  'pages-api-staging',
  'pages-auth',
  'pages-auth-staging',
  'pages-router',
  'pages-router-staging',
  'pages-kv-gateway',
  'pages-kv-gateway-staging',
]);
const RESERVED_SITE_SLUG_PREFIXES = [
  'production-slot-',
  'staging-slot-',
  'v2-production-slot-',
  'v2-staging-slot-',
  'pages-v2-production-slot-',
  'pages-v2-staging-slot-',
];

export function isValidSiteSlug(siteSlug) {
  return typeof siteSlug === 'string' && SITE_SLUG_RE.test(siteSlug);
}

export function isReservedSiteSlug(siteSlug, { environment } = {}) {
  const value = String(siteSlug || '').trim();
  return (
    RESERVED_SITE_SLUGS.has(value) ||
    RESERVED_SITE_SLUG_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    (environment === 'production' && (value === 'staging' || value.startsWith('staging-'))) ||
    (environment === 'production' && value.endsWith('-staging'))
  );
}

export function validateSiteSlug(siteSlug, options = {}) {
  if (!isValidSiteSlug(siteSlug)) {
    return { ok: false, error: { code: 'INVALID_SLUG', message: 'Invalid site slug' } };
  }
  if (isReservedSiteSlug(siteSlug, options)) {
    return { ok: false, error: { code: 'RESERVED_SLUG', message: 'Reserved site slug' } };
  }
  return { ok: true, value: siteSlug };
}
