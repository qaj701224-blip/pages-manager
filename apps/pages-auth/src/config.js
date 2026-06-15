const AUTH_CONFIG_BY_ENV = {
  production: {
    authBase: 'https://auth.pages.xd.team',
    apiBase: 'https://api.pages.xd.team',
    callbackUrl: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
  },
  staging: {
    authBase: 'https://auth-staging.pages.xd.team',
    apiBase: 'https://api-staging.pages.xd.team',
    callbackUrl: 'https://auth-staging.pages.xd.team/.xd-pages/auth/callback',
  },
  local: {
    authBase: 'http://xd-pages.127.0.0.1.nip.io:8787',
    apiBase: 'http://xd-pages.127.0.0.1.nip.io:8787',
    callbackUrl: 'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback',
  },
};

const TTL_ENV_NAMES = {
  oauthStateTtlSeconds: 'OAUTH_STATE_TTL_SECONDS',
  cliLoginTtlSeconds: 'CLI_LOGIN_TTL_SECONDS',
  authSessionIdleTtlSeconds: 'AUTH_SESSION_IDLE_TTL_SECONDS',
  authSessionAbsoluteTtlSeconds: 'AUTH_SESSION_ABSOLUTE_TTL_SECONDS',
};

export function readAuthConfig(env = {}) {
  const environment = readEnvironment(env.PAGES_ENV);
  const expected = AUTH_CONFIG_BY_ENV[environment];
  const authBase = normalizeOrigin(env.PUBLIC_AUTH_BASE || expected.authBase, 'auth base');
  const apiBase = normalizeOrigin(env.PUBLIC_API_BASE || expected.apiBase, 'api base');
  const ssoRedirectUri = normalizeUrl(env.SSO_REDIRECT_URI || expected.callbackUrl, 'redirect URI');

  if (authBase !== expected.authBase) throw new Error('Auth base does not match Pages environment');
  if (ssoRedirectUri !== expected.callbackUrl) throw new Error('SSO redirect URI does not match Pages environment');

  return {
    environment,
    authBase,
    authHost: new URL(authBase).hostname,
    apiBase,
    ssoRedirectUri,
    oauthStateTtlSeconds: readPositiveInteger(env.OAUTH_STATE_TTL_SECONDS, 300, TTL_ENV_NAMES.oauthStateTtlSeconds),
    cliLoginTtlSeconds: readPositiveInteger(env.CLI_LOGIN_TTL_SECONDS, 600, TTL_ENV_NAMES.cliLoginTtlSeconds),
    authSessionIdleTtlSeconds: readPositiveInteger(
      env.AUTH_SESSION_IDLE_TTL_SECONDS,
      1_209_600,
      TTL_ENV_NAMES.authSessionIdleTtlSeconds
    ),
    authSessionAbsoluteTtlSeconds: readPositiveInteger(
      env.AUTH_SESSION_ABSOLUTE_TTL_SECONDS,
      2_592_000,
      TTL_ENV_NAMES.authSessionAbsoluteTtlSeconds
    ),
  };
}

export function readEnvironment(value) {
  if (value === 'production' || value === 'staging' || value === 'local') return value;
  throw new Error('Auth environment is invalid');
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

function normalizeUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`Invalid ${label}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Invalid ${label}`);
  if (url.username || url.password || url.hash) throw new Error(`Invalid ${label}`);
  if (url.search) throw new Error(`Invalid ${label}`);
  return url.toString();
}

function readPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
