export const RUNTIME = {
  VERSION: 'v1',
  BASE_PATH: '/.xd-pages/runtime/v1',
  KV_GET_PATH: '/.xd-pages/runtime/v1/kv/get',
  KV_SET_PATH: '/.xd-pages/runtime/v1/kv/set',
  KV_DELETE_PATH: '/.xd-pages/runtime/v1/kv/delete',
  DATA_SITE_GET_PATH: '/.xd-pages/runtime/v1/data/site/get',
  DATA_SITE_SET_PATH: '/.xd-pages/runtime/v1/data/site/set',
  DATA_SITE_DELETE_PATH: '/.xd-pages/runtime/v1/data/site/delete',
  DATA_USER_GET_PATH: '/.xd-pages/runtime/v1/data/user/get',
  DATA_USER_SET_PATH: '/.xd-pages/runtime/v1/data/user/set',
  DATA_USER_DELETE_PATH: '/.xd-pages/runtime/v1/data/user/delete',
};

export const GATEWAY = {
  BASE_PATH: '/v1',
  KV_GET_PATH: '/v1/kv/get',
  KV_SET_PATH: '/v1/kv/set',
  KV_DELETE_PATH: '/v1/kv/delete',
  DATA_SITE_GET_PATH: '/v1/data/site/get',
  DATA_SITE_SET_PATH: '/v1/data/site/set',
  DATA_SITE_DELETE_PATH: '/v1/data/site/delete',
  DATA_USER_GET_PATH: '/v1/data/user/get',
  DATA_USER_SET_PATH: '/v1/data/user/set',
  DATA_USER_DELETE_PATH: '/v1/data/user/delete',
};

export const HEADERS = {
  RUNTIME_REQUEST: 'X-XD-Pages-Runtime',
  REQUEST_ID: 'X-XD-Pages-Request-Id',
};

export const BINDINGS = {
  ASSETS: 'ASSETS',
  KV_GATEWAY: 'XD_PAGES_KV_GATEWAY',
  SITE_ID: 'XD_PAGES_SITE_ID',
  SITE_UUID: 'XD_PAGES_SITE_UUID',
  ENV: 'XD_PAGES_ENV',
  KV_CAPABILITY: 'XD_PAGES_KV_CAPABILITY',
};

export const ERROR_CODES = {
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_TTL: 'INVALID_TTL',
  INVALID_KV_OPTION: 'INVALID_KV_OPTION',
  KV_DECODE_FAILED: 'KV_DECODE_FAILED',
  KV_VALUE_TOO_LARGE: 'KV_VALUE_TOO_LARGE',
  FORBIDDEN: 'FORBIDDEN',
  CAPABILITY_INVALID: 'CAPABILITY_INVALID',
  CAPABILITY_SCOPE_DENIED: 'CAPABILITY_SCOPE_DENIED',
  KV_FAILED: 'KV_FAILED',
  INVALID_RUNTIME_RESPONSE: 'INVALID_RUNTIME_RESPONSE',
  USER_REQUIRED: 'USER_REQUIRED',
};

const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const SITE_UUID_RE = /^[0-9a-f]{32}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
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
const MAX_USER_KEY_BYTES = 256;
const MAX_STORAGE_KEY_BYTES = 512;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 31_536_000;

export function buildOkEnvelope(payload = {}) {
  return { ...payload, ok: true };
}

export function buildErrorEnvelope(code, message) {
  return { ok: false, error: { code, message } };
}

export function parseKvEnabled(value) {
  if (value === true || value === 'true') return { enabled: true };
  if (value === undefined || value === null || value === false || value === 'false') return { enabled: false };

  return {
    enabled: false,
    error: { code: ERROR_CODES.INVALID_KV_OPTION, message: 'kv must be true or false' },
  };
}

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

export function isValidSiteUuid(siteUuid) {
  return typeof siteUuid === 'string' && SITE_UUID_RE.test(siteUuid);
}

export function validateUserKey(key) {
  if (
    typeof key !== 'string' ||
    key === '' ||
    key === '.' ||
    key === '..' ||
    key.startsWith('.xd-pages/') ||
    key.startsWith('__xd_pages/') ||
    hasUnpairedSurrogate(key) ||
    utf8ByteLength(key) > MAX_USER_KEY_BYTES
  ) {
    return invalidKey();
  }

  return { ok: true, value: key };
}

export function encodeUserKey(key) {
  const bytes = new globalThis.TextEncoder().encode(key);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildStorageKey({ siteSlug, siteUuid, userKey }) {
  if (!isValidSiteSlug(siteSlug)) throw new Error('Invalid site slug');
  if (!isValidSiteUuid(siteUuid)) throw new Error('Invalid site UUID');

  const keyValidation = validateUserKey(userKey);
  if (!keyValidation.ok) throw new Error(keyValidation.error.message);

  const storageKey = `s/${siteSlug}--${siteUuid}/k/${encodeUserKey(keyValidation.value)}`;
  if (utf8ByteLength(storageKey) > MAX_STORAGE_KEY_BYTES) throw new Error('Storage key exceeds Cloudflare KV key limit');

  return storageKey;
}

export function isValidUserId(userId) {
  return typeof userId === 'string' && USER_ID_RE.test(userId);
}

export function validateUserId(userId) {
  if (!isValidUserId(userId)) {
    return { ok: false, error: { code: ERROR_CODES.USER_REQUIRED, message: 'Invalid user id' } };
  }
  return { ok: true, value: userId };
}

export function buildUserStorageKey({ siteSlug, siteUuid, userId, userKey }) {
  if (!isValidSiteSlug(siteSlug)) throw new Error('Invalid site slug');
  if (!isValidSiteUuid(siteUuid)) throw new Error('Invalid site UUID');
  if (!isValidUserId(userId)) throw new Error('Invalid user id');

  const keyValidation = validateUserKey(userKey);
  if (!keyValidation.ok) throw new Error(keyValidation.error.message);

  const storageKey = `s/${siteSlug}--${siteUuid}/u/${userId}/k/${encodeUserKey(keyValidation.value)}`;
  if (utf8ByteLength(storageKey) > MAX_STORAGE_KEY_BYTES) throw new Error('Storage key exceeds Cloudflare KV key limit');

  return storageKey;
}

export function scopeForDataOperation(dataScope, operation) {
  if ((dataScope !== 'site' && dataScope !== 'user') || !['get', 'set', 'delete'].includes(operation)) {
    throw new Error('Invalid data scope operation');
  }
  return `data:${dataScope}:${operation}`;
}

export function validateKvType(type = 'json') {
  if (type === 'json' || type === 'text') return { ok: true, value: type };

  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_TYPE, message: 'Invalid data value type' },
  };
}

export function validateTtl(expirationTtl) {
  if (expirationTtl === undefined || expirationTtl === null) return { ok: true, value: undefined };
  if (
    Number.isInteger(expirationTtl) &&
    expirationTtl >= MIN_TTL_SECONDS &&
    expirationTtl <= MAX_TTL_SECONDS
  ) {
    return { ok: true, value: expirationTtl };
  }

  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_TTL, message: 'Invalid data expiration TTL' },
  };
}

function invalidKey() {
  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid data key' },
  };
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function utf8ByteLength(value) {
  return new globalThis.TextEncoder().encode(value).byteLength;
}
