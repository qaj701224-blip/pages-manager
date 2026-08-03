import { classifyHost } from '@xd/pages-runtime-protocol';

export const AUTH_SESSION_COOKIE = '__Host-pages_auth_session';
export const SITE_SESSION_COOKIE = '__Host-pages_site_session';

const SAFE_SESSION_COOKIE_VALUE = /^[A-Za-z0-9._~-]+$/;

export function buildAuthSessionCookie(token, { maxAgeSeconds }) {
  return buildSessionCookie(AUTH_SESSION_COOKIE, token, maxAgeSeconds);
}

export function buildSiteSessionCookie(token, { maxAgeSeconds }) {
  return buildSessionCookie(SITE_SESSION_COOKIE, token, maxAgeSeconds);
}

export function buildClearAuthSessionCookie() {
  return buildSessionCookie(AUTH_SESSION_COOKIE, '', 0);
}

export function buildClearSiteSessionCookie() {
  return buildSessionCookie(SITE_SESSION_COOKIE, '', 0);
}

export function isAuthSessionHost(hostname, environment) {
  if (environment === 'production') return hostname === 'auth.pages.xd.team';
  if (environment === 'staging') return hostname === 'auth-staging.pages.xd.team';
  if (environment === 'local') return hostname === 'xd-pages.127.0.0.1.nip.io';
  return false;
}

export function isSiteSessionHost(hostname, environment) {
  const classified = classifyHost(hostname, { environment });
  return classified.ok;
}

function buildSessionCookie(name, value, maxAgeSeconds) {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('Cookie Max-Age must be a non-negative integer');
  if (value !== '' && !SAFE_SESSION_COOKIE_VALUE.test(value)) throw new Error('Cookie value contains unsafe characters');
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    if (trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1);
  }
  return '';
}
