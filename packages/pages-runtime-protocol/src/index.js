import { isValidSiteSlug } from './slug.js';

export const RUNTIME = {
  VERSION: 'v1',
  BASE_PATH: '/.xd-pages/runtime/v1',
  KV_GET_PATH: '/.xd-pages/runtime/v1/kv/get',
  KV_GET_WITH_METADATA_PATH: '/.xd-pages/runtime/v1/kv/get-with-metadata',
  KV_LIST_PATH: '/.xd-pages/runtime/v1/kv/list',
  KV_SET_PATH: '/.xd-pages/runtime/v1/kv/set',
  KV_DELETE_PATH: '/.xd-pages/runtime/v1/kv/delete',
  DATA_SITE_GET_PATH: '/.xd-pages/runtime/v1/data/site/get',
  DATA_SITE_GET_WITH_METADATA_PATH: '/.xd-pages/runtime/v1/data/site/get-with-metadata',
  DATA_SITE_LIST_PATH: '/.xd-pages/runtime/v1/data/site/list',
  DATA_SITE_SET_PATH: '/.xd-pages/runtime/v1/data/site/set',
  DATA_SITE_DELETE_PATH: '/.xd-pages/runtime/v1/data/site/delete',
  DATA_USER_GET_PATH: '/.xd-pages/runtime/v1/data/user/get',
  DATA_USER_SET_PATH: '/.xd-pages/runtime/v1/data/user/set',
  DATA_USER_DELETE_PATH: '/.xd-pages/runtime/v1/data/user/delete',
};

export const GATEWAY = {
  BASE_PATH: '/v1',
  KV_GET_PATH: '/v1/kv/get',
  KV_GET_WITH_METADATA_PATH: '/v1/kv/get-with-metadata',
  KV_LIST_PATH: '/v1/kv/list',
  KV_SET_PATH: '/v1/kv/set',
  KV_DELETE_PATH: '/v1/kv/delete',
  DATA_SITE_GET_PATH: '/v1/data/site/get',
  DATA_SITE_GET_WITH_METADATA_PATH: '/v1/data/site/get-with-metadata',
  DATA_SITE_LIST_PATH: '/v1/data/site/list',
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
  INVALID_EXPIRATION: 'INVALID_EXPIRATION',
  INVALID_METADATA: 'INVALID_METADATA',
  INVALID_LIMIT: 'INVALID_LIMIT',
  INVALID_CURSOR: 'INVALID_CURSOR',
  INVALID_KV_OPTION: 'INVALID_KV_OPTION',
  UNSUPPORTED_KV_OPTION: 'UNSUPPORTED_KV_OPTION',
  KV_DECODE_FAILED: 'KV_DECODE_FAILED',
  KV_VALUE_TOO_LARGE: 'KV_VALUE_TOO_LARGE',
  FORBIDDEN: 'FORBIDDEN',
  CAPABILITY_INVALID: 'CAPABILITY_INVALID',
  CAPABILITY_SCOPE_DENIED: 'CAPABILITY_SCOPE_DENIED',
  KV_FAILED: 'KV_FAILED',
  INVALID_RUNTIME_RESPONSE: 'INVALID_RUNTIME_RESPONSE',
  USER_REQUIRED: 'USER_REQUIRED',
};

const SITE_UUID_RE = /^[0-9a-f]{32}$/;
const SITE_ID_RE = /^site_[0-9a-f]{32}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_USER_KEY_BYTES = 256;
const MAX_STORAGE_KEY_BYTES = 512;
const MAX_METADATA_BYTES = 1024;
const MAX_LIST_LIMIT = 1000;
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

export function isValidSiteUuid(siteUuid) {
  return typeof siteUuid === 'string' && SITE_UUID_RE.test(siteUuid);
}

export function isValidSiteId(siteId) {
  return typeof siteId === 'string' && SITE_ID_RE.test(siteId);
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

export function decodeUserKey(encodedKey) {
  if (typeof encodedKey !== 'string' || /[^A-Za-z0-9_-]/.test(encodedKey)) throw new Error('Invalid data key');
  const padded = encodedKey.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encodedKey.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new globalThis.TextDecoder().decode(bytes);
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
  if ((dataScope !== 'site' && dataScope !== 'user') || !['get', 'set', 'delete', 'list'].includes(operation)) {
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

export function validateExpiration(expiration, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (expiration === undefined || expiration === null) return { ok: true, value: undefined };
  if (Number.isInteger(expiration) && expiration >= nowSeconds + MIN_TTL_SECONDS) {
    return { ok: true, value: expiration };
  }

  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_EXPIRATION, message: 'Invalid data expiration' },
  };
}

export function validateMetadata(metadata) {
  if (metadata === undefined) return { ok: true, value: undefined };
  if (metadata === null) return { ok: true, value: null };
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return invalidMetadata();
  }
  if (Object.hasOwn(metadata, '__xd_pages') || Object.hasOwn(metadata, '.xd-pages')) {
    return invalidMetadata();
  }

  let serialized;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return invalidMetadata();
  }
  if (serialized === undefined || utf8ByteLength(serialized) > MAX_METADATA_BYTES) return invalidMetadata();

  return { ok: true, value: metadata };
}

export function validateListOptions({ prefix, limit, cursor } = {}) {
  if (prefix !== undefined && prefix !== '') {
    const key = validateUserKey(prefix);
    if (!key.ok) return key;
  }
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      return { ok: false, error: { code: ERROR_CODES.INVALID_LIMIT, message: 'Invalid data list limit' } };
    }
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_CURSOR, message: 'Invalid data list cursor' } };
  }
  return { ok: true, value: { prefix, limit, cursor } };
}

function invalidKey() {
  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid data key' },
  };
}

function invalidMetadata() {
  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_METADATA, message: 'Invalid data metadata' },
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

export * from './host.js';
export * from './slug.js';
