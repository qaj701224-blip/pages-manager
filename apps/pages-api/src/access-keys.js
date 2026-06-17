import { authenticateApiRequest } from './auth.js';
import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newId } from './id.js';

const ALLOWED_SCOPES = new Set(['deploy:site', 'read:site', 'rollback:site']);

export async function handleAccessKeysApi(request, env, config, store) {
  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return authErrorResponse(auth.error);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/api/access-keys') {
    if (request.method === 'GET') return listAccessKeys(store, auth.actor, config.environment);
    if (request.method === 'POST') return createAccessKey(request, env, config, store, auth.actor);
    return methodNotAllowed();
  }

  const accessKeyId = matchAccessKeyId(url.pathname);
  if (accessKeyId && request.method === 'DELETE') return revokeAccessKey(env, config, store, auth.actor, accessKeyId);
  if (accessKeyId) return methodNotAllowed();

  return null;
}

async function listAccessKeys(store, actor, environment) {
  if (actor.type !== 'user') return accessKeyManagementForbidden();

  const keys = await store.listAccessKeysForOwner(actor.userId, environment);
  return jsonOk({ accessKeys: keys.map(formatAccessKey) });
}

async function createAccessKey(request, env, config, store, actor) {
  if (actor.type !== 'user') {
    return jsonError('ACCESS_KEY_CREATE_FORBIDDEN', 'Access keys cannot create access keys.', 403, 'Use a user CLI token.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const name = normalizeName(body.name);
  const siteId = typeof body.siteId === 'string' ? body.siteId : '';
  const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ['deploy:site'];
  const expiresAt = typeof body.expiresAt === 'string' && body.expiresAt ? body.expiresAt : null;

  if (!name) return jsonError('ACCESS_KEY_NAME_INVALID', 'Access key name is invalid.', 400, 'Use a non-empty name.');
  if (!validateScopes(scopes)) {
    return jsonError('ACCESS_KEY_SCOPE_INVALID', 'Access key scope is invalid.', 400, 'Use supported Pages access key scopes.');
  }
  if (!siteId) {
    return jsonError('ACCESS_KEY_SITE_REQUIRED', 'Site-scoped access key requires siteId.', 400, 'Pass a siteId.');
  }
  if (expiresAt && expiresAt <= readNow(env)) {
    return jsonError('ACCESS_KEY_EXPIRY_INVALID', 'Access key expiry is invalid.', 400, 'Use a future expiry time.');
  }

  const site = await store.getSiteForUser(siteId, actor.userId, actor, config.environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

  const pepper = readActiveAccessKeyPepper(env);
  const keyId = nextId(env, 'ak');
  const plaintext = createAccessKeyPlaintext({
    environment: config.environment,
    keyId,
    bytes: randomBytes(env, 24),
  });
  const keyHash = await hashAccessKey(plaintext, pepper.secret);
  const accessKey = await store.createAccessKey({
    id: keyId,
    ownerUserId: actor.userId,
    keyHash,
    pepperId: pepper.id,
    name,
    scopes,
    siteId,
    expiresAt,
  });

  return jsonOk({ accessKey: { ...formatAccessKey(accessKey), plaintext } }, 201);
}

async function revokeAccessKey(env, config, store, actor, accessKeyId) {
  if (actor.type !== 'user') return accessKeyManagementForbidden();

  const existing = await store.getAccessKeyById(accessKeyId, config.environment);
  if (!existing || existing.ownerUserId !== actor.userId) {
    return jsonError('ACCESS_KEY_NOT_FOUND', 'Access key not found.', 404, 'Check the access key id.');
  }

  const revoked = await store.revokeAccessKey(accessKeyId, readNow(env));
  return jsonOk({ accessKey: formatAccessKey(revoked) });
}

function formatAccessKey(accessKey) {
  return {
    id: accessKey.id,
    ownerUserId: accessKey.ownerUserId,
    name: accessKey.name,
    scopes: [...accessKey.scopes],
    siteId: accessKey.siteId,
    expiresAt: accessKey.expiresAt,
    lastUsedAt: accessKey.lastUsedAt,
    revokedAt: accessKey.revokedAt,
    createdAt: accessKey.createdAt,
  };
}

function readActiveAccessKeyPepper(env) {
  const activePepperId = String(env?.ACCESS_KEY_ACTIVE_PEPPER_ID || '').trim();
  if (!activePepperId) throw new Error('ACCESS_KEY_ACTIVE_PEPPER_ID is required');

  const registry = String(env?.ACCESS_KEY_PEPPERS || '').trim();
  for (const entry of registry.split(',')) {
    const [pepperId, secretEnvName] = entry.split(':').map((part) => part.trim());
    if (pepperId === activePepperId) {
      const secret = env[secretEnvName];
      if (typeof secret !== 'string' || secret === '') throw new Error('Access key pepper secret is invalid');
      return { id: pepperId, secret };
    }
  }
  throw new Error('Active access key pepper is not present in registry');
}

function validateScopes(scopes) {
  return scopes.every((scope) => typeof scope === 'string' && ALLOWED_SCOPES.has(scope));
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function matchAccessKeyId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/access-keys\/([^/]+)$/);
  return match ? match[1] : null;
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  return newId(prefix);
}

function randomBytes(env, length) {
  if (typeof env?.randomBytes === 'function') return env.randomBytes(length);
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function authErrorResponse(error) {
  return jsonError(error.code, error.message, error.status, error.action);
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}

function accessKeyManagementForbidden() {
  return jsonError('ACCESS_KEY_MANAGEMENT_FORBIDDEN', 'Access keys cannot manage access keys.', 403, 'Use a user CLI token.');
}
