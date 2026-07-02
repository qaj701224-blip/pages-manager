import { verifySessionJwt } from '../../../pages-auth/src/jwt.js';

const SESSION_COOKIE = 'xd_cell_session';
const CSRF_COOKIE = 'xd_cell_csrf';
const CONSOLE_SESSION_AUDIENCE = 'xd-cell-console';

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
  return `${SESSION_COOKIE}=${encodeURIComponent(String(token || ''))}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function readConsoleSession(request, env = {}) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;

  let payload;
  try {
    payload = await verifySessionJwt(decodeURIComponent(token), env, {
      purpose: 'console_session',
      audience: CONSOLE_SESSION_AUDIENCE,
      now: readNow(env),
    });
  } catch {
    return null;
  }

  const sessionVersion = Number(payload.sessionVersion);
  return {
    userId: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email : '',
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
