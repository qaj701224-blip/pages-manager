import { handleCliLoginPoll, handleCliLoginStart } from './cli-endpoints.js';
import { readAuthConfig } from './config.js';
import {
  confirmStoredCliLogin,
  consumeStoredCliLogin,
  consumeStoredOAuthState,
  createStoredCliLogin,
  createStoredOAuthState,
  pollStoredCliLogin,
  createStoredSession,
  refreshStoredSession,
  revokeStoredSession,
} from './do-storage.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { handleOAuthAuthorize, handleOAuthCallback } from './oauth-endpoints.js';

export default {
  async fetch(request, env) {
    let config;
    try {
      config = readAuthConfig(env);
    } catch {
      return jsonError('AUTH_ENV_INVALID', 'Auth environment is invalid.', 500);
    }

    const url = new URL(request.url);
    if (url.pathname === '/.xd-pages/health') {
      return jsonOk(
        {
          status: 'ok',
          service: 'pages-auth',
          environment: config.environment,
        },
        200
      );
    }

    if (url.pathname === '/.xd-pages/cli/login/start') return handleCliLoginStart(request, env, config);
    if (url.pathname === '/.xd-pages/cli/login/poll') return handleCliLoginPoll(request, env, config);
    if (url.pathname === '/.xd-pages/auth/authorize') return handleOAuthAuthorize(request, env, config);
    if (url.pathname === '/.xd-pages/auth/callback') return handleOAuthCallback(request, env, config);

    return jsonError('NOT_FOUND', 'Endpoint not found.', 404);
  },
};

export class OAuthStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return handleStorageAction(request, this.state.storage, {
      '/create': (storage, body) => createStoredOAuthState(storage, body),
      '/consume': (storage, body) => consumeStoredOAuthState(storage, body.publicState, { now: body.now }),
    });
  }
}

export class CliLoginDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return handleStorageAction(request, this.state.storage, {
      '/create': (storage, body) => createStoredCliLogin(storage, body),
      '/confirm': (storage, body) =>
        confirmStoredCliLogin(storage, { deviceCode: body.deviceCode, userId: body.userId }, { now: body.now }),
      '/poll': (storage, body) =>
        pollStoredCliLogin(storage, { loginId: body.loginId, loginSecret: body.loginSecret }, { now: body.now }),
      '/consume': (storage, body) =>
        consumeStoredCliLogin(storage, { loginId: body.loginId, loginSecret: body.loginSecret }, { now: body.now }),
    });
  }
}

export class AuthSessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return handleStorageAction(request, this.state.storage, {
      '/create': (storage, body) => createStoredSession(storage, body),
      '/refresh': (storage, body) =>
        refreshStoredSession(storage, body.sid, { now: body.now, idleTtlSeconds: body.idleTtlSeconds }),
      '/revoke': (storage, body) => revokeStoredSession(storage, body.sid, { now: body.now }),
    });
  }
}

async function handleStorageAction(request, storage, actions) {
  if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  const action = actions[new URL(request.url).pathname];
  if (!action) return jsonError('NOT_FOUND', 'Endpoint not found.', 404);

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400);
  }

  try {
    return jsonOk(await action(storage, body));
  } catch (error) {
    return jsonError('STATE_INVALID', 'State transition is invalid.', statusForStorageError(error));
  }
}

function statusForStorageError(error) {
  const message = error instanceof Error ? error.message : '';
  if (/already consumed|still pending|status is/.test(message)) return 409;
  return 400;
}
