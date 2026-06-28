import { constantTimeEqualHex, hashAccessKey, parseAccessKeyPlaintext } from './crypto.js';

const CLI_TOKEN_AUDIENCE = 'pages-cli';

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
  return authenticateCliToken(token, env, store, config);
}

export function errorResponseForAuth(result) {
  if (result.ok) throw new Error('Cannot create an error response for successful auth');
  return result.error;
}

async function authenticateCliToken(token, env, store, config) {
  let payload;
  try {
    payload = await verifyCliToken(token, env, config);
  } catch {
    return authError('CLI_TOKEN_INVALID', 'CLI token is invalid.', 401, 'Run `xd-cell login` and retry.');
  }

  if (payload?.purpose !== 'cli_token' || payload?.aud !== CLI_TOKEN_AUDIENCE || payload?.env !== config.environment) {
    return authError('CLI_TOKEN_INVALID', 'CLI token is invalid.', 401, 'Run `xd-cell login` and retry.');
  }

  const userId = payload.sub;
  const user = await store.getUser(userId);
  if (!user || user.employeeStatus !== 'active') {
    return authError('PAGES_USER_INACTIVE', 'User is not active.', 403, 'Contact the Pages platform owner.');
  }

  return {
    ok: true,
    actor: {
      type: 'user',
      actorId: userId,
      userId,
      email: user.email,
      name: user.realname || null,
      tokenId: payload.jti || null,
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

  const user = await store.getUser(accessKey.ownerUserId);
  if (!user || user.employeeStatus !== 'active') {
    return authError('PAGES_USER_INACTIVE', 'User is not active.', 403, 'Contact the Pages platform owner.');
  }

  if (typeof store.updateAccessKeyLastUsed === 'function') await store.updateAccessKeyLastUsed(accessKey.id, now);

  return {
    ok: true,
    actor: {
      type: 'access_key',
      actorId: accessKey.id,
      userId: accessKey.ownerUserId,
      email: user.email,
      name: user.realname || null,
      tokenId: accessKey.id,
      scopes: [...accessKey.scopes],
      siteId: accessKey.siteId,
      source: 'access_key',
    },
  };
}

async function verifyCliToken(token, env, config) {
  if (typeof env?.verifyCliToken === 'function') return env.verifyCliToken(token, { audience: CLI_TOKEN_AUDIENCE, config });

  if (!env?.PAGES_AUTH) throw new Error('PAGES_AUTH binding is required');
  const response = await env.PAGES_AUTH.fetch(
    new Request('https://pages-auth.internal/.xd-pages/internal/verify-cli-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, audience: CLI_TOKEN_AUDIENCE }),
    })
  );
  if (!response.ok) throw new Error('CLI token verify failed');
  return response.json();
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
