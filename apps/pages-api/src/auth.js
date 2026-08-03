import { constantTimeEqualHex, hashAccessKey, parseAccessKeyPlaintext } from './crypto.js';

export async function authenticateApiRequest(request, env, store, config, now = new Date().toISOString()) {
  if (request.headers.has('X-Pages-Token')) {
    return authError(
      'LEGACY_TOKEN_UNSUPPORTED',
      'Legacy Pages token headers are not supported by XD Cell.',
      400,
      'Run `xd-cell login` or use an XD Cell access key.'
    );
  }

  const token = readBearerToken(request);
  if (!token) {
    return authError('PAGES_AUTH_REQUIRED', 'Login required.', 401, 'Run `xd-cell login` and retry.');
  }

  const accessKeyParts = parseAccessKeyPlaintext(token);
  if (accessKeyParts) return authenticateAccessKey(token, accessKeyParts, env, store, config, now);

  // Non-access-key bearer tokens are legacy CLI token JWTs, no longer honored. Prompt a one-time re-login.
  return authError('CLI_TOKEN_INVALID', 'CLI token is invalid.', 401, 'Run `xd-cell login` and retry.');
}

export function errorResponseForAuth(result) {
  if (result.ok) throw new Error('Cannot create an error response for successful auth');
  return result.error;
}

function cliUserActorResult(userId, user, tokenId) {
  return {
    ok: true,
    actor: {
      type: 'user',
      actorId: userId,
      userId,
      email: user.email,
      name: user.realname || null,
      tokenId,
      scopes: ['*'],
      source: 'cli',
    },
  };
}

async function authenticateAccessKey(plaintext, parts, env, store, config, now) {
  if (parts.environmentHint !== config.environment) {
    return authError('ACCESS_KEY_INVALID', 'Access key is invalid.', 401, 'Create an access key for this environment.');
  }

  const accessKey = await store.getAccessKeyById(parts.keyId, config.environment);
  if (!accessKey) return authError('ACCESS_KEY_INVALID', 'Access key is invalid.', 401, 'Check the configured access key.');
  if (accessKey.revokedAt) {
    return authError('ACCESS_KEY_REVOKED', 'Access key has been revoked.', 401, 'Create a new access key.');
  }
  if (accessKey.expiresAt && accessKey.expiresAt <= now) {
    return authError('ACCESS_KEY_EXPIRED', 'Access key has expired.', 401, 'Create a new access key.');
  }

  const pepper = readAccessKeyPepper(env, accessKey.pepperId);
  const candidateHash = await hashAccessKey(plaintext, pepper);
  if (!constantTimeEqualHex(candidateHash, accessKey.keyHash)) {
    return authError('ACCESS_KEY_INVALID', 'Access key is invalid.', 401, 'Check the configured access key.');
  }

  const ownerType = accessKey.ownerType || 'user';
  if (ownerType === 'team') return authenticateTeamAccessKey(accessKey, store, now);

  const ownerUserId = accessKey.ownerId || accessKey.ownerUserId;
  const user = await store.getUser(ownerUserId);
  if (!user || user.employeeStatus !== 'active') {
    return authError('PAGES_USER_INACTIVE', 'User is not active.', 403, 'Contact the Pages platform owner.');
  }

  if (
    Number.isInteger(accessKey.issuedSessionVersion) &&
    accessKey.issuedSessionVersion > 0 &&
    accessKey.issuedSessionVersion !== user.sessionVersion
  ) {
    return authError(
      'ACCESS_KEY_SESSION_STALE',
      'Access key session is stale.',
      401,
      'Ask XDMaker to exchange a new access key.'
    );
  }

  if (typeof store.updateAccessKeyLastUsed === 'function') await store.updateAccessKeyLastUsed(accessKey.id, now);

  if (accessKey.issuedSource === 'cli_login') return cliUserActorResult(ownerUserId, user, accessKey.id);

  return {
    ok: true,
    actor: {
      type: 'access_key',
      actorId: accessKey.id,
      userId: ownerUserId,
      email: user.email,
      name: user.realname || null,
      tokenId: accessKey.id,
      ownerType: 'user',
      ownerId: ownerUserId,
      scopes: [...accessKey.scopes],
      siteId: accessKey.siteId,
      source: 'access_key',
    },
  };
}

async function authenticateTeamAccessKey(accessKey, store, now) {
  const team = typeof store.getTeam === 'function' ? await store.getTeam(accessKey.ownerId) : null;
  if (!team) {
    return authError('ACCESS_KEY_OWNER_INACTIVE', 'Access key owner is inactive.', 403, 'Ask a team admin to create a new key.');
  }

  if (typeof store.updateAccessKeyLastUsed === 'function') await store.updateAccessKeyLastUsed(accessKey.id, now);

  return {
    ok: true,
    actor: {
      type: 'access_key',
      actorId: accessKey.id,
      userId: accessKey.createdByUserId || accessKey.ownerUserId || null,
      email: null,
      name: team.name || null,
      tokenId: accessKey.id,
      ownerType: 'team',
      ownerId: accessKey.ownerId,
      scopes: [...accessKey.scopes],
      siteId: accessKey.siteId,
      source: 'access_key',
    },
  };
}

function readBearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~+/-]+)$/);
  return match ? match[1] : null;
}

function readAccessKeyPepper(env, pepperId) {
  const registry = String(env?.ACCESS_KEY_PEPPERS || '').trim();
  if (!registry) throw new Error('Access key pepper registry is required');

  for (const entry of registry.split(',')) {
    const [entryPepperId, secretEnvName] = entry.split(':').map((part) => part.trim());
    if (entryPepperId === pepperId) {
      const secret = env[secretEnvName];
      if (typeof secret !== 'string' || secret === '') throw new Error('Access key pepper secret is invalid');
      return secret;
    }
  }
  throw new Error('Access key pepper is unknown');
}

function authError(code, message, status, action) {
  return {
    ok: false,
    error: {
      code,
      message,
      status,
      action,
    },
  };
}
