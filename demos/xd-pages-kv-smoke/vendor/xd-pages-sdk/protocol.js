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
export function buildOkEnvelope(payload = {}) {
    return { ...payload, ok: true };
}
export function buildErrorEnvelope(code, message) {
    return { ok: false, error: { code, message } };
}
export function validateUserKey(key) {
    if (typeof key !== 'string' ||
        key === '' ||
        key === '.' ||
        key === '..' ||
        key.startsWith('.xd-pages/') ||
        key.startsWith('__xd_pages/') ||
        hasUnpairedSurrogate(key) ||
        new TextEncoder().encode(key).byteLength > MAX_USER_KEY_BYTES) {
        return {
            ok: false,
            error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid KV key' },
        };
    }
    return { ok: true, value: key };
}
export function validateKvType(type = 'json') {
    if (type === 'json' || type === 'text')
        return { ok: true, value: type };
    return {
        ok: false,
        error: { code: ERROR_CODES.INVALID_TYPE, message: 'Invalid KV value type' },
    };
}
export function validateTtl(expirationTtl) {
    if (expirationTtl === undefined || expirationTtl === null)
        return { ok: true, value: undefined };
    if (Number.isInteger(expirationTtl) &&
        expirationTtl >= MIN_TTL_SECONDS &&
        expirationTtl <= MAX_TTL_SECONDS) {
        return { ok: true, value: expirationTtl };
    }
    return {
        ok: false,
        error: { code: ERROR_CODES.INVALID_TTL, message: 'Invalid KV expiration TTL' },
    };
}
function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            if (index + 1 >= value.length)
                return true;
            const nextCodeUnit = value.charCodeAt(index + 1);
            if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff)
                return true;
            index += 1;
        }
        else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            return true;
        }
    }
    return false;
}
