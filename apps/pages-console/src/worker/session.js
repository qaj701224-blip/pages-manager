import { signSessionJwt, verifySessionJwt } from '@xd/session-kit';

const SESSION_COOKIE = '__Host-xd_cell_session';
const CSRF_COOKIE = '__Host-xd_cell_csrf';
const CONSOLE_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CONSOLE_SESSION_TTL_SECONDS = CONSOLE_SESSION_MAX_AGE_SECONDS;

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return rawValue.join('=');
  }
  return '';
}

export function serializeConsoleSessionCookie(token) {
  const value = encodeURIComponent(String(token || ''));
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${CONSOLE_SESSION_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export async function signConsoleSession(session, env = {}, audience) {
  const userId = session?.userId ? String(session.userId) : '';
  if (!userId) throw new Error('Console session user id is missing');
  return signSessionJwt(
    {
      purpose: 'console_session',
      audience,
      subject: userId,
      now: readNow(env),
      ttlSeconds: CONSOLE_SESSION_TTL_SECONDS,
      claims: {
        email: typeof session.email === 'string' ? session.email : '',
        employeeStatus: typeof session.employeeStatus === 'string' ? session.employeeStatus : '',
        sessionVersion: session.sessionVersion || 1,
      },
    },
    env
  );
}

export async function readConsoleSession(request, env = {}) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const audience = new URL(request.url).hostname;

  let payload;
  try {
    payload = await verifySessionJwt(decodeURIComponent(token), env, {
      purpose: 'console_session',
      audience,
      now: readNow(env),
    });
  } catch {
    return null;
  }

  const sessionVersion = Number(payload.sessionVersion);
  return {
    userId: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email : '',
    employeeStatus: typeof payload.employeeStatus === 'string' ? payload.employeeStatus : '',
    isPlatformAdmin: payload.isPlatformAdmin === true,
    sessionVersion: Number.isInteger(sessionVersion) && sessionVersion > 0 ? sessionVersion : 1,
    expiresAt: Number(payload.exp) * 1000,
  };
}

export function clearConsoleSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function serializeConsoleCsrfCookie(token = createCsrfToken()) {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; Secure; SameSite=Lax`;
}

export function clearConsoleCsrfCookie() {
  return `${CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}

function createCsrfToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function readNow(env = {}) {
  if (typeof env.now === 'function') {
    const value = env.now();
    if (Number.isInteger(value)) return value;
  }
  return Math.floor(Date.now() / 1000);
}
