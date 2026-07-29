import { browserPageResponse } from '@xd/browser-pages';
import { AUTH_SESSION_COOKIE, readCookie, signSessionJwt, verifySessionJwt } from '@xd/session-kit';

import { createOpaqueToken } from './id.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';

const AUTH_SESSION_AUDIENCE = 'pages-auth';
const CLI_TOKEN_AUDIENCE = 'pages-cli';
const CLI_LOGIN_CONFIRM_AUDIENCE = 'pages-cli-login-confirm';
const DEVICE_CODE_RE = /^[0-9]{8}$/;

export async function handleCliLoginStart(request, env, config) {
  if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  const now = readNow(env);
  const input = {
    environment: config.environment,
    now,
    ttlSeconds: config.cliLoginTtlSeconds,
    loginId: createOpaqueToken('cli'),
    loginSecret: createOpaqueToken('sec'),
    deviceCode: createDeviceCode(),
  };

  let created;
  try {
    created = await createCliLoginRecord(env, input);
  } catch {
    return jsonError('CLI_LOGIN_UNAVAILABLE', 'CLI login is unavailable.', 500);
  }

  return jsonOk({
    loginId: created.loginId,
    loginSecret: created.loginSecret,
    deviceCode: created.deviceCode,
    browserUrl: buildCliLoginBrowserUrl(config, created.loginId),
    expiresAt: created.record?.expiresAt || now + config.cliLoginTtlSeconds,
  });
}

export async function handleCliLoginPoll(request, env, config) {
  if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('CLI_LOGIN_INVALID', 'CLI login request is invalid.', 400);
  }

  const loginId = requireString(body.loginId);
  const loginSecret = requireString(body.loginSecret);
  if (!loginId || !loginSecret) return jsonError('CLI_LOGIN_INVALID', 'CLI login request is invalid.', 400);

  const now = readNow(env);
  let loginStatus;
  try {
    loginStatus = await peekCliLoginRecord(env, { loginId, loginSecret }, { now });
  } catch (error) {
    return handleCliPollError(error);
  }

  if (loginStatus?.status === 'pending') return jsonOk({ status: 'pending' });
  if (loginStatus?.environment !== config.environment) {
    return jsonError('CLI_LOGIN_ENV_MISMATCH', 'CLI login environment does not match.', 403);
  }

  let cliToken;
  try {
    cliToken = await signSessionJwt(
      {
        purpose: 'cli_token',
        audience: CLI_TOKEN_AUDIENCE,
        subject: loginStatus.userId,
        now,
        ttlSeconds: config.authSessionAbsoluteTtlSeconds,
        claims: {
          jti: loginStatus.record?.id || loginId,
        },
      },
      env
    );
  } catch {
    return jsonError('CLI_TOKEN_SIGN_FAILED', 'CLI token could not be signed.', 500);
  }

  let consumed;
  try {
    consumed = await consumeCliLoginRecord(env, { loginId, loginSecret }, { now });
  } catch (error) {
    return handleCliPollError(error);
  }
  if (consumed?.environment !== config.environment || consumed?.userId !== loginStatus.userId) {
    return jsonError('CLI_LOGIN_ENV_MISMATCH', 'CLI login environment does not match.', 403);
  }

  return jsonOk({
    status: 'confirmed',
    tokenType: 'Bearer',
    cliToken,
    expiresAt: now + config.authSessionAbsoluteTtlSeconds,
  });
}

export async function handleCliLoginConfirm(request, env, config) {
  if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  if (hasForbiddenConfirmationSource(request, config)) {
    return jsonError('CLI_LOGIN_CONFIRM_ORIGIN_FORBIDDEN', 'CLI login confirmation origin is not allowed.', 403);
  }

  let body;
  try {
    body = await readConfirmationBody(request);
  } catch {
    return jsonError('CLI_LOGIN_CONFIRM_INVALID', 'CLI login confirmation is invalid.', 400);
  }

  const loginId = requireString(body.loginId || body.cli_login_id);
  const deviceCode = requireString(body.deviceCode || body.device_code);
  const confirmToken = requireString(body.confirmToken || body.confirm_token || body.csrfToken || body.csrf_token);
  if (!loginId || !DEVICE_CODE_RE.test(deviceCode || '')) {
    return jsonError('CLI_LOGIN_CONFIRM_INVALID', 'CLI login confirmation is invalid.', 400);
  }

  const user = await readAuthSessionUser(request, env, config);
  if (!user) {
    return jsonError('AUTH_SESSION_REQUIRED', 'Login required before confirming CLI access.', 401, 'Restart `xd-cell login`.');
  }

  const confirmTokenOk = await verifyCliLoginConfirmToken(confirmToken, env, { loginId, user });
  if (!confirmTokenOk) {
    return jsonError('CLI_LOGIN_CONFIRM_TOKEN_FORBIDDEN', 'CLI login confirmation token is not allowed.', 403);
  }

  try {
    await confirmCliLoginRecord(env, { loginId, deviceCode, userId: user.userId }, { now: readNow(env) });
  } catch {
    return jsonError('CLI_LOGIN_CONFIRM_FAILED', 'CLI login could not be confirmed.', 400);
  }

  return browserPageResponse({
    title: 'CLI 登录已完成',
    message: '可以关闭这个浏览器页面，回到终端继续使用 XD Cell。',
    detail: '这次授权只会用于刚刚发起登录的终端窗口。',
    status: 200,
    statusLabel: '已授权',
    tone: 'success',
  });
}

