import { createOpaqueToken } from './id.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { signSessionJwt } from './jwt.js';

const CLI_TOKEN_AUDIENCE = 'pages-cli';
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

  const loginId = requireString(body.loginId);
  const loginSecret = requireString(body.loginSecret);
  if (!loginId || !loginSecret) return jsonError('CLI_LOGIN_INVALID', 'CLI login request is invalid.', 400);

  const now = readNow(env);
  let consumed;
  try {
    consumed = await pollCliLoginRecord(env, { loginId, loginSecret }, { now });
  } catch (error) {
    return handleCliPollError(error);
  }

  if (consumed?.status === 'pending') return jsonOk({ status: 'pending' });
  if (consumed?.environment !== config.environment) {
    return jsonError('CLI_LOGIN_ENV_MISMATCH', 'CLI login environment does not match.', 403);
  }

  const cliToken = await signSessionJwt(
    {
      purpose: 'cli_token',
      audience: CLI_TOKEN_AUDIENCE,
      subject: consumed.userId,
      now,
      ttlSeconds: config.authSessionAbsoluteTtlSeconds,
      claims: {
        jti: consumed.record?.id || loginId,
      },
    },
    env
  );

  return jsonOk({
    status: 'confirmed',
    tokenType: 'Bearer',
    cliToken,
    expiresAt: now + config.authSessionAbsoluteTtlSeconds,
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

async function pollCliLoginRecord(env, input, options) {
  if (typeof env?.pollCliLoginRecord === 'function') return env.pollCliLoginRecord(input, options);
  if (typeof env?.consumeCliLoginRecord === 'function') return env.consumeCliLoginRecord(input, options);

  const stub = getCliLoginStub(env, input.loginId);
  const response = await stub.fetch(jsonDoRequest('https://cli-login-do/poll', { ...input, now: options.now }));
  if (response.status === 409) throw new Error('CLI login invalid: already consumed');
  if (!response.ok) throw new Error('CLI login invalid');
  return response.json();
}

function getCliLoginStub(env, loginId) {
  if (!env?.CLI_LOGINS) throw new Error('CLI login Durable Object binding is missing');
  const id = env.CLI_LOGINS.idFromName(loginId);
  return env.CLI_LOGINS.get(id);
}

function jsonDoRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
