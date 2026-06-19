/* global TextEncoder */

export const RUNTIME = {
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
};

export const ERROR_CODES = {
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_TTL: 'INVALID_TTL',
  KV_FAILED: 'KV_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_PLATFORM_CONTEXT: 'INVALID_PLATFORM_CONTEXT',
  INVALID_RUNTIME_RESPONSE: 'INVALID_RUNTIME_RESPONSE',
  USER_REQUIRED: 'USER_REQUIRED',
};

const MAX_USER_KEY_BYTES = 256;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 31_536_000;

export function buildOkEnvelope(payload: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...payload, ok: true };
}

export function buildErrorEnvelope(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

export function validateUserKey(key: unknown):
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } } {
  if (
    typeof key !== 'string' ||
    key === '' ||
    key === '.' ||
    key === '..' ||
    key.startsWith('.xd-pages/') ||
    key.startsWith('__xd_pages/') ||
    hasUnpairedSurrogate(key) ||
    new TextEncoder().encode(key).byteLength > MAX_USER_KEY_BYTES
  ) {
    return {
      ok: false,
      error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid data key' },
    };
  }

  return { ok: true, value: key };
}

export function validateKvType(type: unknown = 'json'):
  | { ok: true; value: 'json' | 'text' }
  | { ok: false; error: { code: string; message: string } } {
  if (type === 'json' || type === 'text') return { ok: true, value: type };

  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_TYPE, message: 'Invalid data value type' },
  };
}

export function validateTtl(expirationTtl: unknown):
  | { ok: true; value: number | undefined }
  | { ok: false; error: { code: string; message: string } } {
  if (expirationTtl === undefined || expirationTtl === null) return { ok: true, value: undefined };
  if (
    Number.isInteger(expirationTtl) &&
    (expirationTtl as number) >= MIN_TTL_SECONDS &&
    (expirationTtl as number) <= MAX_TTL_SECONDS
  ) {
    return { ok: true, value: expirationTtl as number };
  }

  return {
    ok: false,
    error: { code: ERROR_CODES.INVALID_TTL, message: 'Invalid data expiration TTL' },
  };
}

function hasUnpairedSurrogate(value: string): boolean {
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
