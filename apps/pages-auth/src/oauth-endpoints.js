import { browserPageResponse, wantsHtml } from './browser-pages.js';
import { AUTH_SESSION_COOKIE, buildAuthSessionCookie } from './cookies.js';
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
  if (request.method !== 'GET') return authError(request, config, 'METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  const now = readNow(env);
  const stateInput = buildOAuthStateInput(new URL(request.url), config, now);
  if (!stateInput) return authError(request, config, 'OAUTH_AUTHORIZE_INVALID', 'OAuth authorize request is invalid.', 400);

  if (stateInput.cliLoginId) {
    let cliLogin;
    try {
      cliLogin = await readCliLoginRecordForAuthorize(env, { loginId: stateInput.cliLoginId }, { now });
    } catch {
      return authError(request, config, 'CLI_LOGIN_INVALID', 'CLI login request is invalid.', 400);
    }
    if (cliLogin.environment !== config.environment) {
      return authError(request, config, 'CLI_LOGIN_ENV_MISMATCH', 'CLI login environment does not match.', 403);
    }
    stateInput.deviceCode = cliLogin.deviceCode;
  }

  const sessionRedirect = await tryAuthorizeSiteFromAuthSession(request, env, config, stateInput, now);
  if (sessionRedirect) return sessionRedirect;

  if (!config.ssoAuthorizationUrl || !config.ssoClientId) {
    return authError(request, config, 'SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }

  let created;
  try {
    created = await createOAuthStateRecord(env, stateInput);
  } catch {
    return authError(request, config, 'OAUTH_AUTHORIZE_INVALID', 'OAuth authorize request is invalid.', 400);
  }

  try {
    return safeRedirect(buildSsoAuthorizeUrl(config, created.publicState), 302);
  } catch {
    return authError(request, config, 'SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }
}

export async function handleOAuthCallback(request, env, config) {
  if (request.method !== 'GET') return authError(request, config, 'METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  const url = new URL(request.url);
  const code = requiredQuery(url, 'code');
  const publicState = requiredQuery(url, 'state');
  if (!code || !publicState) {
    return authError(request, config, 'OAUTH_CALLBACK_INVALID', 'OAuth callback request is invalid.', 400);
  }

  if (!ssoExchangeIsConfigured(env, config)) {
    return authError(request, config, 'SSO_PROVIDER_UNCONFIGURED', 'SSO provider is not configured.', 503);
  }

  const now = readNow(env);
  let consumedState;
  try {
    consumedState = await consumeOAuthStateRecord(env, publicState, { now, environment: config.environment });
  } catch (error) {
    return authError(request, config, 'OAUTH_STATE_INVALID', 'OAuth state is invalid.', statusForStateError(error));
  }

  let profile;
  try {
    const token = await fetchSsoToken(env, config, { code });
    const accessToken = normalizeAccessToken(token);
    const rawProfile = await fetchSsoProfile(env, config, { accessToken });
    profile = normalizeSsoProfile(rawProfile);
  } catch {
    return authError(request, config, 'SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502);
  }

  if (!profile.userId) return authError(request, config, 'SSO_PROFILE_INVALID', 'SSO profile is invalid.', 502);

  let authoritativeProfile;
  try {
    authoritativeProfile = mergeSyncedUserAuthority(profile, await syncSsoUserProfile(env, profile, now));
  } catch {
    return authError(request, config, 'SSO_USER_SYNC_FAILED', 'SSO user could not be synced.', 502);
  }

  if (authoritativeProfile.employeeStatus !== ACTIVE_EMPLOYEE_STATUS) {
    return authError(request, config, 'SSO_PROFILE_INACTIVE', 'SSO profile is not active.', 403);
  }

  let authSession;
  try {
    authSession = await createAuthSession(env, config, authoritativeProfile.userId, now);
  } catch {
    return authError(request, config, 'AUTH_SESSION_CREATE_FAILED', 'Auth session could not be created.', 500);
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
      return authError(
        request,
        config,
        'CLI_LOGIN_CONFIRM_CREATE_FAILED',
        'CLI login confirmation could not be created.',
        500
      );
    }

    const response = new Response(
      buildCliLoginConfirmationHtml(consumedState.cliLoginId, consumedState.deviceCode, config, confirmToken),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'same-origin',
        },
      }
    );
    response.headers.set(
      'Set-Cookie',
      buildAuthSessionCookie(authSession.token, { maxAgeSeconds: config.authSessionIdleTtlSeconds })
    );
    return response;
  }

  try {
    const response = await createSiteCodeRedirectResponse(env, consumedState, authoritativeProfile, now);
    response.headers.set(
      'Set-Cookie',
      buildAuthSessionCookie(authSession.token, { maxAgeSeconds: config.authSessionIdleTtlSeconds })
    );
    return response;
  } catch {
    return authError(request, config, 'AUTH_SESSION_CREATE_FAILED', 'Auth session could not be created.', 500);
  }
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
  const recoveryAttempt = requiredQuery(url, 'auth_recovery') === '1';
  return {
    environment: config.environment,
    siteHost,
    returnTo,
    ...(recoveryAttempt ? { recoveryAttempt: true } : {}),
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

async function readCliLoginRecordForAuthorize(env, input, options) {
  if (typeof env?.readCliLoginRecordForAuthorize === 'function') {
    return env.readCliLoginRecordForAuthorize(input, options);
  }

  const stub = getCliLoginStub(env, input.loginId);
  const response = await stub.fetch(
    jsonDoRequest('https://cli-login-do/read-for-authorize', {
      loginId: input.loginId,
      now: options.now,
    })
  );
  if (!response.ok) throw new Error('CLI login invalid');
  return response.json();
}

function getCliLoginStub(env, loginId) {
  if (!env?.CLI_LOGINS) throw new Error('CLI login Durable Object binding is missing');
  return env.CLI_LOGINS.get(env.CLI_LOGINS.idFromName(loginId));
}

async function createOAuthSiteCodeRecord(env, input) {
  if (typeof env?.createOAuthSiteCodeRecord === 'function') return env.createOAuthSiteCodeRecord(input);

  const stub = getOAuthStateStub(env, input.stateId);
  const response = await stub.fetch(jsonDoRequest('https://oauth-state-do/create-site-code', input));
  if (!response.ok) throw new Error('OAuth site code create failed');
  return response.json();
}

async function tryAuthorizeSiteFromAuthSession(request, env, config, stateInput, now) {
  if (stateInput.cliLoginId) return null;

  const user = await readAuthSessionUserProfile(request, env, now);
  if (!user || user.employeeStatus !== ACTIVE_EMPLOYEE_STATUS) return null;

  let created;
  let consumedState;
  try {
    created = await createOAuthStateRecord(env, stateInput);
    consumedState = await consumeOAuthStateRecord(env, created.publicState, { now, environment: config.environment });
    return createSiteCodeRedirectResponse(env, consumedState, user, now);
  } catch {
    return null;
  }
}

async function createSiteCodeRedirectResponse(env, consumedState, profile, now) {
  const siteCode = await createOAuthSiteCodeRecord(env, {
    stateId: consumedState.record.id,
    user: siteCodeUserFromProfile(profile),
    now,
    ttlSeconds: SITE_CODE_TTL_SECONDS,
    codeSecret: createOpaqueToken('sec'),
  });
  return safeRedirect(
    buildSiteCallbackUrl(consumedState.siteHost, siteCode.siteCode, consumedState.returnTo, {
      recoveryAttempt: consumedState.recoveryAttempt,
    }),
    302
  );
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

async function readAuthSessionUserProfile(request, env, now) {
  const token = readCookie(request.headers.get('Cookie'), AUTH_SESSION_COOKIE);
  if (!token) return null;

  let payload;
  try {
    payload = await verifySessionJwt(token, env, {
      purpose: 'auth_session',
      audience: AUTH_SESSION_AUDIENCE,
      now,
    });
  } catch {
    return null;
  }

  const userId = payload.sub;
  let user;
  try {
    user =
      typeof env?.getUserForAuthSession === 'function'
        ? await env.getUserForAuthSession(userId)
        : await createPagesStore(env).getUser(userId);
  } catch {
    return null;
  }
  if (!user) return null;

  return {
    userId: user.userId || user.id || userId,
    email: user.email || '',
    employeeStatus: user.employeeStatus || 'unknown',
    departments: Array.isArray(user.departments) ? user.departments : [],
    sessionVersion: user.sessionVersion || 1,
  };
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

function buildSiteCallbackUrl(siteHost, siteCode, returnTo, { recoveryAttempt = false } = {}) {
  const url = new URL(`https://${siteHost}/.xd-pages/auth/callback`);
  url.searchParams.set('code', siteCode);
  if (returnTo) url.searchParams.set('return_to', returnTo);
  if (recoveryAttempt) url.searchParams.set('auth_recovery', '1');
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

function authError(request, config, code, message, status, action) {
  if (!wantsHtml(request)) return jsonError(code, message, status, action);
  return browserPageResponse({
    title: '登录没有完成',
    message: '这次登录链接可能已经过期或已经使用过。重新打开站点或重新执行登录操作即可再次验证。',
    detail: `状态详情：${code}`,
    status,
    actionHref: `${config.authBase}/.xd-pages/auth/authorize`,
    actionLabel: '重新验证',
    statusLabel: '需要重新验证',
    tone: 'danger',
  });
}

function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    if (trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1);
  }
  return '';
}

function buildCliLoginConfirmationHtml(loginId, deviceCode, config, confirmToken) {
  const safeLoginId = htmlEscape(loginId);
  const safeDeviceCode = htmlEscape(deviceCode);
  const safeConfirmToken = htmlEscape(confirmToken);
  const safeEnvironment = htmlEscape(config.environment);
  const safeAuthBase = htmlEscape(config.authBase);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>XD Pages CLI 登录确认</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fff7ef;
      --panel: #fffdf9;
      --text: #261711;
      --muted: #735a49;
      --line: #ead8c8;
      --line-strong: #e7c6ad;
      --brand: #f37022;
      --brand-dark: #c44f12;
      --orange-soft: #f59e0b;
      --shadow: 0 24px 70px rgba(95, 52, 25, 0.14);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
      background:
        radial-gradient(circle at 18% 12%, rgba(243, 112, 34, 0.16), transparent 30%),
        radial-gradient(circle at 82% 8%, rgba(245, 158, 11, 0.1), transparent 28%),
        linear-gradient(135deg, #fff8f1 0%, #fffdf9 48%, #fff3e7 100%);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(560px, 100%);
      border: 1px solid rgba(231, 198, 173, 0.92);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .header {
      padding: 28px 30px 22px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(135deg, rgba(243, 112, 34, 0.12), rgba(245, 158, 11, 0.09)),
        var(--panel);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #3a2a22;
      font-size: 13px;
      font-weight: 700;
    }
    .mark {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      color: #fff;
      background: linear-gradient(135deg, var(--brand), var(--orange-soft));
      font-size: 13px;
      line-height: 1;
      box-shadow: 0 10px 24px rgba(243, 112, 34, 0.24);
    }
    h1 {
      margin: 22px 0 10px;
      font-size: 27px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.72;
    }
    .body {
      padding: 24px 30px 30px;
    }
    .code-label {
      margin: 0 0 8px;
      color: #634b3b;
      font-size: 13px;
      font-weight: 700;
    }
    .device-code {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 18px 18px;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      background: #fffaf6;
    }
    .digits {
      color: #261711;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: clamp(28px, 8vw, 42px);
      font-weight: 800;
      line-height: 1;
      letter-spacing: 0;
      word-break: break-all;
    }
    .status {
      flex: 0 0 auto;
      padding: 7px 10px;
      border-radius: 999px;
      background: rgba(243, 112, 34, 0.12);
      color: var(--brand-dark);
      font-size: 12px;
      font-weight: 750;
    }
    .hint {
      margin-top: 14px;
      padding: 13px 14px;
      border: 1px solid #fed7aa;
      border-radius: 12px;
      background: #fff7ed;
      color: #8a3c12;
      font-size: 14px;
      line-height: 1.65;
    }
    dl {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 10px 12px;
      margin: 20px 0 0;
      padding: 16px 0 0;
      border-top: 1px solid var(--line);
    }
    dt {
      color: #8a7464;
      font-size: 13px;
      font-weight: 650;
    }
    dd {
      min-width: 0;
      margin: 0;
      color: #4c382d;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    form {
      margin-top: 22px;
    }
    button {
      width: 100%;
      min-height: 46px;
      border: 0;
      border-radius: 12px;
      color: #fff;
      background: linear-gradient(135deg, var(--brand), var(--orange-soft));
      box-shadow: 0 14px 34px rgba(243, 112, 34, 0.23);
      cursor: pointer;
      font: inherit;
      font-size: 15px;
      font-weight: 750;
    }
    button:focus-visible {
      outline: 3px solid rgba(243, 112, 34, 0.28);
      outline-offset: 3px;
    }
    @media (max-width: 520px) {
      body { padding: 18px 12px; }
      main { border-radius: 14px; }
      .header, .body { padding-left: 20px; padding-right: 20px; }
      h1 { font-size: 23px; }
      .device-code {
        align-items: flex-start;
        flex-direction: column;
      }
      dl { grid-template-columns: 1fr; gap: 4px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="header">
      <div class="brand"><span class="mark">XD</span><span>XD Pages</span></div>
      <h1>XD Pages CLI 登录确认</h1>
      <p>请确认浏览器中的设备码和终端里显示的一致。确认后，这个终端会获得当前账号的 XD Pages CLI 访问权限。</p>
    </section>
    <section class="body">
      <p class="code-label">设备码</p>
      <div class="device-code" aria-label="设备码 ${safeDeviceCode}">
        <span class="digits">${safeDeviceCode}</span>
        <span class="status">等待确认</span>
      </div>
      <p class="hint">如果终端里的设备码不同，或者你没有发起 <code>pages login</code>，请直接关闭此页面。</p>
      <dl>
        <dt>环境</dt>
        <dd>${safeEnvironment}</dd>
        <dt>认证服务</dt>
        <dd>${safeAuthBase}</dd>
        <dt>授权范围</dt>
        <dd>cli_token</dd>
      </dl>
      <form method="post" action="/.xd-pages/cli/login/confirm" autocomplete="off">
        <input type="hidden" name="loginId" value="${safeLoginId}">
        <input type="hidden" name="confirmToken" value="${safeConfirmToken}">
        <input type="hidden" name="deviceCode" value="${safeDeviceCode}">
        <button type="submit">确认授权</button>
      </form>
    </section>
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
    email: normalizeProfileEmail(profile),
    realname: normalizeOptionalString(profile?.realname ?? profile?.name) || null,
    account: normalizeOptionalString(profile?.account) || null,
    accountId: normalizeOptionalString(profile?.accountId ?? profile?.account_id) || null,
    employeenum: normalizeOptionalString(profile?.employeenum ?? profile?.employeeNum ?? profile?.employee_num) || null,
    employeeStatus: normalizeEmployeeStatus(profile?.employeeStatus ?? profile?.employee_status),
    departments: normalizeDepartments(profile?.departments ?? profile?.departmentIds ?? profile?.department_ids),
    sessionVersion: normalizeSessionVersion(profile?.sessionVersion ?? profile?.session_version),
  };
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

function normalizeProfileEmail(profile) {
  for (const value of [profile?.email, profile?.fs_email, profile?.account, profile?.id, profile?.sub]) {
    const normalized = normalizeOptionalString(value).toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return normalized;
  }
  return '';
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
