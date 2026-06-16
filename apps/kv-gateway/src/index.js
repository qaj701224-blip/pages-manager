import {
  ERROR_CODES,
  GATEWAY,
  buildErrorEnvelope,
  buildOkEnvelope,
  buildStorageKey,
  validateKvType,
  validateTtl,
  validateUserKey,
} from '@xd/pages-runtime-protocol';
import { jsonResponse } from '@xd/worker-kit';
import { verifyCapability } from './auth.js';

const ROUTES = new Map([
  [GATEWAY.KV_GET_PATH, { scope: 'kv:get', handler: handleGet }],
  [GATEWAY.KV_SET_PATH, { scope: 'kv:set', handler: handleSet }],
  [GATEWAY.KV_DELETE_PATH, { scope: 'kv:delete', handler: handleDelete }],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = ROUTES.get(url.pathname);

    if (!route) return error(ERROR_CODES.FORBIDDEN, 'Not found', 404);
    if (request.method !== 'POST') return error(ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed', 405);

    let claims;
    try {
      claims = await verifyCapability(request.headers.get('Authorization'), env, { requiredScope: route.scope });
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

    return route.handler(body, claims, env);
  },
};

async function handleGet(body, claims, env) {
  const validation = validateBody(body);
  if (validation.response) return validation.response;

  const { key, type } = validation;
  const storageKey = buildStorageKey({ siteSlug: claims.siteId, siteUuid: claims.siteUuid, userKey: key });

  let value;
  try {
    value = await env.SITE_DATA.get(storageKey);
  } catch (err) {
    return mapProviderError(err);
  }

  if (value === null) return jsonResponse(buildOkEnvelope({ key, found: false, value: null }));
  if (type === 'text') return jsonResponse(buildOkEnvelope({ key, found: true, value }));

  try {
    return jsonResponse(buildOkEnvelope({ key, found: true, value: JSON.parse(value) }));
  } catch {
    return error(ERROR_CODES.KV_DECODE_FAILED, 'KV value could not be decoded', 500);
  }
}

async function handleSet(body, claims, env) {
  const validation = validateBody(body, { requireTtl: true });
  if (validation.response) return validation.response;

  const { key, type, expirationTtl } = validation;
  const valueValidation = validateSetValue(body, type);
  if (valueValidation.response) return valueValidation.response;

  const storageKey = buildStorageKey({ siteSlug: claims.siteId, siteUuid: claims.siteUuid, userKey: key });
  const value = valueValidation.value;
  const options = {
    metadata: {
      siteId: claims.siteId,
      type,
      updatedAt: new Date().toISOString(),
    },
  };

  if (expirationTtl !== undefined) options.expirationTtl = expirationTtl;

  try {
    await env.SITE_DATA.put(storageKey, value, options);
  } catch (err) {
    return mapProviderError(err);
  }

  return jsonResponse(buildOkEnvelope({ key }));
}

async function handleDelete(body, claims, env) {
  const validation = validateBody(body);
  if (validation.response) return validation.response;

  const { key } = validation;
  const storageKey = buildStorageKey({ siteSlug: claims.siteId, siteUuid: claims.siteUuid, userKey: key });

  try {
    await env.SITE_DATA.delete(storageKey);
  } catch (err) {
    return mapProviderError(err);
  }

  return jsonResponse(buildOkEnvelope({ key }));
}

function validateSetValue(body, type) {
  if (!Object.hasOwn(body, 'value')) {
    return { response: error(ERROR_CODES.INVALID_JSON, 'Missing KV value', 400) };
  }

  if (type === 'text') {
    if (body.value === null) return { response: error(ERROR_CODES.INVALID_JSON, 'Invalid text KV value', 400) };
    return { value: String(body.value) };
  }

  const value = JSON.stringify(body.value);
  if (value === undefined) return { response: error(ERROR_CODES.INVALID_JSON, 'Invalid JSON KV value', 400) };

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
    return error(ERROR_CODES.KV_VALUE_TOO_LARGE, 'KV value is too large', 413);
  }

  return error(ERROR_CODES.KV_FAILED, 'KV operation failed', 500);
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
