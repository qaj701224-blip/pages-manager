import { ERROR_CODES, HEADERS, RUNTIME } from './protocol.js';
import { PagesSDKError } from './errors.js';
export { PagesSDKError } from './errors.js';
export function createPagesClient(options = {}) {
    const fetchFn = options.fetch ?? globalThis.fetch;
    const basePath = options.basePath ?? RUNTIME.BASE_PATH;
    async function post(path, body) {
        const response = await fetchFn(buildRuntimePath(basePath, path), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [HEADERS.RUNTIME_REQUEST]: '1',
            },
            body: JSON.stringify(body),
        });
        return readEnvelope(response);
    }
    const legacySite = createDataStore(post, {
        get: '/kv/get',
        set: '/kv/set',
        delete: '/kv/delete',
    });
    const data = {
        site: createDataStore(post, {
            get: '/data/site/get',
            set: '/data/site/set',
            delete: '/data/site/delete',
        }),
        user: createDataStore(post, {
            get: '/data/user/get',
            set: '/data/user/set',
            delete: '/data/user/delete',
        }),
    };
    return { data, kv: legacySite };
}
function createDataStore(post, paths) {
    async function get(key, getOptions = {}) {
        const envelope = await post(paths.get, { key, type: getOptions.type ?? 'json' });
        if (typeof envelope.found !== 'boolean') {
            throw new PagesSDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
        }
        if (envelope.found === false)
            return null;
        return envelope.value;
    }
    async function set(key, value, setOptions = {}) {
        const body = {
            key,
            value,
            type: setOptions.type ?? 'json',
        };
        if (setOptions.expirationTtl !== undefined)
            body.expirationTtl = setOptions.expirationTtl;
        await post(paths.set, body);
    }
    async function deleteKey(key) {
        await post(paths.delete, { key });
    }
    return { get, set, delete: deleteKey };
}
async function readEnvelope(response) {
    let envelope;
    try {
        envelope = await response.json();
    }
    catch {
        throw new PagesSDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status);
    }
    if (!isRecord(envelope) || typeof envelope.ok !== 'boolean') {
        throw new PagesSDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status);
    }
    if (!envelope.ok) {
        const error = isRecord(envelope.error) ? envelope.error : undefined;
        const code = typeof error?.code === 'string' ? error.code : ERROR_CODES.INVALID_RUNTIME_RESPONSE;
        const message = typeof error?.message === 'string' ? error.message : 'Runtime request failed';
        throw new PagesSDKError(code, message, response.status, error);
    }
    return envelope;
}
function buildRuntimePath(basePath, actionPath) {
    const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    return `${normalizedBase}${actionPath}`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