export function buildCliLoginBrowserUrl(config, loginId) {
  const url = new URL('/.xd-pages/auth/authorize', config.authBase);
  url.searchParams.set('cli_login_id', loginId);
  return url.toString();
}

async function createCliLoginRecord(env, input) {
  if (typeof env?.createCliLoginRecord === 'function') return env.createCliLoginRecord(input);

  const stub = getCliLoginStub(env, input.loginId);
  const response = await stub.fetch(jsonDoRequest('https://cli-login-do/create', input));
  if (!response.ok) throw new Error('CLI login create failed');
  return response.json();
}

async function peekCliLoginRecord(env, input, options) {
  if (typeof env?.peekCliLoginRecord === 'function') return env.peekCliLoginRecord(input, options);
  if (typeof env?.pollCliLoginRecord === 'function') return env.pollCliLoginRecord(input, options);

  const stub = getCliLoginStub(env, input.loginId);
  const response = await stub.fetch(jsonDoRequest('https://cli-login-do/peek', { ...input, now: options.now }));
  if (response.status === 409) throw new Error('CLI login invalid: already consumed');
  if (!response.ok) throw new Error('CLI login invalid');
  return response.json();
}

async function consumeCliLoginRecord(env, input, options) {
  if (typeof env?.consumeCliLoginRecord === 'function') return env.consumeCliLoginRecord(input, options);

  const stub = getCliLoginStub(env, input.loginId);
  const response = await stub.fetch(jsonDoRequest('https://cli-login-do/consume', { ...input, now: options.now }));
  if (response.status === 409) throw new Error('CLI login invalid: already consumed');
  if (!response.ok) throw new Error('CLI login invalid');
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

function getCliLoginStub(env, loginId) {
  if (!env?.CLI_LOGINS) throw new Error('CLI login Durable Object binding is missing');
  const id = env.CLI_LOGINS.idFromName(loginId);
  return env.CLI_LOGINS.get(id);
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

async function readConfirmationBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.split(';', 1)[0].trim().toLowerCase() === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(await request.text());
    return Object.fromEntries(form.entries());
  }
  return readJsonBody(request);
}

async function readAuthSessionUser(request, env, config) {
  const token = readCookie(request.headers.get('Cookie'), AUTH_SESSION_COOKIE);
  if (!token) return null;

  try {
    const now = readNow(env);
    const payload = await verifySessionJwt(token, env, {
      purpose: 'auth_session',
      audience: AUTH_SESSION_AUDIENCE,
      now,
    });
    const sid = typeof payload.sid === 'string' ? payload.sid : '';
    if (!sid) return null;
    const record = await refreshAuthSessionRecord(env, {
      sid,
      now,
      idleTtlSeconds: config.authSessionIdleTtlSeconds,
    });
    if (record?.userId !== payload.sub || record?.purpose !== 'auth_session') return null;
    return { userId: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

async function refreshAuthSessionRecord(env, input) {
  if (typeof env?.refreshAuthSessionRecord === 'function') {
    return env.refreshAuthSessionRecord(input.sid, {
      now: input.now,
      idleTtlSeconds: input.idleTtlSeconds,
    });
  }

  const stub = getAuthSessionStub(env, input.sid);
  const response = await stub.fetch(jsonDoRequest('https://auth-session-do/refresh', input));
  if (!response.ok) throw new Error('Auth session refresh failed');
  return response.json();
}

async function verifyCliLoginConfirmToken(token, env, { loginId, user }) {
  if (!token) return false;
  try {
    const payload = await verifySessionJwt(token, env, {
      purpose: 'cli_login_confirm',
      audience: CLI_LOGIN_CONFIRM_AUDIENCE,
      now: readNow(env),
    });
    return payload.sub === user.userId && payload.loginId === loginId;
  } catch {
    return false;
  }
}

function hasForbiddenConfirmationSource(request, config) {
  const expectedOrigin = readOrigin(config?.authBase);
  if (!expectedOrigin) return true;

  const origin = request.headers.get('Origin');
  if (origin) return origin !== expectedOrigin;

  const referer = request.headers.get('Referer');
  if (referer) return readOrigin(referer) !== expectedOrigin;

  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite) return secFetchSite !== 'same-origin' && secFetchSite !== 'none';

  return false;
}

function readOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function handleCliPollError(error) {
  const message = error instanceof Error ? error.message : '';
  if (/still pending/.test(message)) return jsonOk({ status: 'pending' });
  if (/already consumed/.test(message)) return jsonError('CLI_LOGIN_CONSUMED', 'CLI login has already been consumed.', 409);
  if (/secret mismatch/.test(message)) return jsonError('CLI_LOGIN_INVALID', 'CLI login request is invalid.', 401);
  return jsonError('CLI_LOGIN_INVALID', 'CLI login request is invalid.', 400);
}

function requireString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  if (Number.isInteger(env?.now)) return env.now;
  return Math.floor(Date.now() / 1000);
}

function createDeviceCode() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const value = String(array[0] % 100_000_000).padStart(8, '0');
  if (!DEVICE_CODE_RE.test(value)) throw new Error('Generated CLI device code is invalid');
  return value;
}
