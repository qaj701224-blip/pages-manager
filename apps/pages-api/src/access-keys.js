import { authenticateApiRequest } from './auth.js';
import { isConsoleBffRequest, requireConsoleUserSession } from './console-auth.js';
import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newId } from './id.js';

const ALLOWED_SCOPES = new Set(['deploy:site', 'read:site', 'rollback:site']);
const DEFAULT_EXPIRY_MONTHS = 3;
const MAX_EXPIRY_YEARS = 1;

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

export async function handleConsoleAccessKeysApi(request, env, config, store) {
  if (!isConsoleBffRequest(request)) return null;

  const url = new URL(request.url);
  if (!isConsoleAccessKeyPath(url.pathname)) return null;

  const session = await requireConsoleUserSession(request, env, config, store);
  if (session instanceof Response) return session;

  if (url.pathname === '/.xd-pages/api/console/access-keys') {
    if (request.method === 'GET') return listConsoleAccessKeys(store, config, { ownerType: 'user', ownerId: session.userId });
    if (request.method === 'POST') {
      return createAccessKeyForOwner(request, env, config, store, {
        ownerType: 'user',
        ownerId: session.userId,
        ownerUserId: session.userId,
        createdByUserId: session.userId,
        requireSiteId: false,
      });
    }
    return methodNotAllowed();
  }

  const teamAccessKeysMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/teams\/([^/]+)\/access-keys(?:\/([^/]+))?$/);
  if (teamAccessKeysMatch) {
    const [, teamId, accessKeyId] = teamAccessKeysMatch;
    const access = await requireTeamAdmin(store, config, session, teamId);
    if (access instanceof Response) return access;

    if (!accessKeyId && request.method === 'GET') {
      return listConsoleAccessKeys(store, config, { ownerType: 'team', ownerId: teamId });
    }
    if (!accessKeyId && request.method === 'POST') {
      return createAccessKeyForOwner(request, env, config, store, {
        ownerType: 'team',
        ownerId: teamId,
        ownerUserId: session.userId,
        createdByUserId: session.userId,
        requireSiteId: false,
      });
    }
    if (accessKeyId && request.method === 'DELETE') {
      return revokeOwnedAccessKey(env, config, store, {
        accessKeyId,
        ownerType: 'team',
        ownerId: teamId,
        revokedByUserId: session.userId,
      });
    }
    return methodNotAllowed();
  }

  const userAccessKeyMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/access-keys\/([^/]+)$/);
  if (userAccessKeyMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return revokeOwnedAccessKey(env, config, store, {
      accessKeyId: userAccessKeyMatch[1],
      ownerType: 'user',
      ownerId: session.userId,
      revokedByUserId: session.userId,
    });
  }

  return null;
}

function isConsoleAccessKeyPath(pathname) {
  if (pathname === '/.xd-pages/api/console/access-keys') return true;
  if (/^\/\.xd-pages\/api\/console\/access-keys\/[^/]+$/.test(pathname)) return true;
  return /^\/\.xd-pages\/api\/console\/teams\/[^/]+\/access-keys(?:\/[^/]+)?$/.test(pathname);
}

async function listAccessKeys(store, actor, environment) {
  if (actor.type !== 'user') return accessKeyManagementForbidden();

  const keys = await store.listAccessKeysForOwner(actor.userId, environment);
  return jsonOk({ accessKeys: keys.filter(isActiveAccessKey).map(formatAccessKey) });
}

async function listConsoleAccessKeys(store, config, owner) {
  const keys =
    typeof store.listAccessKeys === 'function'
      ? await store.listAccessKeys({ environment: config.environment, ...owner })
      : await store.listAccessKeysForOwner(owner.ownerId, config.environment);
  return jsonOk({ accessKeys: keys.filter(isActiveAccessKey).map(formatAccessKey) });
}

async function createAccessKey(request, env, config, store, actor) {
  if (actor.type !== 'user') {
    return jsonError('ACCESS_KEY_CREATE_FORBIDDEN', 'Access keys cannot create access keys.', 403, 'Use a user CLI token.');
  }

  return createAccessKeyForOwner(request, env, config, store, {
    ownerType: 'user',
    ownerId: actor.userId,
    ownerUserId: actor.userId,
    createdByUserId: actor.userId,
    requireSiteId: true,
    actor,
  });
}

