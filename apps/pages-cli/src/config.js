export const FIXED_ENVIRONMENTS = {
  production: {
    environment: 'production',
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  },
  staging: {
    environment: 'staging',
    apiBaseUrl: 'https://api-staging.pages.xd.team',
    authBaseUrl: 'https://auth-staging.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  },
};

export function readCliConfig(env = {}, options = {}) {
  const environment = resolveEnvironment(options.environment || env.PAGES_CLI_ENV || env.PAGES_ENV || 'production');
  if (environment !== 'custom') {
    if (env.PAGES_API_BASE || env.PAGES_AUTH_BASE || options.apiBaseUrl || options.authBaseUrl) {
      throw new Error('Users cannot override fixed Pages environment endpoints.');
    }
    return { ...FIXED_ENVIRONMENTS[environment] };
  }

  const apiBaseUrl = validateTrustedOrigin(options.apiBaseUrl || env.PAGES_API_BASE, { environment });
  const authBaseUrl = validateTrustedOrigin(options.authBaseUrl || env.PAGES_AUTH_BASE, { environment });
  const siteDomainSuffix = normalizeSiteDomainSuffix(
    options.siteDomainSuffix || env.PAGES_SITE_DOMAIN_SUFFIX || new URL(apiBaseUrl).hostname,
    { environment }
  );
  return {
    environment,
    apiBaseUrl,
    authBaseUrl,
    siteDomainSuffix,
  };
}

export function resolveEnvironment(value) {
  if (value === 'production' || value === 'staging' || value === 'custom') return value;
  throw new Error('XD Cell CLI environment is invalid.');
}

export function validateTrustedOrigin(value, { environment }) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Invalid URL origin.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid URL origin.');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid URL origin.');
  if (url.hostname === 'workers.xd.team' || url.hostname.endsWith('.workers.xd.team')) {
    throw new Error('workers.xd.team is a legacy domain and is not supported by the CLI.');
  }

  if (environment === 'custom') {
    if (!isLoopbackHost(url.hostname)) throw new Error('Pages custom endpoints must be loopback origins.');
    return url.origin;
  }

  return url.origin;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '127.0.0.1.nip.io' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    normalized.endsWith('.127.0.0.1.nip.io')
  );
}

function normalizeSiteDomainSuffix(value, { environment } = {}) {
  const suffix = String(value || '')
    .trim()
    .toLowerCase();
  if (!suffix || suffix.includes('/') || suffix.includes(':')) throw new Error('Site domain suffix is invalid.');
  if (suffix === 'workers.xd.team' || suffix.endsWith('.workers.xd.team')) {
    throw new Error('workers.xd.team is a legacy domain and is not supported by the CLI.');
  }
  if (environment === 'custom' && !isLoopbackHost(suffix)) throw new Error('Pages custom site suffix must be loopback.');
  return suffix;
}
