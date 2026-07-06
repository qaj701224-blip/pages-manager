import { authenticateApiRequest } from './auth.js';
import { jsonError, jsonOk } from './http.js';

export async function handleWhoamiApi(request, env, config, store) {
  const url = new URL(request.url);
  if (url.pathname !== '/.xd-pages/api/auth/whoami') return null;
  if (request.method !== 'GET') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use GET.');

  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return jsonError(auth.error.code, auth.error.message, auth.error.status, auth.error.action);

  return jsonOk({
    environment: config.environment,
    actor: publicActor(auth.actor),
  });
}

function publicActor(actor) {
  if (actor.type === 'access_key') {
    return {
      type: 'access_key',
      credentialType: 'access_key',
      accessKeyId: actor.tokenId,
      userId: actor.userId,
      email: actor.email,
      name: actor.name,
      ownerType: actor.ownerType || 'user',
      ownerId: actor.ownerId || actor.userId,
      siteId: actor.siteId || null,
      scopes: actor.scopes,
    };
  }

  return {
    type: 'user',
    credentialType: 'cli_token',
    userId: actor.userId,
    email: actor.email,
    name: actor.name,
    scopes: actor.scopes,
  };
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  if (typeof env?.nowIso === 'function') return env.nowIso();
  return new Date().toISOString();
}