async function createAccessKeyForOwner(request, env, config, store, owner) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const name = normalizeName(body.name);
  const siteId = typeof body.siteId === 'string' ? body.siteId : '';
  const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ['deploy:site'];
  const expiresAt = normalizeExpiresAt(body.expiresAt, readNow(env));

  if (!name) return jsonError('ACCESS_KEY_NAME_INVALID', 'Access key name is invalid.', 400, 'Use a non-empty name.');
  if (!validateScopes(scopes)) {
    return jsonError('ACCESS_KEY_SCOPE_INVALID', 'Access key scope is invalid.', 400, 'Use supported Pages access key scopes.');
  }
  if (owner.requireSiteId && !siteId) {
    return jsonError('ACCESS_KEY_SITE_REQUIRED', 'Site-scoped access key requires siteId.', 400, 'Pass a siteId.');
  }
  if (expiresAt instanceof Response) return expiresAt;

  if (siteId) {
    const site = await store.getSiteForUser(
      siteId,
      owner.ownerType === 'user' ? owner.ownerId : owner.createdByUserId,
      owner.actor || { type: 'user', userId: owner.ownerType === 'user' ? owner.ownerId : owner.createdByUserId },
      config.environment
    );
    if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
    if (owner.ownerType === 'team' && (site.ownerType !== 'team' || site.ownerId !== owner.ownerId)) {
      return jsonError(
        'ACCESS_KEY_SITE_FORBIDDEN',
        'Access key owner cannot manage this site.',
        403,
        'Use a site owned by this team.'
      );
    }
    if (owner.requireSiteId && scopes.some((scope) => scope !== 'read:site') && site.ownerUserId !== owner.ownerUserId) {
      return jsonError(
        'ACCESS_KEY_SITE_FORBIDDEN',
        'Only the site owner can create deploy-capable access keys.',
        403,
        'Use the owner account or create a read-only access key.'
      );
    }
  }

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
    environment: config.environment,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    ownerUserId: owner.ownerUserId,
    createdByUserId: owner.createdByUserId,
    keyHash,
    pepperId: pepper.id,
    name,
    scopes,
    siteId: siteId || null,
    expiresAt,
  });

  return jsonOk({ accessKey: { ...formatAccessKey(accessKey), plaintext } }, 201);
}

async function revokeAccessKey(env, config, store, actor, accessKeyId) {
  if (actor.type !== 'user') return accessKeyManagementForbidden();

  const existing = await store.getAccessKeyById(accessKeyId, config.environment);
  if (!existing || (existing.ownerType || 'user') !== 'user' || (existing.ownerId || existing.ownerUserId) !== actor.userId) {
    return jsonError('ACCESS_KEY_NOT_FOUND', 'Access key not found.', 404, 'Check the access key id.');
  }

  const revoked = await store.revokeAccessKey(accessKeyId, readNow(env), { revokedByUserId: actor.userId });
  return jsonOk({ accessKey: formatAccessKey(revoked) });
}

async function revokeOwnedAccessKey(env, config, store, { accessKeyId, ownerType, ownerId, revokedByUserId }) {
  const existing = await store.getAccessKeyById(accessKeyId, config.environment);
  if (!existing || existing.ownerType !== ownerType || existing.ownerId !== ownerId) {
    return jsonError('ACCESS_KEY_NOT_FOUND', 'Access key not found.', 404, 'Check the access key id.');
  }

  const revoked = await store.revokeAccessKey(accessKeyId, readNow(env), { revokedByUserId });
  return jsonOk({ accessKey: formatAccessKey(revoked) });
}

function formatAccessKey(accessKey) {
  return {
    id: accessKey.id,
    ownerType: accessKey.ownerType || 'user',
    ownerId: accessKey.ownerId || accessKey.ownerUserId,
    ownerUserId: accessKey.ownerUserId,
    createdByUserId: accessKey.createdByUserId || accessKey.ownerUserId,
    name: accessKey.name,
    scopes: [...accessKey.scopes],
    siteId: accessKey.siteId,
    expiresAt: accessKey.expiresAt,
    lastUsedAt: accessKey.lastUsedAt,
    revokedAt: accessKey.revokedAt,
    revokedByUserId: accessKey.revokedByUserId || null,
    revokedReason: accessKey.revokedReason || null,
    createdAt: accessKey.createdAt,
    environment: accessKey.environment || null,
  };
}

function isActiveAccessKey(accessKey) {
  return !accessKey.revokedAt;
}

async function requireTeamAdmin(store, config, session, teamId) {
  const team = await store.getTeam(teamId);
  if (!team || team.environment !== config.environment || team.deletedAt || team.status !== 'active') {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  const member = await store.getTeamMember({ teamId, userId: session.userId });
  if (!member) return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  if (member.role !== 'admin') {
    return jsonError('TEAM_ADMIN_REQUIRED', 'Team admin role required.', 403, 'Ask a team admin to perform this action.');
  }
  return { team, member };
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

function normalizeExpiresAt(value, nowIso) {
  const now = new Date(nowIso);
  const max = addUtcYears(now, MAX_EXPIRY_YEARS);
  const raw = typeof value === 'string' && value ? value : addUtcMonths(now, DEFAULT_EXPIRY_MONTHS).toISOString();
  const expiresAt = new Date(raw);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    return jsonError('ACCESS_KEY_EXPIRY_INVALID', 'Access key expiry is invalid.', 400, 'Use a future expiry time.');
  }
  if (expiresAt > max) {
    return jsonError('ACCESS_KEY_EXPIRY_TOO_LONG', 'Access key expiry is too long.', 400, 'Use an expiry within one year.');
  }
  return expiresAt.toISOString();
}

function addUtcMonths(date, months) {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function addUtcYears(date, years) {
  const next = new Date(date.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
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
