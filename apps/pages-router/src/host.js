import { isValidSiteSlug } from '@xd/pages-runtime-protocol';

const PROD_SUFFIX = '.pages.xd.team';
const STAGING_SUFFIX = '-staging.pages.xd.team';

const RESERVED_HOSTS = new Set([
  'api.pages.xd.team',
  'auth.pages.xd.team',
  'router.pages.xd.team',
  'kv-gateway.pages.xd.team',
  'api-staging.pages.xd.team',
  'auth-staging.pages.xd.team',
  'router-staging.pages.xd.team',
  'kv-gateway-staging.pages.xd.team',
]);

const RESERVED_SLUGS = new Set([
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
  'login',
  'logout',
  'callback',
  'oauth',
  'sso',
  'internal',
]);

export function classifyHost(hostname, { environment }) {
  const normalized = String(hostname || '').trim();

  if (RESERVED_HOSTS.has(normalized)) return rejected('RESERVED_HOST', normalized, environment);
  if (normalized.endsWith('.internal.pages.xd.team')) return rejected('RESERVED_HOST', normalized, environment);

  if (environment === 'production') return classifyProductionHost(normalized);
  if (environment === 'staging') return classifyStagingHost(normalized);

  return rejected('INVALID_ENVIRONMENT', normalized, environment);
}

function classifyProductionHost(hostname) {
  if (!hostname.endsWith(PROD_SUFFIX) || hostname === 'pages.xd.team') {
    return rejected('INVALID_HOST', hostname, 'production');
  }

  const slug = hostname.slice(0, -PROD_SUFFIX.length);
  if (slug.includes('.')) return rejected('INVALID_HOST', hostname, 'production');
  if (slug.endsWith('-staging')) return rejected('RESERVED_SLUG', hostname, 'production');

  return validateSlug({ hostname, slug, environment: 'production' });
}

function classifyStagingHost(hostname) {
  if (!hostname.endsWith(STAGING_SUFFIX)) {
    if (hostname.endsWith(PROD_SUFFIX)) return rejected('HOST_ENV_MISMATCH', hostname, 'staging');
    return rejected('INVALID_HOST', hostname, 'staging');
  }

  const slug = hostname.slice(0, -STAGING_SUFFIX.length);
  if (slug.includes('.')) return rejected('INVALID_HOST', hostname, 'staging');

  return validateSlug({ hostname, slug, environment: 'staging' });
}

function validateSlug({ hostname, slug, environment }) {
  if (RESERVED_SLUGS.has(slug)) return rejected('RESERVED_SLUG', hostname, environment);
  if (!isValidSiteSlug(slug)) return rejected('INVALID_SLUG', hostname, environment);

  return { ok: true, environment, hostname, slug };
}

function rejected(code, hostname, environment) {
  return { ok: false, code, hostname, environment };
}
