import {
  ERROR_CODES,
  GATEWAY,
  buildErrorEnvelope,
  buildOkEnvelope,
  buildStorageKey,
  buildUserStorageKey,
  scopeForDataOperation,
  validateKvType,
  validateTtl,
  validateUserKey,
} from '@xd/pages-runtime-protocol';
import { jsonResponse } from '@xd/worker-kit';
import { verifyCapability } from './auth.js';

const ROUTES = new Map([
  [GATEWAY.KV_GET_PATH, { scope: 'kv:get', dataScope: 'legacy-site', operation: 'get', handler: handleGet }],
  [GATEWAY.KV_SET_PATH, { scope: 'kv:set', dataScope: 'legacy-site', operation: 'set', handler: handleSet }],
  [GATEWAY.KV_DELETE_PATH, { scope: 'kv:delete', dataScope: 'legacy-site', operation: 'delete', handler: handleDelete }],
  [
    GATEWAY.DATA_SITE_GET_PATH,
    { scope: scopeForDataOperation('site', 'get'), dataScope: 'site', operation: 'get', handler: handleGet },
  ],
  [
    GATEWAY.DATA_SITE_SET_PATH,
    { scope: scopeForDataOperation('site', 'set'), dataScope: 'site', operation: 'set', handler: handleSet },
  ],
  [
    GATEWAY.DATA_SITE_DELETE_PATH,
    { scope: scopeForDataOperation('site', 'delete'), dataScope: 'site', operation: 'delete', handler: handleDelete },
  ],
  [
    GATEWAY.DATA_USER_GET_PATH,
    { scope: scopeForDataOperation('user', 'get'), dataScope: 'user', operation: 'get', handler: handleGet },
  ],
  [
    GATEWAY.DATA_USER_SET_PATH,
    { scope: scopeForDataOperation('user', 'set'), dataScope: 'user', operation: 'set', handler: handleSet },
  ],
  [
    GATEWAY.DATA_USER_DELETE_PATH,
    { scope: scopeForDataOperation('user', 'delete'), dataScope: 'user', operation: 'delete', handler: handleDelete },
  ],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = ROUTES.get(url.pathname);

    if (!route) return error(ERROR_CODES.FORBIDDEN, 'Not found', 404);
    if (request.method !== 'POST') return error(ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed', 405);

    let claims;
    try {
      claims = await verifyCapability(request.headers.get('Authorization'), env, {
        requiredScope: route.scope,
        requiredDataScope: route.dataScope,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Capability invalid';
      if (/scope/i.test(message)) {
        return error(ERROR_CODES.CAPABILITY_SCOPE_DENIED, 'Capability scope denied', 403);
      }

      return error(ERROR_CODES.CAPABILITY_INVALID, 'Capability invalid', 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return error(ERROR_CODES.INVALID_JSON, 'Invalid JSON body', 400);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return error(ERROR_CODES.INVALID_JSON, 'Invalid JSON body', 400);
    }

    const response = await route.handler(body, claims, env, route);
    return route.dataScope === 'legacy-site' ? withLegacyDeprecationHeaders(response) : response;
  },
};

async function handleGet(body, claims, env, route) {
  const validation = validateBody(body);
  if (validation.response) return validation.response;

  const { key, type } = validation;
  if (route.dataScope === 'user' && claims.anonymous) {
    return jsonResponse(buildOkEnvelope({ key, found: false, value: null }));
  }

  const storageKey = resolveStorageKeyForClaims(claims, key, route.dataScope);
  if (storageKey.response) return storageKey.response;

  let value;
  try {
    value = await env.SITE_DATA.get(storageKey.value);
  } catch (err) {
    return mapProviderError(err);
  }

  if (value === null) return jsonResponse(buildOkEnvelope({ key, found: false, value: null }));
  if (type === 'text') return jsonResponse(buildOkEnvelope({ key, found: true, value }));

  try {
    return jsonResponse(buildOkEnvelope({ key, found: true, value: JSON.parse(value) }));
  } catch {
    return error(ERROR_CODES.KV_DECODE_FAILED, 'Data value could not be decoded', 500);
  }
}

async function handleSet(body, claims, env, route) {
  const validation = validateBody(body, { requireTtl: true });
  if (validation.response) return validation.response;

  if (route.dataScope === 'user' && claims.anonymous) {
    return error(ERROR_CODES.USER_REQUIRED, 'User is required for user data writes', 401);
  }

  const { key, type, expirationTtl } = validation;
  const valueValidation = validateSetValue(body, type);
  if (valueValidation.response) return valueValidation.response;

  const storageKey = resolveStorageKeyForClaims(claims, key, route.dataScope);
  if (storageKey.response) return storageKey.response;
  const value = valueValidation.value;
  const options = {
    metadata: {
      siteId: claims.siteId,
      type,
      updatedAt: new Date().toISOString(),
    },
  };

  if (route.dataScope === 'user') {
    options.metadata.userId = claims.sub;
  }

  if (expirationTtl !== undefined) options.expirationTtl = expirationTtl;

  try {
    await env.SITE_DATA.put(storageKey.value, value, options);
  } catch (err) {
    return mapProviderError(err);
  }

  return jsonResponse(buildOkEnvelope({ key }));
}

async function handleDelete(body, claims, env, route) {
  const validation = validateBody(body);
  if (validation.response) return validation.response;

  if (route.dataScope === 'user' && claims.anonymous) {
    return error(ERROR_CODES.USER_REQUIRED, 'User is required for user data writes', 401);
  }

  const { key } = validation;
  const storageKey = resolveStorageKeyForClaims(claims, key, route.dataScope);
  if (storageKey.response) return storageKey.response;

  try {
    await env.SITE_DATA.delete(storageKey.value);
  } catch (err) {
    return mapProviderError(err);
  }

  return jsonResponse(buildOkEnvelope({ key }));
}

function storageKeyForClaims(claims, key, dataScope) {
  if (dataScope === 'user') {
    return buildUserStorageKey({
      siteSlug: claims.siteId,
      siteUuid: claims.siteUuid,
      userId: claims.sub,
      userKey: key,
    });
  }

  return buildStorageKey({ siteSlug: claims.siteId, siteUuid: claims.siteUuid, userKey: key });
}

function resolveStorageKeyForClaims(claims, key, dataScope) {
  try {
    return { value: storageKeyForClaims(claims, key, dataScope) };
  } catch (err) {
    if (isInvalidStorageKeyError(err)) {
      return { response: error(ERROR_CODES.INVALID_KEY, 'Invalid data key', 400) };
    }
    throw err;
  }
}

function isInvalidStorageKeyError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message === 'Invalid data key' ||
    message === 'Storage key exceeds Cloudflare KV key limit'
  );
}

function validateSetValue(body, type) {
  if (!Object.hasOwn(body, 'value')) {
    return { response: error(ERROR_CODES.INVALID_JSON, 'Missing data value', 400) };
  }

  if (type === 'text') {
    if (body.value === null) return { response: error(ERROR_CODES.INVALID_JSON, 'Invalid text data value', 400) };
    return { value: String(body.value) };
  }

  const value = JSON.stringify(body.value);
  if (value === undefined) return { response: error(ERROR_CODES.INVALID_JSON, 'Invalid JSON data value', 400) };

  return { value };
}

function validateBody(body, { requireTtl = false } = {}) {
  const key = validateUserKey(body.key);
  if (!key.ok) return { response: error(key.error.code, key.error.message, 400) };

  const type = validateKvType(body.type);
  if (!type.ok) return { response: error(type.error.code, type.error.message, 400) };

  if (!requireTtl) return { key: key.value, type: type.value };

  const ttl = validateTtl(body.expirationTtl);
  if (!ttl.ok) return { response: error(ttl.error.code, ttl.error.message, 400) };

  return { key: key.value, type: type.value, expirationTtl: ttl.value };
}

function mapProviderError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (isValueTooLargeError(message)) {
    return error(ERROR_CODES.KV_VALUE_TOO_LARGE, 'Data value is too large', 413);
  }

  return error(ERROR_CODES.KV_FAILED, 'Data operation failed', 500);
}

function isValueTooLargeError(message) {
  return (
    /\b(value|body|payload)\b.*\b(too large|exceeds?|size|length|limit|max(?:imum)?)\b/i.test(message) ||
    /\b(too large|exceeds?|size|length|limit|max(?:imum)?)\b.*\b(value|body|payload)\b/i.test(message)
  );
}

function error(code, message, status) {
  return jsonResponse(buildErrorEnvelope(code, message), status);
}

function withLegacyDeprecationHeaders(response) {
  response.headers.set('Deprecation', 'true');
  response.headers.set('X-XD-Pages-Deprecated', 'kv-runtime');
  return response;
}
