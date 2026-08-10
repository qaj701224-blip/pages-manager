import {
  ERROR_CODES,
  GATEWAY,
  buildErrorEnvelope,
  buildOkEnvelope,
  decodeUserKey,
  buildStorageKey,
  buildUserStorageKey,
  scopeForDataOperation,
  validateExpiration,
  validateKvType,
  validateListOptions,
  validateMetadata,
  validateTtl,
  validateUserKey,
} from '@xd/pages-runtime-protocol';
import { jsonResponse } from '@xd/worker-kit';
import { parseKeyRegistry, verifyCapability } from './auth.js';

const cursorEncoder = new globalThis.TextEncoder();
const cursorDecoder = new globalThis.TextDecoder();
const LIST_PROVIDER_PAGE_LIMIT = 1000;
const MAX_LIST_PROVIDER_PAGES_PER_REQUEST = 16;
const MAX_METADATA_BYTES = 1024;

const ROUTES = new Map([
  [GATEWAY.KV_GET_PATH, { scope: 'kv:get', dataScope: 'legacy-site', operation: 'get', handler: handleGet }],
  [
    GATEWAY.KV_GET_WITH_METADATA_PATH,
    { scope: 'kv:get', dataScope: 'legacy-site', operation: 'getWithMetadata', handler: handleGetWithMetadata },
  ],
  [GATEWAY.KV_LIST_PATH, { scope: 'kv:list', dataScope: 'legacy-site', operation: 'list', handler: handleList }],
  [GATEWAY.KV_SET_PATH, { scope: 'kv:set', dataScope: 'legacy-site', operation: 'set', handler: handleSet }],
  [GATEWAY.KV_DELETE_PATH, { scope: 'kv:delete', dataScope: 'legacy-site', operation: 'delete', handler: handleDelete }],
  [
    GATEWAY.DATA_SITE_GET_PATH,
    { scope: scopeForDataOperation('site', 'get'), dataScope: 'site', operation: 'get', handler: handleGet },
  ],
  [
    GATEWAY.DATA_SITE_GET_WITH_METADATA_PATH,
    {
      scope: scopeForDataOperation('site', 'get'),
      dataScope: 'site',
      operation: 'getWithMetadata',
      handler: handleGetWithMetadata,
    },
  ],
  [
    GATEWAY.DATA_SITE_LIST_PATH,
    { scope: scopeForDataOperation('site', 'list'), dataScope: 'site', operation: 'list', handler: handleList },
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

    if (route.dataScope === 'user' && claims.anonymous) {
      return error(ERROR_CODES.USER_REQUIRED, 'User is required for user data access', 401);
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
  const shape = validateAllowedProperties(body, ['key', 'type']);
  if (shape.response) return shape.response;
  const validation = validateBody(body);
  if (validation.response) return validation.response;

  const { key, type } = validation;
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

async function handleGetWithMetadata(body, claims, env, route) {
  const shape = validateAllowedProperties(body, ['key', 'type']);
  if (shape.response) return shape.response;
  const validation = validateBody(body);
  if (validation.response) return validation.response;

  const { key, type } = validation;
  if (route.dataScope === 'user' && claims.anonymous) {
    return jsonResponse(buildOkEnvelope({ key, found: false, value: null, metadata: null }));
  }

  const storageKey = resolveStorageKeyForClaims(claims, key, route.dataScope);
  if (storageKey.response) return storageKey.response;

  let result;
  try {
    if (typeof env.SITE_DATA.getWithMetadata === 'function') {
      result = await env.SITE_DATA.getWithMetadata(storageKey.value, { type: 'text' });
    } else {
      result = {
        value: await env.SITE_DATA.get(storageKey.value),
        metadata: null,
      };
    }
  } catch (err) {
    return mapProviderError(err);
  }

  if (result.value === null) {
    return jsonResponse(buildOkEnvelope({ key, found: false, value: null, metadata: null }));
  }
  if (type === 'text') {
    return jsonResponse(buildOkEnvelope({ key, found: true, value: result.value, metadata: publicMetadata(result.metadata) }));
  }

  try {
    return jsonResponse(
      buildOkEnvelope({ key, found: true, value: JSON.parse(result.value), metadata: publicMetadata(result.metadata) })
    );
  } catch {
    return error(ERROR_CODES.KV_DECODE_FAILED, 'Data value could not be decoded', 500);
  }
}

async function handleSet(body, claims, env, route) {
  const shape = validateAllowedProperties(body, ['key', 'value', 'type', 'expirationTtl', 'expiration', 'metadata']);
  if (shape.response) return shape.response;
  const validation = validateBody(body, { requireTtl: true });
  if (validation.response) return validation.response;

  const { key, type, expirationTtl, expiration, metadata } = validation;
  const valueValidation = validateSetValue(body, type);
  if (valueValidation.response) return valueValidation.response;

  const storageKey = resolveStorageKeyForClaims(claims, key, route.dataScope);
  if (storageKey.response) return storageKey.response;
  const value = valueValidation.value;
  const wrappedMetadata = {
    user: metadata ?? null,
    __xd_pages: {
      schemaVersion: 1,
      siteId: claims.siteId,
      type,
      updatedAt: new Date().toISOString(),
    },
  };

  if (route.dataScope === 'user') {
    wrappedMetadata.__xd_pages.userId = claims.sub;
  }
  if (!metadataFitsProviderLimit(wrappedMetadata)) {
    return error(ERROR_CODES.INVALID_METADATA, 'Invalid data metadata', 400);
  }

  const options = { metadata: wrappedMetadata };
  if (expirationTtl !== undefined) options.expirationTtl = expirationTtl;
  if (expiration !== undefined) options.expiration = expiration;

  try {
    await env.SITE_DATA.put(storageKey.value, value, options);
  } catch (err) {
    return mapProviderError(err);
  }

  return jsonResponse(buildOkEnvelope({ key }));
}

async function handleDelete(body, claims, env, route) {
  const shape = validateAllowedProperties(body, ['key', 'type']);
  if (shape.response) return shape.response;
  const validation = validateBody(body);
  if (validation.response) return validation.response;

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

async function handleList(body, claims, env, route) {
  const shape = validateAllowedProperties(body, ['prefix', 'limit', 'cursor']);
  if (shape.response) return shape.response;
  const validation = validateListOptions(body);
  if (!validation.ok) return error(validation.error.code, validation.error.message, 400);

  const rootPrefix = storageRootPrefixForClaims(claims, route.dataScope);
  const userPrefix = validation.value.prefix || '';
  const cursorContext = listCursorContext({
    claims,
    dataScope: route.dataScope,
    prefix: userPrefix,
    limit: validation.value.limit,
  });
  const initialProviderCursor = await decodeListCursor(validation.value.cursor, cursorContext, env);
  if (initialProviderCursor.response) return initialProviderCursor.response;

  const requestedLimit = validation.value.limit ?? LIST_PROVIDER_PAGE_LIMIT;
  const keys = [];
  let providerCursor = initialProviderCursor.value;
  let listComplete = true;
  let responseCursor;
  let providerPagesScanned = 0;

  try {
    while (keys.length < requestedLimit && providerPagesScanned < MAX_LIST_PROVIDER_PAGES_PER_REQUEST) {
      const providerLimit = Math.min(LIST_PROVIDER_PAGE_LIMIT, requestedLimit - keys.length);
      const result = await env.SITE_DATA.list({
        prefix: rootPrefix,
        limit: providerLimit,
        cursor: providerCursor,
      });
      providerPagesScanned += 1;

      for (const item of Array.isArray(result?.keys) ? result.keys : []) {
        const decoded = decodeStorageListItem(item, rootPrefix);
        if (!decoded || !decoded.name.startsWith(userPrefix)) continue;
        keys.push(decoded);
        if (keys.length >= requestedLimit) break;
      }

      if (result?.list_complete !== false || typeof result?.cursor !== 'string' || result.cursor === '') {
        listComplete = true;
        responseCursor = undefined;
        break;
      }

      providerCursor = result.cursor;
      listComplete = false;
      responseCursor = result.cursor;
    }
  } catch (err) {
    return mapProviderError(err);
  }

  const payload = {
    keys,
    list_complete: listComplete,
  };
  if (responseCursor) {
    payload.cursor = await encodeListCursor(responseCursor, cursorContext, env);
  }
  return jsonResponse(buildOkEnvelope(payload));
}

function listCursorContext({ claims, dataScope, prefix, limit }) {
  return {
    env: claims.env,
    siteId: claims.siteId,
    siteUuid: claims.siteUuid,
    dataScope,
    sub: dataScope === 'user' ? claims.sub : null,
    prefix,
    limit: limit ?? null,
  };
}

async function encodeListCursor(providerCursor, context, env) {
  const registry = parseKeyRegistry(env);
  const firstKey = registry.entries().next().value;
  if (!firstKey) throw new Error('Capability key registry is empty');

  const [kid, key] = firstKey;
  const payload = cursorEncoder.encode(
    JSON.stringify({
      v: 1,
      c: providerCursor,
      ...context,
    })
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await encryptListCursor(key.secret, nonce, payload);

  return [
    'v1',
    base64UrlEncodeBytes(cursorEncoder.encode(kid)),
    base64UrlEncodeBytes(nonce),
    base64UrlEncodeBytes(ciphertext),
  ].join('.');
}

async function decodeListCursor(cursor, context, env) {
  if (cursor === undefined) return { value: undefined };

  try {
    const parts = cursor.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return invalidListCursor();

    const [, encodedKid, encodedNonce, encodedCiphertext] = parts;
    const kid = cursorDecoder.decode(base64UrlDecodeBytes(encodedKid));
    const key = parseKeyRegistry(env).get(kid);
    if (!key) return invalidListCursor();

    const plaintext = await decryptListCursor(
      key.secret,
      base64UrlDecodeBytes(encodedNonce),
      base64UrlDecodeBytes(encodedCiphertext)
    );
    const payload = JSON.parse(cursorDecoder.decode(plaintext));
    if (!isValidListCursorPayload(payload, context)) return invalidListCursor();

    return { value: payload.c };
  } catch {
    return invalidListCursor();
  }
}

async function encryptListCursor(secret, nonce, payload) {
  const key = await importListCursorAesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: cursorEncoder.encode('xd-pages-kv-list-cursor') },
    key,
    payload
  );
  return new Uint8Array(ciphertext);
}

async function decryptListCursor(secret, nonce, ciphertext) {
  const key = await importListCursorAesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: cursorEncoder.encode('xd-pages-kv-list-cursor') },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

async function importListCursorAesKey(secret) {
  const material = await crypto.subtle.digest(
    'SHA-256',
    cursorEncoder.encode(`xd-pages-kv-list-cursor-key.${secret}`)
  );
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function isValidListCursorPayload(payload, context) {
  return (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    payload.v === 1 &&
    typeof payload.c === 'string' &&
    payload.c !== '' &&
    payload.env === context.env &&
    payload.siteId === context.siteId &&
    payload.siteUuid === context.siteUuid &&
    payload.dataScope === context.dataScope &&
    payload.sub === context.sub &&
    payload.prefix === context.prefix &&
    payload.limit === context.limit
  );
}

function invalidListCursor() {
  return { response: error(ERROR_CODES.INVALID_CURSOR, 'Invalid data list cursor', 400) };
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeBytes(value) {
  if (typeof value !== 'string' || /[^A-Za-z0-9_-]/.test(value)) {
    throw new Error('Invalid base64url');
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
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

function storageRootPrefixForClaims(claims, dataScope) {
  if (dataScope === 'user') {
    return `s/${claims.siteId}--${claims.siteUuid}/u/${claims.sub}/k/`;
  }
  return `s/${claims.siteId}--${claims.siteUuid}/k/`;
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
  const expiration = validateExpiration(body.expiration);
  if (!expiration.ok) return { response: error(expiration.error.code, expiration.error.message, 400) };
  if (ttl.value !== undefined && expiration.value !== undefined) {
    return { response: error(ERROR_CODES.UNSUPPORTED_KV_OPTION, 'Use either expiration or expirationTtl', 400) };
  }
  const metadata = validateMetadata(body.metadata);
  if (!metadata.ok) return { response: error(metadata.error.code, metadata.error.message, 400) };

  return {
    key: key.value,
    type: type.value,
    expirationTtl: ttl.value,
    expiration: expiration.value,
    metadata: metadata.value,
  };
}

function validateAllowedProperties(body, allowed) {
  const allowedSet = new Set(allowed);
  const ignoredSet = new Set(['siteId', 'siteUuid', 'userId', 'scope']);
  for (const key of Object.keys(body)) {
    if (ignoredSet.has(key)) continue;
    if (!allowedSet.has(key)) {
      return { response: error(ERROR_CODES.UNSUPPORTED_KV_OPTION, 'Unsupported data option', 400) };
    }
  }
  return {};
}

function metadataFitsProviderLimit(metadata) {
  try {
    return cursorEncoder.encode(JSON.stringify(metadata)).byteLength <= MAX_METADATA_BYTES;
  } catch {
    return false;
  }
}

function publicMetadata(metadata) {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && Object.hasOwn(metadata, 'user')) {
    return metadata.user ?? null;
  }
  return null;
}

function decodeStorageListItem(item, rootPrefix) {
  if (!item || typeof item.name !== 'string' || !item.name.startsWith(rootPrefix)) return null;
  try {
    const decoded = {
      name: decodeUserKey(item.name.slice(rootPrefix.length)),
    };
    const metadata = publicMetadata(item.metadata);
    if (metadata !== null) decoded.metadata = metadata;
    if (typeof item.expiration === 'number') decoded.expiration = item.expiration;
    return decoded;
  } catch {
    return null;
  }
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
