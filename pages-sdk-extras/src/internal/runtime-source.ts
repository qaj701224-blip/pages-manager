export const PAGES_RUNTIME_SOURCE = String.raw`
const RUNTIME = {
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

const GATEWAY = {
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

const HEADERS = {
  RUNTIME_REQUEST: 'X-XD-Pages-Runtime',
};

const ERROR_CODES = {
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_TTL: 'INVALID_TTL',
  FORBIDDEN: 'FORBIDDEN',
  KV_FAILED: 'KV_FAILED',
  INVALID_RUNTIME_RESPONSE: 'INVALID_RUNTIME_RESPONSE',
};

const MAX_USER_KEY_BYTES = 256;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 31536000;
const GATEWAY_ORIGIN = 'https://pages-kv-gateway.local';
const KV_CAPABILITY_HEADER = 'CF-Platform-KV-Capability';
const DATA_SITE_CAPABILITY_HEADER = 'CF-Platform-Data-Site-Capability';
const DATA_USER_CAPABILITY_HEADER = 'CF-Platform-Data-User-Capability';

export async function handlePagesRuntimeRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const action = getRuntimeAction(url.pathname);
  if (!action) return null;

  if (request.method !== 'POST') {
    return errorResponse(ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed', 405);
  }

  if (!hasJsonContentType(request)) {
    return errorResponse(ERROR_CODES.INVALID_CONTENT_TYPE, 'Content-Type must be application/json', 415);
  }

  if (request.headers.get(HEADERS.RUNTIME_REQUEST) !== '1') {
    return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
  }

  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
  }

  const origin = request.headers.get('Origin');
  if (origin && originFromHeader(origin) !== url.origin) {
    return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
  }

  if (!options.checkAccess) {
    return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
  }

  const accessResponse = await options.checkAccess(request, env);
  if (accessResponse) return accessResponse;

  const body = await parseBody(request);
  if (!body.ok) return errorResponse(body.code, body.message, 400);

  const key = validateUserKey(body.value.key);
  if (!key.ok) return errorResponse(key.error.code, key.error.message, 400);

  try {
    if (action.operation === 'delete') {
      const gatewayResponse = await callGateway(request, env, action, { key: key.value });
      return envelopeResponse(gatewayResponse, action.operation);
    }

    const type = validateKvType(body.value.type);
    if (!type.ok) return errorResponse(type.error.code, type.error.message, 400);

    if (action.operation === 'set') {
      const ttl = validateTtl(body.value.expirationTtl);
      if (!ttl.ok) return errorResponse(ttl.error.code, ttl.error.message, 400);
      const payload = { key: key.value, value: body.value.value, type: type.value };
      if (ttl.value !== undefined) payload.expirationTtl = ttl.value;
      const gatewayResponse = await callGateway(request, env, action, payload);
      return envelopeResponse(gatewayResponse, action.operation);
    }

    const gatewayResponse = await callGateway(request, env, action, { key: key.value, type: type.value });
    return envelopeResponse(gatewayResponse, action.operation);
  } catch {
    return errorResponse(ERROR_CODES.KV_FAILED, 'Data request failed', 500);
  }
}

function getRuntimeAction(pathname) {
  if (pathname === RUNTIME.KV_GET_PATH) return { operation: 'get', path: GATEWAY.KV_GET_PATH, capability: 'legacy' };
  if (pathname === RUNTIME.KV_SET_PATH) return { operation: 'set', path: GATEWAY.KV_SET_PATH, capability: 'legacy' };
  if (pathname === RUNTIME.KV_DELETE_PATH) return { operation: 'delete', path: GATEWAY.KV_DELETE_PATH, capability: 'legacy' };
  if (pathname === RUNTIME.DATA_SITE_GET_PATH) {
    return { operation: 'get', path: GATEWAY.DATA_SITE_GET_PATH, legacyPath: GATEWAY.KV_GET_PATH, capability: 'site' };
  }
  if (pathname === RUNTIME.DATA_SITE_SET_PATH) {
    return { operation: 'set', path: GATEWAY.DATA_SITE_SET_PATH, legacyPath: GATEWAY.KV_SET_PATH, capability: 'site' };
  }
  if (pathname === RUNTIME.DATA_SITE_DELETE_PATH) {
    return {
      operation: 'delete',
      path: GATEWAY.DATA_SITE_DELETE_PATH,
      legacyPath: GATEWAY.KV_DELETE_PATH,
      capability: 'site',
    };
  }
  if (pathname === RUNTIME.DATA_USER_GET_PATH) return { operation: 'get', path: GATEWAY.DATA_USER_GET_PATH, capability: 'user' };
  if (pathname === RUNTIME.DATA_USER_SET_PATH) return { operation: 'set', path: GATEWAY.DATA_USER_SET_PATH, capability: 'user' };
  if (pathname === RUNTIME.DATA_USER_DELETE_PATH) return { operation: 'delete', path: GATEWAY.DATA_USER_DELETE_PATH, capability: 'user' };
  return null;
}

function hasJsonContentType(request) {
  return request.headers.get('Content-Type')?.toLowerCase().includes('application/json') ?? false;
}

function originFromHeader(origin) {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

async function parseBody(request) {
  try {
    const body = await request.json();
    if (isRecord(body)) return { ok: true, value: body };
  } catch {
    return { ok: false, code: ERROR_CODES.INVALID_JSON, message: 'Invalid JSON body' };
  }
  return { ok: false, code: ERROR_CODES.INVALID_JSON, message: 'Invalid JSON body' };
}

function validateUserKey(key) {
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
    return { ok: false, error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid data key' } };
  }
  return { ok: true, value: key };
}

function validateKvType(type = 'json') {
  if (type === 'json' || type === 'text') return { ok: true, value: type };
  return { ok: false, error: { code: ERROR_CODES.INVALID_TYPE, message: 'Invalid data value type' } };
}

function validateTtl(expirationTtl) {
  if (expirationTtl === undefined || expirationTtl === null) return { ok: true, value: undefined };
  if (
    Number.isInteger(expirationTtl) &&
    expirationTtl >= MIN_TTL_SECONDS &&
    expirationTtl <= MAX_TTL_SECONDS
  ) {
    return { ok: true, value: expirationTtl };
  }
  return { ok: false, error: { code: ERROR_CODES.INVALID_TTL, message: 'Invalid data expiration TTL' } };
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

async function callGateway(request, env, action, body) {
  const endpoint = readEndpoint(request, env, action);
  return env.XD_PAGES_KV_GATEWAY.fetch(
    new Request(GATEWAY_ORIGIN + endpoint.path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + endpoint.capability,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  );
}

function readEndpoint(request, env, action) {
  if (action.capability === 'user') {
    return { capability: request.headers.get(DATA_USER_CAPABILITY_HEADER) || '', path: action.path };
  }
  if (action.capability === 'site') {
    const requestSiteCapability = request.headers.get(DATA_SITE_CAPABILITY_HEADER);
    if (requestSiteCapability) return { capability: requestSiteCapability, path: action.path };
    if (env.XD_PAGES_DATA_SITE_CAPABILITY) {
      return { capability: env.XD_PAGES_DATA_SITE_CAPABILITY, path: action.path };
    }
    const legacyCapability = env.XD_PAGES_KV_CAPABILITY || request.headers.get(KV_CAPABILITY_HEADER) || '';
    return { capability: legacyCapability, path: action.legacyPath || action.path };
  }
  return {
    capability: env.XD_PAGES_KV_CAPABILITY || request.headers.get(KV_CAPABILITY_HEADER) || '',
    path: action.path,
  };
}

async function envelopeResponse(response, action) {
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    return errorResponse(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status || 502);
  }

  if (!isRecord(envelope) || typeof envelope.ok !== 'boolean') {
    return errorResponse(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status || 502);
  }

  if (!envelope.ok) {
    return gatewayEnvelopeResponse(envelope, response, response.status || 500);
  }

  if (action === 'get' && typeof envelope.found !== 'boolean') {
    return errorResponse(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status || 502);
  }

  return gatewayEnvelopeResponse(envelope, response, response.status || 200);
}

function errorResponse(code, message, status) {
  return jsonResponse({ ok: false, error: { code, message } }, status);
}

function gatewayEnvelopeResponse(body, gatewayResponse, status) {
  const response = jsonResponse(body, status);
  const deprecation = gatewayResponse.headers.get('Deprecation');
  if (deprecation) response.headers.set('Deprecation', deprecation);
  return response;
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
`;
