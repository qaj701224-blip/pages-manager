const API_CONFIG_BY_ENV = {
  production: {
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  },
  staging: {
    apiBaseUrl: 'https://api-staging.pages.xd.team',
    authBaseUrl: 'https://auth-staging.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  },
  local: {
    apiBaseUrl: 'http://xd-pages.127.0.0.1.nip.io:8787',
    authBaseUrl: 'http://xd-pages.127.0.0.1.nip.io:8787',
    siteDomainSuffix: '127.0.0.1.nip.io',
  },
};

export function readApiConfig(env = {}) {
  const environment = readEnvironment(env.PAGES_ENV);
  const expected = API_CONFIG_BY_ENV[environment];
  const apiBaseUrl = normalizeOrigin(env.PUBLIC_API_BASE || expected.apiBaseUrl, 'API base');
  const authBaseUrl = normalizeOrigin(env.PUBLIC_AUTH_BASE || expected.authBaseUrl, 'auth base');

  if (apiBaseUrl !== expected.apiBaseUrl) throw new Error('API base does not match Pages environment');
  if (authBaseUrl !== expected.authBaseUrl) throw new Error('Auth base does not match Pages environment');

  return {
    environment,
    apiBaseUrl,
    authBaseUrl,
    siteDomainSuffix: expected.siteDomainSuffix,
  };
}

function readEnvironment(value) {
  if (value === 'production' || value === 'staging' || value === 'local') return value;
  throw new Error('PAGES_ENV is invalid');
}

function normalizeOrigin(value, label) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`Invalid ${label}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Invalid ${label}`);
  if (url.username || url.password) throw new Error(`Invalid ${label}`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid ${label}`);
  return url.origin;
}
