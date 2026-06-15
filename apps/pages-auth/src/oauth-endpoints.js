import { buildAuthSessionCookie } from './cookies.js';
import { createOpaqueToken } from './id.js';
import { jsonError, safeRedirect } from './http.js';
import { signSessionJwt } from './jwt.js';

const AUTH_SESSION_AUDIENCE = 'pages-auth';

export async function handleOAuthAuthorize(request, env, config) {
  if (request.method !== 'GET') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  const url = new URL(request.url);
  const siteHost = requiredQuery(url, 'site_host');
  const returnTo = requiredQuery(url, 'return_to');
  if (!siteHost || !returnTo) return jsonError('OAUTH_AUTHORIZE_INVALID', 'OAuth authorize request is invalid.', 400);
  if (!config.ssoAuthorizationUrl || !config.ssoClientId) {
    return jsonError('SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }

  const now = readNow(env);
  let created;
  try {
    created = await createOAuthStateRecord(env, {
      environment: config.environment,
      siteHost,
      returnTo,
      now,
      ttlSeconds: config.oauthStateTtlSeconds,
      stateId: createOpaqueToken('ost'),
      stateSecret: createOpaqueToken('sec'),
    });
  } catch {
    return jsonError('OAUTH_AUTHORIZE_INVALID', 'OAuth authorize request is invalid.', 400);
  }

  try {
    return safeRedirect(buildSsoAuthorizeUrl(config, created.publicState), 302);
  } catch {
    return jsonError('SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }
}

export async function handleOAuthCallback(request, env, config) {
  if (request.method !== 'GET') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  const url = new URL(request.url);
  const code = requiredQuery(url, 'code');
  const publicState = requiredQuery(url, 'state');
  if (!code || !publicState) return jsonError('OAUTH_CALLBACK_INVALID', 'OAuth callback request is invalid.', 400);

  if (typeof env?.fetchSsoToken !== 'function' || typeof env?.fetchSsoProfile !== 'function') {
    return jsonError('SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }

  const now = readNow(env);
  let consumedState;
  try {
    consumedState = await consumeOAuthStateRecord(env, publicState, { now });
  } catch (error) {
    return jsonError('OAUTH_STATE_INVALID', 'OAuth state is invalid.', statusForStateError(error));
  }

  let profile;
  try {
    const token = await env.fetchSsoToken({ code, redirectUri: config.ssoRedirectUri });
    const accessToken = normalizeAccessToken(token);
    profile = await env.fetchSsoProfile({ accessToken });
  } catch {
    return jsonError('SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502);
  }

  const userId = normalizeUserId(profile);
  if (!userId) return jsonError('SSO_PROFILE_INVALID', 'SSO profile is invalid.', 502);

  let sid;
  let authToken;
  try {
    sid = createOpaqueToken('sid');
    await createAuthSessionRecord(env, {
      sid,
      userId,
      purpose: 'auth_session',
      now,
      idleTtlSeconds: config.authSessionIdleTtlSeconds,
      absoluteTtlSeconds: config.authSessionAbsoluteTtlSeconds,
    });
    authToken = await signSessionJwt(
      {
        purpose: 'auth_session',
        audience: AUTH_SESSION_AUDIENCE,
        subject: userId,
        now,
        ttlSeconds: config.authSessionIdleTtlSeconds,
        claims: {
          sid,
        },
      },
      env
    );
  } catch {
    return jsonError('AUTH_SESSION_CREATE_FAILED', 'Auth session could not be created.', 500);
  }

  const response = safeRedirect(consumedState.returnTo, 302);
  response.headers.set('Set-Cookie', buildAuthSessionCookie(authToken, { maxAgeSeconds: config.authSessionIdleTtlSeconds }));
  return response;
}

export function buildSsoAuthorizeUrl(config, publicState) {
  if (!config.ssoAuthorizationUrl || !config.ssoClientId) throw new Error('SSO provider is not configured');

  const url = new URL(config.ssoAuthorizationUrl);
  url.searchParams.set('client_id', config.ssoClientId);
  url.searchParams.set('redirect_uri', config.ssoRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', publicState);
  return url.toString();
}

async function createOAuthStateRecord(env, input) {
  if (typeof env?.createOAuthStateRecord === 'function') return env.createOAuthStateRecord(input);

  const stub = getOAuthStateStub(env, input.stateId);
  const response = await stub.fetch(jsonDoRequest('https://oauth-state-do/create', input));
  if (!response.ok) throw new Error('OAuth state create failed');
  return response.json();
}

async function consumeOAuthStateRecord(env, publicState, options) {
  if (typeof env?.consumeOAuthStateRecord === 'function') return env.consumeOAuthStateRecord(publicState, options);

  const stub = getOAuthStateStub(env, parsePublicStateId(publicState));
  const response = await stub.fetch(jsonDoRequest('https://oauth-state-do/consume', { publicState, now: options.now }));
  if (!response.ok) throw new Error('OAuth state consume failed');
  return response.json();
}

async function createAuthSessionRecord(env, input) {
  if (typeof env?.createAuthSessionRecord === 'function') return env.createAuthSessionRecord(input);

  const stub = getAuthSessionStub(env, input.sid);
  const response = await stub.fetch(jsonDoRequest('https://auth-session-do/create', input));
  if (!response.ok) throw new Error('Auth session create failed');
  return response.json();
}

function getOAuthStateStub(env, stateId) {
  if (!env?.OAUTH_STATES) throw new Error('OAuth state Durable Object binding is missing');
  return env.OAUTH_STATES.get(env.OAUTH_STATES.idFromName(stateId));
}

function getAuthSessionStub(env, sid) {
  if (!env?.AUTH_SESSIONS) throw new Error('Auth session Durable Object binding is missing');
  return env.AUTH_SESSIONS.get(env.AUTH_SESSIONS.idFromName(sid));
}

function jsonDoRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function requiredQuery(url, name) {
  const value = url.searchParams.get(name);
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  if (Number.isInteger(env?.now)) return env.now;
  return Math.floor(Date.now() / 1000);
}

function parsePublicStateId(publicState) {
  const [stateId] = String(publicState || '').split('.');
  if (!stateId) throw new Error('OAuth state is invalid');
  return stateId;
}

function normalizeAccessToken(token) {
  const accessToken = token?.accessToken || token?.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') throw new Error('SSO access token is invalid');
  return accessToken;
}

function normalizeUserId(profile) {
  const userId = profile?.userId || profile?.id || profile?.sub;
  return typeof userId === 'string' && userId !== '' ? userId : null;
}

function statusForStateError(error) {
  const message = error instanceof Error ? error.message : '';
  if (/already consumed/.test(message)) return 409;
  return 400;
}
