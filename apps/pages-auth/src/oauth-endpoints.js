import { buildAuthSessionCookie } from './cookies.js';
import { createOpaqueToken } from './id.js';
import { jsonError, readJsonBody, safeRedirect } from './http.js';
import { signSessionJwt, verifySessionJwt } from './jwt.js';

const AUTH_SESSION_AUDIENCE = 'pages-auth';
const CLI_TOKEN_AUDIENCE = 'pages-cli';
const SITE_CODE_TTL_SECONDS = 60;
const ACTIVE_EMPLOYEE_STATUS = 'active';

export async function handleOAuthAuthorize(request, env, config) {
  if (request.method !== 'GET') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  if (!config.ssoAuthorizationUrl || !config.ssoClientId) {
    return jsonError('SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }

  const now = readNow(env);
  const stateInput = buildOAuthStateInput(new URL(request.url), config, now);
  if (!stateInput) return jsonError('OAUTH_AUTHORIZE_INVALID', 'OAuth authorize request is invalid.', 400);

  let created;
  try {
    created = await createOAuthStateRecord(env, stateInput);
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

  if (!ssoExchangeIsConfigured(env, config)) {
    return jsonError('SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }

  const now = readNow(env);
  let consumedState;
  try {
    consumedState = await consumeOAuthStateRecord(env, publicState, { now, environment: config.environment });
  } catch (error) {
    return jsonError('OAUTH_STATE_INVALID', 'OAuth state is invalid.', statusForStateError(error));
  }

  let profile;
  try {
    const token = await fetchSsoToken(env, config, { code });
    const accessToken = normalizeAccessToken(token);
    profile = normalizeSsoProfile(await fetchSsoProfile(env, config, { accessToken }));
  } catch {
    return jsonError('SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502);
  }

  if (!profile.id) return jsonError('SSO_PROFILE_INVALID', 'SSO profile is invalid.', 502);
  if (profile.employeeStatus !== ACTIVE_EMPLOYEE_STATUS) {
    return jsonError('SSO_PROFILE_INACTIVE', 'SSO profile is not active.', 403);
  }

  let authToken;
  try {
    authToken = await createAuthSession(env, config, profile.id, now);
  } catch {
    return jsonError('AUTH_SESSION_CREATE_FAILED', 'Auth session could not be created.', 500);
  }

  if (consumedState.kind === 'cli') {
    try {
      await confirmCliLoginRecord(
        env,
        {
          loginId: consumedState.cliLoginId,
          deviceCode: consumedState.deviceCode,
          userId: profile.id,
        },
        { now }
      );
    } catch {
      return jsonError('CLI_LOGIN_CONFIRM_FAILED', 'CLI login could not be confirmed.', 400);
    }

    const response = new Response('CLI login confirmed. You can return to the terminal.', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    response.headers.set('Set-Cookie', buildAuthSessionCookie(authToken, { maxAgeSeconds: config.authSessionIdleTtlSeconds }));
    return response;
  }

  let siteCode;
  try {
    siteCode = await createOAuthSiteCodeRecord(env, {
      stateId: consumedState.record.id,
      user: profile,
      now,
      ttlSeconds: SITE_CODE_TTL_SECONDS,
      codeSecret: createOpaqueToken('sec'),
    });
  } catch {
    return jsonError('AUTH_SESSION_CREATE_FAILED', 'Auth session could not be created.', 500);
  }

  const response = safeRedirect(buildSiteCallbackUrl(consumedState.siteHost, siteCode.siteCode), 302);
  response.headers.set('Set-Cookie', buildAuthSessionCookie(authToken, { maxAgeSeconds: config.authSessionIdleTtlSeconds }));
  return response;
}

export async function handleInternalConsumeSiteCode(request, env) {
  if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  if (!isInternalRequest(request)) return jsonError('NOT_FOUND', 'Endpoint not found.', 404);

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400);
  }

  const siteCode = typeof body.siteCode === 'string' ? body.siteCode : '';
  const siteHost = typeof body.siteHost === 'string' ? body.siteHost : '';
  const now = Number.isInteger(body.now) ? body.now : readNow(env);
  if (!siteCode || !siteHost) return jsonError('SITE_CODE_CONSUME_INVALID', 'Site code consume request is invalid.', 400);

  try {
    const consumed = await consumeOAuthSiteCodeRecord(env, siteCode, {
      now,
      siteHost,
      environment: readEnvironmentForInternal(env),
    });
    return new Response(
      JSON.stringify({
        returnTo: consumed.returnTo,
        user: consumed.user,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch {
    return jsonError('SITE_CODE_INVALID', 'Site code is invalid.', 400);
  }
}

export async function handleInternalVerifyCliToken(request, env) {
  if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  if (!isInternalRequest(request)) return jsonError('NOT_FOUND', 'Endpoint not found.', 404);

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400);
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const audience = typeof body.audience === 'string' && body.audience !== '' ? body.audience : CLI_TOKEN_AUDIENCE;
  if (!token) return jsonError('CLI_TOKEN_INVALID', 'CLI token is invalid.', 401);

  try {
    const payload = await verifySessionJwt(token, env, {
      purpose: 'cli_token',
      audience,
      now: readNow(env),
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return jsonError('CLI_TOKEN_INVALID', 'CLI token is invalid.', 401);
  }
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

function buildOAuthStateInput(url, config, now) {
  const cliLoginId = requiredQuery(url, 'cli_login_id');
  if (cliLoginId) {
    const deviceCode = requiredQuery(url, 'device_code');
    if (!deviceCode) return null;
    return {
      environment: config.environment,
      cliLoginId,
      deviceCode,
      now,
      ttlSeconds: config.oauthStateTtlSeconds,
      stateId: createOpaqueToken('ost'),
      stateSecret: createOpaqueToken('sec'),
    };
  }

  const siteHost = requiredQuery(url, 'site_host');
  const returnTo = requiredQuery(url, 'return_to');
  if (!siteHost || !returnTo) return null;
  return {
    environment: config.environment,
    siteHost,
    returnTo,
    now,
    ttlSeconds: config.oauthStateTtlSeconds,
    stateId: createOpaqueToken('ost'),
    stateSecret: createOpaqueToken('sec'),
  };
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
  const response = await stub.fetch(
    jsonDoRequest('https://oauth-state-do/consume', {
      publicState,
      now: options.now,
      environment: options.environment,
    })
  );
  if (!response.ok) throw new Error('OAuth state consume failed');
  return response.json();
}

async function createOAuthSiteCodeRecord(env, input) {
  if (typeof env?.createOAuthSiteCodeRecord === 'function') return env.createOAuthSiteCodeRecord(input);

  const stub = getOAuthStateStub(env, input.stateId);
  const response = await stub.fetch(jsonDoRequest('https://oauth-state-do/create-site-code', input));
  if (!response.ok) throw new Error('OAuth site code create failed');
  return response.json();
}

async function consumeOAuthSiteCodeRecord(env, siteCode, options) {
  if (typeof env?.consumeOAuthSiteCodeRecord === 'function') return env.consumeOAuthSiteCodeRecord(siteCode, options);

  const stub = getOAuthStateStub(env, parsePublicStateId(siteCode));
  const response = await stub.fetch(
    jsonDoRequest('https://oauth-state-do/consume-site-code', {
      siteCode,
      now: options.now,
      siteHost: options.siteHost,
      environment: options.environment,
    })
  );
  if (!response.ok) throw new Error('OAuth site code consume failed');
  return response.json();
}

async function createAuthSession(env, config, userId, now) {
  const sid = createOpaqueToken('sid');
  await createAuthSessionRecord(env, {
    sid,
    userId,
    purpose: 'auth_session',
    now,
    idleTtlSeconds: config.authSessionIdleTtlSeconds,
    absoluteTtlSeconds: config.authSessionAbsoluteTtlSeconds,
  });
  return signSessionJwt(
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
}

async function createAuthSessionRecord(env, input) {
  if (typeof env?.createAuthSessionRecord === 'function') return env.createAuthSessionRecord(input);

  const stub = getAuthSessionStub(env, input.sid);
  const response = await stub.fetch(jsonDoRequest('https://auth-session-do/create', input));
  if (!response.ok) throw new Error('Auth session create failed');
  return response.json();
}

async function confirmCliLoginRecord(env, input, options) {
  if (typeof env?.confirmCliLoginRecord === 'function') return env.confirmCliLoginRecord(input, options);

  const stub = getCliLoginStub(env, input.loginId);
  const response = await stub.fetch(
    jsonDoRequest('https://cli-login-do/confirm', {
      deviceCode: input.deviceCode,
      userId: input.userId,
      now: options.now,
    })
  );
  if (!response.ok) throw new Error('CLI login confirm failed');
  return response.json();
}

function buildSiteCallbackUrl(siteHost, siteCode) {
  const url = new URL(`https://${siteHost}/.xd-pages/auth/callback`);
  url.searchParams.set('code', siteCode);
  return url.toString();
}

function getOAuthStateStub(env, stateId) {
  if (!env?.OAUTH_STATES) throw new Error('OAuth state Durable Object binding is missing');
  return env.OAUTH_STATES.get(env.OAUTH_STATES.idFromName(stateId));
}

function getAuthSessionStub(env, sid) {
  if (!env?.AUTH_SESSIONS) throw new Error('Auth session Durable Object binding is missing');
  return env.AUTH_SESSIONS.get(env.AUTH_SESSIONS.idFromName(sid));
}

function getCliLoginStub(env, loginId) {
  if (!env?.CLI_LOGINS) throw new Error('CLI login Durable Object binding is missing');
  return env.CLI_LOGINS.get(env.CLI_LOGINS.idFromName(loginId));
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

function normalizeSsoProfile(profile) {
  return {
    id: normalizeUserId(profile),
    email: normalizeOptionalString(profile?.email).toLowerCase(),
    employeeStatus: normalizeEmployeeStatus(profile?.employeeStatus ?? profile?.employee_status),
    departments: normalizeDepartments(profile),
    sessionVersion: normalizeSessionVersion(profile?.sessionVersion ?? profile?.session_version),
  };
}

function normalizeUserId(profile) {
  const userId = profile?.userId || profile?.id || profile?.sub;
  return typeof userId === 'string' && userId !== '' ? userId : null;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmployeeStatus(value) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (normalized === '1' || normalized === 'active') return 'active';
  if (normalized === '0' || normalized === 'disabled' || normalized === 'inactive') return 'disabled';
  if (normalized === 'left' || normalized === 'leave' || normalized === 'departed') return 'left';
  return 'unknown';
}

function normalizeDepartments(profile) {
  const value = profile?.departments ?? profile?.departmentIds ?? profile?.department_ids;
  if (Array.isArray(value)) return value.map((item) => normalizeOptionalString(item)).filter(Boolean);
  const single = profile?.departmentId ?? profile?.department_id ?? profile?.department;
  const normalized = normalizeOptionalString(single);
  return normalized ? [normalized] : [];
}

function normalizeSessionVersion(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function ssoExchangeIsConfigured(env, config) {
  if (typeof env?.fetchSsoToken === 'function' && typeof env?.fetchSsoProfile === 'function') return true;
  return Boolean(config.ssoTokenUrl && config.ssoProfileUrl && config.ssoClientId && config.ssoClientSecret);
}

async function fetchSsoToken(env, config, { code }) {
  if (typeof env?.fetchSsoToken === 'function') {
    return env.fetchSsoToken({ code, redirectUri: config.ssoRedirectUri });
  }

  const url = new URL(config.ssoTokenUrl);
  url.searchParams.set('code', code);
  url.searchParams.set('client_id', config.ssoClientId);
  url.searchParams.set('client_secret', config.ssoClientSecret);
  url.searchParams.set('redirect_uri', config.ssoRedirectUri);
  url.searchParams.set('grant_type', 'authorization_code');

  const response = await fetch(url.toString(), { method: 'GET' });
  if (!response.ok) throw new Error('SSO token request failed');
  const token = await response.json();
  if (token?.error) throw new Error('SSO token response failed');
  return token;
}

async function fetchSsoProfile(env, config, { accessToken }) {
  if (typeof env?.fetchSsoProfile === 'function') return env.fetchSsoProfile({ accessToken });

  const url = new URL(config.ssoProfileUrl);
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url.toString(), { method: 'GET' });
  if (!response.ok) throw new Error('SSO profile request failed');
  return response.json();
}

function isInternalRequest(request) {
  return new URL(request.url).hostname === 'pages-auth.internal';
}

function readEnvironmentForInternal(env) {
  const environment = env?.PAGES_ENV;
  return environment === 'production' || environment === 'staging' || environment === 'local' ? environment : undefined;
}

function statusForStateError(error) {
  const message = error instanceof Error ? error.message : '';
  if (/already consumed/.test(message)) return 409;
  return 400;
}
