import { isConnectionAssertionCandidate, readConnectionAuthConfig, verifyConnectionAssertion } from './connection-assertion.js';
import { constantTimeEqualHex, hashAccessKey, parseAccessKeyPlaintext } from './crypto.js';
import { nextId } from './id.js';
import { readAccessKeyPepper } from './infrastructure/config/identity-config.js';

const CONNECTION_ACTOR_SCOPES = ['deploy:site', 'read:site', 'rollback:site'];

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

  if (isConnectionAssertionCandidate(token)) {
    const connectionConfig = readConnectionAuthConfig(env);
    if (connectionConfig) return authenticateConnectionAssertion(token, connectionConfig, env, store, config, now);
  }

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

  const ownerType = accessKey.ownerType ?? 'user';
  if (ownerType !== 'user' && ownerType !== 'team') {
    return authError('ACCESS_KEY_INVALID', 'Access key is invalid.', 401, 'Check the configured access key.');
  }
  if (accessKey.issuedSource === 'cli_login' && !isValidCliLoginAccessKey(accessKey, ownerType)) {
    return authError('ACCESS_KEY_INVALID', 'Access key is invalid.', 401, 'Check the configured access key.');
  }
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
    return authError('ACCESS_KEY_SESSION_STALE', 'Access key session is stale.', 401, 'Create a new access key.');
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

function isValidCliLoginAccessKey(accessKey, ownerType) {
  return (
    ownerType === 'user' &&
    typeof accessKey.ownerId === 'string' &&
    accessKey.ownerId.length > 0 &&
    accessKey.ownerUserId === accessKey.ownerId &&
    accessKey.siteId == null &&
    Array.isArray(accessKey.scopes) &&
    accessKey.scopes.length === 1 &&
    accessKey.scopes[0] === '*' &&
    Number.isInteger(accessKey.issuedSessionVersion) &&
    accessKey.issuedSessionVersion > 0
  );
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

async function authenticateConnectionAssertion(token, connectionConfig, env, store, config, now) {
  const verified = await verifyConnectionAssertion(token, connectionConfig, {
    nowSeconds: Math.floor(new Date(now).getTime() / 1000),
    fetchFn: env.connectionJwksFetch,
    cache: env.connectionJwksCache,
  });
  if (!verified.ok) {
    if (verified.unavailable) {
      return authError(
        'CONNECTION_KEYS_UNAVAILABLE',
        'Connection signing keys are temporarily unavailable.',
        503,
        'Retry shortly.'
      );
    }
    return authError(
      'CONNECTION_ASSERTION_INVALID',
      'Connection assertion is invalid.',
      401,
      'Refresh the Cindy connection assertion and retry.'
    );
  }

  const identity = await resolveConnectionUser(env, store, config, verified.claims, now);
  if (!identity.ok) {
    await recordConnectionAudit(env, store, config, 'connection.request.deny', null, verified.claims, now, {
      decision: 'deny',
      statusCode: identity.error.status,
      reason: identity.error.code,
    });
    return identity;
  }
  const user = identity.user;

  if (user.employeeStatus !== 'active') {
    await recordConnectionAudit(env, store, config, 'connection.request.deny', user.id, verified.claims, now, {
      decision: 'deny',
      statusCode: 403,
      reason: 'PAGES_USER_INACTIVE',
    });
    return authError('PAGES_USER_INACTIVE', 'User is not active.', 403, 'Contact the Pages platform owner.');
  }

  return {
    ok: true,
    actor: {
      type: 'access_key',
      actorId: user.id,
      userId: user.id,
      email: user.email,
      name: user.realname || null,
      tokenId: null,
      ownerType: 'user',
      ownerId: user.id,
      scopes: [...CONNECTION_ACTOR_SCOPES],
      siteId: null,
      source: 'cindy_connection',
    },
  };
}

async function resolveConnectionUser(env, store, config, claims, now) {
  const byMembership = await store.getUserByCindyMembershipId(claims.membershipId);
  if (byMembership) return { ok: true, user: byMembership };

  const byEmail = await store.getUserByEmail(claims.email);
  if (byEmail) {
    if (byEmail.cindyMembershipId && byEmail.cindyMembershipId !== claims.membershipId) {
      return connectionIdentityConflict();
    }
    if (byEmail.employeeStatus !== 'active') {
      return authError('PAGES_USER_INACTIVE', 'User is not active.', 403, 'Contact the Pages platform owner.');
    }
    let bound = false;
    try {
      bound = await store.bindUserCindyMembershipId(byEmail.id, claims.membershipId);
    } catch (error) {
      if (!isUserIdentityConstraintError(error)) throw error;
    }
    if (!bound) return connectionIdentityConflict();
    await recordConnectionAudit(env, store, config, 'connection.user.link', byEmail.id, claims, now);
    return { ok: true, user: { ...byEmail, cindyMembershipId: claims.membershipId } };
  }

  let created;
  try {
    created = await store.createUser({
      userId: nextId(env, 'usr'),
      email: claims.email,
      realname: null,
      employeeStatus: 'active',
      createdSource: 'cindy',
      cindyMembershipId: claims.membershipId,
      departmentPath: null,
      departmentCheckedAt: null,
    });
  } catch (error) {
    if (!isUserIdentityConstraintError(error)) throw error;
    // Lost a concurrent first-request race: the winning row is authoritative.
    const winner = await store.getUserByCindyMembershipId(claims.membershipId);
    if (winner) return { ok: true, user: winner };
    return connectionIdentityConflict();
  }
  await recordConnectionAudit(env, store, config, 'connection.user.create', created.id, claims, now);
  return { ok: true, user: created };
}

async function recordConnectionAudit(env, store, config, eventType, userId, claims, now, options = {}) {
  const { decision = 'allow', statusCode = 200, reason = null } = options;
  try {
    await store.recordAuditEvent({
      id: nextId(env, 'aud'),
      environment: config.environment,
      traceId: null,
      eventType,
      actorUserId: userId,
      actorType: 'connection',
      siteId: null,
      routeId: null,
      versionId: null,
      decision,
      statusCode,
      ipHash: null,
      userAgentHash: null,
      // Every contract claim of the verified assertion is preserved as binding/denial
      // evidence (typ and ctx are invariants of a passing verification). Contract-external
      // payload fields are never read, so they can never land here.
      metadata: {
        environment: config.environment,
        userId,
        membershipId: claims.membershipId,
        email: claims.email,
        orgSlug: claims.orgSlug,
        issuer: claims.issuer,
        audience: claims.audience,
        jti: claims.jti,
        assertionIssuedAt: claims.issuedAt,
        assertionExpiresAt: claims.expiresAt,
        ...(reason ? { reason } : {}),
      },
      createdAt: now,
    });
  } catch {
    // Connection audit records are best-effort and must not change the request result.
  }
}

function connectionIdentityConflict() {
  return authError(
    'CONNECTION_IDENTITY_CONFLICT',
    'Connection identity conflicts with an existing user.',
    409,
    'Contact the Pages platform owner to resolve the account mapping.'
  );
}

function isUserIdentityConstraintError(error) {
  return (
    [
      'USER_EXISTS',
      'USER_EMAIL_CONFLICT',
      'USER_FEISHU_OPEN_ID_CONFLICT',
      'USER_CINDY_MEMBERSHIP_CONFLICT',
      'USER_IDENTITY_CONFLICT',
    ].includes(error?.code || error?.message) ||
    /UNIQUE constraint failed:\s*(?:users\.|index\s+['"]?idx_users)/i.test(String(error?.message || ''))
  );
}

function readBearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~+/-]+)$/);
  return match ? match[1] : null;
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
