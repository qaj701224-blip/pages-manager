import { buildAuthSessionCookie } from './cookies.js';
import { createOpaqueToken } from './id.js';
import { jsonError, readJsonBody, safeRedirect } from './http.js';
import { signSessionJwt, verifySessionJwt } from './jwt.js';
import { createPagesStore } from '../../pages-api/src/store.js';

const AUTH_SESSION_AUDIENCE = 'pages-auth';
const CLI_TOKEN_AUDIENCE = 'pages-cli';
const CLI_LOGIN_CONFIRM_AUDIENCE = 'pages-cli-login-confirm';
const SITE_CODE_TTL_SECONDS = 60;
const CLI_LOGIN_CONFIRM_TTL_SECONDS = 600;
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
    const rawProfile = await fetchSsoProfile(env, config, { accessToken });
    profile = normalizeSsoProfile(rawProfile);
    if (!ssoProfileMatchesAllowedScope(rawProfile, profile, config.ssoAllowedUserScope)) {
      return jsonError('SSO_PROFILE_SCOPE_FORBIDDEN', 'SSO profile is outside the allowed user scope.', 403);
    }
  } catch {
    return jsonError('SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502);
  }

  if (!profile.userId) return jsonError('SSO_PROFILE_INVALID', 'SSO profile is invalid.', 502);

  let authoritativeProfile;
  try {
    authoritativeProfile = mergeSyncedUserAuthority(profile, await syncSsoUserProfile(env, profile, now));
  } catch {
    return jsonError('SSO_USER_SYNC_FAILED', 'SSO user could not be synced.', 502);
  }

  if (authoritativeProfile.employeeStatus !== ACTIVE_EMPLOYEE_STATUS) {
    return jsonError('SSO_PROFILE_INACTIVE', 'SSO profile is not active.', 403);
  }

  let authSession;
  try {
    authSession = await createAuthSession(env, config, authoritativeProfile.userId, now);
  } catch {
    return jsonError('AUTH_SESSION_CREATE_FAILED', 'Auth session could not be created.', 500);
  }

  if (consumedState.kind === 'cli') {
    let confirmToken;
    try {
      confirmToken = await createCliLoginConfirmToken(env, {
        loginId: consumedState.cliLoginId,
        userId: authoritativeProfile.userId,
        sid: authSession.sid,
        now,
      });
    } catch {
      return jsonError('CLI_LOGIN_CONFIRM_CREATE_FAILED', 'CLI login confirmation could not be created.', 500);
    }

    const response = new Response(buildCliLoginConfirmationHtml(consumedState.cliLoginId, config, confirmToken), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
    response.headers.set(
      'Set-Cookie',
      buildAuthSessionCookie(authSession.token, { maxAgeSeconds: config.authSessionIdleTtlSeconds })
    );
    return response;
  }

  let siteCode;
  try {
    siteCode = await createOAuthSiteCodeRecord(env, {
      stateId: consumedState.record.id,
      user: siteCodeUserFromProfile(authoritativeProfile),
      now,
      ttlSeconds: SITE_CODE_TTL_SECONDS,
      codeSecret: createOpaqueToken('sec'),
    });
  } catch {
    return jsonError('AUTH_SESSION_CREATE_FAILED', 'Auth session could not be created.', 500);
  }

  const response = safeRedirect(buildSiteCallbackUrl(consumedState.siteHost, siteCode.siteCode), 302);
  response.headers.set(
    'Set-Cookie',
    buildAuthSessionCookie(authSession.token, { maxAgeSeconds: config.authSessionIdleTtlSeconds })
  );
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
    return {
      environment: config.environment,
      cliLoginId,
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
  return {
    sid,
    token: await signSessionJwt(
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
    ),
  };
}

async function createAuthSessionRecord(env, input) {
  if (typeof env?.createAuthSessionRecord === 'function') return env.createAuthSessionRecord(input);

  const stub = getAuthSessionStub(env, input.sid);
  const response = await stub.fetch(jsonDoRequest('https://auth-session-do/create', input));
  if (!response.ok) throw new Error('Auth session create failed');
  return response.json();
}

async function syncSsoUserProfile(env, profile, now) {
  if (typeof env?.syncSsoUserProfile === 'function') return env.syncSsoUserProfile(profile, { now });

  const timestamp = new Date(now * 1000).toISOString();
  return createPagesStore(env).upsertUserFromSso({
    userId: profile.userId,
    email: profile.email,
    realname: profile.realname,
    account: profile.account,
    accountId: profile.accountId,
    employeenum: profile.employeenum,
    employeeStatus: profile.employeeStatus,
    departments: profile.departments,
    sessionVersion: profile.sessionVersion,
    lastLoginAt: timestamp,
    updatedAt: timestamp,
  });
}

function mergeSyncedUserAuthority(profile, syncResult) {
  const user = syncResult?.user || syncResult || {};
  return {
    ...profile,
    userId: user.userId || user.id || profile.userId,
    email: user.email || profile.email,
    employeeStatus: user.employeeStatus || profile.employeeStatus,
    sessionVersion: user.sessionVersion || profile.sessionVersion,
  };
}

function createCliLoginConfirmToken(env, { loginId, userId, sid, now }) {
  return signSessionJwt(
    {
      purpose: 'cli_login_confirm',
      audience: CLI_LOGIN_CONFIRM_AUDIENCE,
      subject: userId,
      now,
      ttlSeconds: CLI_LOGIN_CONFIRM_TTL_SECONDS,
      claims: {
        loginId,
        sid,
      },
    },
    env
  );
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

function jsonDoRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildCliLoginConfirmationHtml(loginId, config, confirmToken) {
  const safeLoginId = htmlEscape(loginId);
  const safeConfirmToken = htmlEscape(confirmToken);
  const safeEnvironment = htmlEscape(config.environment);
  const safeAuthBase = htmlEscape(config.authBase);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Confirm Pages CLI Login</title>
</head>
<body>
  <main>
    <h1>Confirm Pages CLI Login</h1>
    <p>Enter the 8-digit code shown in your terminal to authorize this CLI session.</p>
    <dl>
      <dt>Environment</dt>
      <dd>${safeEnvironment}</dd>
      <dt>Auth</dt>
      <dd>${safeAuthBase}</dd>
      <dt>Scope</dt>
      <dd>cli_token</dd>
    </dl>
    <form method="post" action="/.xd-pages/cli/login/confirm" autocomplete="off">
      <input type="hidden" name="loginId" value="${safeLoginId}">
      <input type="hidden" name="confirmToken" value="${safeConfirmToken}">
      <label>
        Device code
        <input name="deviceCode" inputmode="numeric" pattern="[0-9]{8}" autocomplete="one-time-code" required>
      </label>
      <button type="submit">Confirm</button>
    </form>
  </main>
</body>
</html>`;
}

function htmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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
  const userId = normalizeUserId(profile);
  return {
    userId,
    email: normalizeOptionalString(profile?.email).toLowerCase(),
    realname: normalizeOptionalString(profile?.realname ?? profile?.name) || null,
    account: normalizeOptionalString(profile?.account) || null,
    accountId: normalizeOptionalString(profile?.accountId ?? profile?.account_id) || null,
    employeenum: normalizeOptionalString(profile?.employeenum ?? profile?.employeeNum ?? profile?.employee_num) || null,
    employeeStatus: normalizeEmployeeStatus(profile?.employeeStatus ?? profile?.employee_status),
    departments: normalizeDepartments(profile?.departments ?? profile?.departmentIds ?? profile?.department_ids),
    sessionVersion: normalizeSessionVersion(profile?.sessionVersion ?? profile?.session_version),
  };
}

function ssoProfileMatchesAllowedScope(rawProfile, profile, allowedScope) {
  const scope = normalizeOptionalString(allowedScope).toLowerCase();
  if (!scope) return true;

  const candidates = scopeCandidates(rawProfile).map((value) => value.toLowerCase());
  if (candidates.includes(scope)) return true;

  if (scope === 'xindong') {
    return [profile.email, rawProfile?.account, rawProfile?.fs_email]
      .map((value) => normalizeOptionalString(value).toLowerCase())
      .some((email) => email.endsWith('@xd.com') || email.endsWith('@xindong.com'));
  }

  return false;
}

function scopeCandidates(profile) {
  const values = [];
  for (const key of ['scope', 'userScope', 'user_scope', 'allowedUserScope', 'allowed_user_scope', 'tenant', 'organization']) {
    const value = profile?.[key];
    if (typeof value === 'string') values.push(...value.split(/[\s,]+/).filter(Boolean));
    if (Array.isArray(value)) values.push(...value.filter((item) => typeof item === 'string'));
  }
  for (const key of ['permissions', 'roles']) {
    const value = profile?.[key];
    if (Array.isArray(value)) values.push(...value.filter((item) => typeof item === 'string'));
  }
  return values;
}

function normalizeDepartments(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeOptionalString(item)).filter(Boolean))];
}

function siteCodeUserFromProfile(profile) {
  return {
    id: profile.userId,
    email: profile.email,
    employeeStatus: profile.employeeStatus,
    departments: profile.departments,
    sessionVersion: profile.sessionVersion,
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

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error('SSO token request failed');
  const token = await response.json();
  if (token?.error) throw new Error('SSO token response failed');
  return token;
}

async function fetchSsoProfile(env, config, { accessToken }) {
  if (typeof env?.fetchSsoProfile === 'function') return env.fetchSsoProfile({ accessToken });

  const url = new URL(config.ssoProfileUrl);
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
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
