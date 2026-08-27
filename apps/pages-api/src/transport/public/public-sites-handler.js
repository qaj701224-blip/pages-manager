const PUBLIC_SITES_QUERY_ERROR_CODE = 'PUBLIC_SITES_QUERY_INVALID';
const PUBLIC_SITES_CURSOR_SCOPE = 'public-sites';
const PUBLIC_SITES_CURSOR_VERSION = 1;
const PUBLIC_SITES_CURSOR_MAX_LENGTH = 2048;
const PUBLIC_SITES_DEFAULT_LIMIT = 50;
const PUBLIC_SITES_QUERY_KEYS = new Set(['limit', 'cursor']);
const PUBLIC_SITES_CURSOR_KEYS = new Set(['v', 'scope', 'environment', 'updatedAt', 'id']);
const PUBLIC_SITES_ENVIRONMENTS = new Set(['production', 'staging', 'local']);
const PUBLIC_SITES_LIMIT_PATTERN = /^(?:[1-9]|[1-9][0-9]|100)$/;
const PUBLIC_SITE_ID_PATTERN = /^site_[A-Za-z0-9_-]{1,128}$/;
const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });

class PublicSitesQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicSitesQueryError';
    this.code = PUBLIC_SITES_QUERY_ERROR_CODE;
  }
}

export function parsePublicSitesQuery(url, environment) {
  validateEnvironment(environment);

  let searchParams;
  try {
    const parsedUrl = typeof url === 'string' ? new globalThis.URL(url) : url;
    searchParams = parsedUrl?.searchParams;
    if (!searchParams) throw new TypeError('URL search parameters are required');
  } catch {
    throw invalidQuery('Public sites URL is invalid.');
  }

  const seen = new Set();
  for (const [key] of searchParams) {
    if (!PUBLIC_SITES_QUERY_KEYS.has(key)) throw invalidQuery(`Unknown public sites query parameter: ${key}`);
    if (seen.has(key)) throw invalidQuery(`Public sites query parameter is repeated: ${key}`);
    seen.add(key);
  }

  const limitValue = searchParams.get('limit');
  if (limitValue !== null && !PUBLIC_SITES_LIMIT_PATTERN.test(limitValue)) {
    throw invalidQuery('Public sites limit is invalid.');
  }
  const limit = limitValue === null ? PUBLIC_SITES_DEFAULT_LIMIT : Number(limitValue);

  const cursorValue = searchParams.get('cursor');
  const cursor = cursorValue === null ? null : decodePublicSitesCursor(cursorValue, environment);
  return { limit, cursor };
}

export function encodePublicSitesCursor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidQuery('Public sites cursor input is invalid.');
  }

  const { environment, updatedAt, id } = input;
  validateEnvironment(environment);
  validateUpdatedAt(updatedAt);
  validateSiteId(id);

  const payload = {
    v: PUBLIC_SITES_CURSOR_VERSION,
    scope: PUBLIC_SITES_CURSOR_SCOPE,
    environment,
    updatedAt,
    id,
  };
  const cursor = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  if (cursor.length > PUBLIC_SITES_CURSOR_MAX_LENGTH) throw invalidQuery('Public sites cursor is too long.');
  return cursor;
}

export function decodePublicSitesCursor(value, environment) {
  validateEnvironment(environment);
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PUBLIC_SITES_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw invalidQuery('Public sites cursor encoding is invalid.');
  }

  let payload;
  try {
    const bytes = decodeBase64Url(value);
    payload = JSON.parse(decoder.decode(bytes));
  } catch {
    throw invalidQuery('Public sites cursor payload is invalid.');
  }

  validateCursorPayload(payload, environment);
  return { updatedAt: payload.updatedAt, id: payload.id };
}

function validateCursorPayload(payload, environment) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalidQuery('Public sites cursor payload must be an object.');
  }

  const keys = Object.keys(payload);
  if (
    keys.length !== PUBLIC_SITES_CURSOR_KEYS.size ||
    keys.some((key) => !PUBLIC_SITES_CURSOR_KEYS.has(key)) ||
    [...PUBLIC_SITES_CURSOR_KEYS].some((key) => !Object.hasOwn(payload, key))
  ) {
    throw invalidQuery('Public sites cursor payload shape is invalid.');
  }
  if (payload.v !== PUBLIC_SITES_CURSOR_VERSION) throw invalidQuery('Public sites cursor version is invalid.');
  if (payload.scope !== PUBLIC_SITES_CURSOR_SCOPE) throw invalidQuery('Public sites cursor scope is invalid.');
  if (payload.environment !== environment) throw invalidQuery('Public sites cursor environment is invalid.');
  validateUpdatedAt(payload.updatedAt);
  validateSiteId(payload.id);
}

function validateEnvironment(environment) {
  if (!PUBLIC_SITES_ENVIRONMENTS.has(environment)) throw invalidQuery('Public sites environment is invalid.');
}

function validateUpdatedAt(value) {
  if (typeof value !== 'string') throw invalidQuery('Public sites cursor timestamp is invalid.');
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw invalidQuery('Public sites cursor timestamp is invalid.');
  }
  if (canonical !== value) throw invalidQuery('Public sites cursor timestamp is invalid.');
}

function validateSiteId(value) {
  if (typeof value !== 'string' || !PUBLIC_SITE_ID_PATTERN.test(value)) {
    throw invalidQuery('Public sites cursor site id is invalid.');
  }
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function invalidQuery(message) {
  return new PublicSitesQueryError(message);
}
