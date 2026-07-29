import { buildClearAuthSessionCookie, buildClearSiteSessionCookie } from '@xd/session-kit';

import { handleCliLoginConfirm, handleCliLoginPoll, handleCliLoginStart } from './cli-endpoints.js';
import { readAuthConfig } from './config.js';
import {
  confirmStoredCliLogin,
  consumeStoredCliLogin,
  consumeStoredConsoleLoginCode,
  consumeStoredOAuthSiteCode,
  consumeStoredOAuthState,
  createStoredCliLogin,
  createStoredConsoleLoginCode,
  createStoredOAuthSiteCode,
  createStoredOAuthState,
  peekStoredCliLogin,
  pollStoredCliLogin,
  readStoredCliLoginForAuthorize,
  createStoredSession,
  refreshStoredSession,
  revokeStoredSession,
} from './do-storage.js';
import { isPublicRequestId, jsonError, jsonOk, readJsonBody, withRequestId } from './http.js';
import {
  handleInternalConsumeSiteCode,
  handleInternalConsoleExchange,
  handleInternalConsoleLoginCode,
  handleInternalVerifyCliToken,
  handleOAuthAuthorize,
  handleOAuthCallback,
} from './oauth-endpoints.js';

export default {
  async fetch(request, env) {
    const requestId = createRequestId(env);
    return await withRequestId(await routeAuthRequest(request, env, { requestId }), requestId);
  },
};

async function routeAuthRequest(request, env, context) {
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
  if (url.pathname === '/.xd-pages/cli/login/confirm') return handleCliLoginConfirm(request, env, config);
  if (url.pathname === '/.xd-pages/auth/authorize') return handleOAuthAuthorize(request, env, config, context);
  if (url.pathname === '/.xd-pages/auth/callback') return handleOAuthCallback(request, env, config, context);
  if (url.pathname === '/.xd-pages/auth/logout') return handleAuthLogout(request, config);
  if (url.pathname === '/.xd-pages/internal/consume-site-code') return handleInternalConsumeSiteCode(request, env, config);
  if (url.pathname === '/.xd-pages/internal/console/login-code') {
    return handleInternalConsoleLoginCode(request, env, config);
  }
  if (url.pathname === '/.xd-pages/internal/console/exchange') {
    return handleInternalConsoleExchange(request, env, config);
  }
  if (url.pathname === '/.xd-pages/internal/verify-cli-token') return handleInternalVerifyCliToken(request, env, config);

  return jsonError('NOT_FOUND', 'Endpoint not found.', 404);
}

function handleAuthLogout(request, config) {
  if (request.method !== 'GET' && request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  const url = new URL(request.url);
  const headers = new Headers({
    Location: normalizeConsoleLogoutReturnTo(url.searchParams.get('return_to'), config.environment),
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', buildClearAuthSessionCookie());
  headers.append('Set-Cookie', buildClearSiteSessionCookie());
  return new Response(null, { status: 302, headers });
}

function normalizeConsoleLogoutReturnTo(value, environment) {
  const fallback = `${consoleBaseForEnvironment(environment)}/login?loggedOut=1`;
  let url;
  try {
    url = new URL(String(value || fallback), fallback);
  } catch {
    return fallback;
  }

  if (url.origin !== new URL(fallback).origin || url.username || url.password || url.hash) return fallback;
  return url.href;
}

function consoleBaseForEnvironment(environment) {
  if (environment === 'staging') return 'https://staging.workers.xd.team';
  if (environment === 'local') return 'http://127.0.0.1:5174';
  return 'https://workers.xd.team';
}

export class OAuthStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return handleStorageAction(request, this.state.storage, {
      '/create': (storage, body) => createStoredOAuthState(storage, body),
      '/consume': (storage, body) =>
        consumeStoredOAuthState(storage, body.publicState, { now: body.now, environment: body.environment }),
      '/create-site-code': (storage, body) => createStoredOAuthSiteCode(storage, body),
      '/consume-site-code': (storage, body) =>
        consumeStoredOAuthSiteCode(storage, body.siteCode, {
          now: body.now,
          siteHost: body.siteHost,
          environment: body.environment,
        }),
      '/create-console-code': (storage, body) => createStoredConsoleLoginCode(storage, body),
      '/consume-console-code': (storage, body) =>
        consumeStoredConsoleLoginCode(storage, body.consoleCode, {
          now: body.now,
          environment: body.environment,
        }),
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
      '/read-for-authorize': (storage, body) =>
        readStoredCliLoginForAuthorize(storage, { loginId: body.loginId }, { now: body.now }),
      '/peek': (storage, body) =>
        peekStoredCliLogin(storage, { loginId: body.loginId, loginSecret: body.loginSecret }, { now: body.now }),
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

function createRequestId(env) {
  if (typeof env?.createRequestId === 'function') {
    const requestId = env.createRequestId();
    if (isPublicRequestId(requestId)) return requestId;
  }
  return createRandomRequestId();
}

function createRandomRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
