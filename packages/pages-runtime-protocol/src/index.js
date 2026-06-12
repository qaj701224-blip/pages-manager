export const RUNTIME = {
  VERSION: 'v1',
  BASE_PATH: '/.xd-pages/runtime/v1',
  KV_GET_PATH: '/.xd-pages/runtime/v1/kv/get',
  KV_PUT_PATH: '/.xd-pages/runtime/v1/kv/put',
  KV_DELETE_PATH: '/.xd-pages/runtime/v1/kv/delete',
};

export const GATEWAY = {
  BASE_PATH: '/v1',
  KV_GET_PATH: '/v1/kv/get',
  KV_PUT_PATH: '/v1/kv/put',
  KV_DELETE_PATH: '/v1/kv/delete',
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
};

const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const SITE_UUID_RE = /^[0-9a-f]{32}$/;
const MAX_USER_KEY_BYTES = 256;
const MAX_STORAGE_KEY_BYTES = 512;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 31_536_000;

export function buildOkEnvelope(payload = {}) {
  return { ok: true, ...payload };
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

export function validateKvType(type = 'json') {
  if (type === 'json' || type === 'text') return { ok: true, value: type };

  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_TYPE, message: 'Invalid KV value type' },
  };
}

export function validateTtl(expirationTtl) {
  if (expirationTtl === undefined) return { ok: true, value: undefined };
  if (
    Number.isInteger(expirationTtl) &&
    expirationTtl >= MIN_TTL_SECONDS &&
    expirationTtl <= MAX_TTL_SECONDS
  ) {
    return { ok: true, value: expirationTtl };
  }

  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_TTL, message: 'Invalid KV expiration TTL' },
  };
}

function invalidKey() {
  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid KV key' },
  };
}

function utf8ByteLength(value) {
  return new globalThis.TextEncoder().encode(value).byteLength;
}
