import { classifyHost } from '../../pages-router/src/host.js';

export const AUTH_SESSION_COOKIE = '__Host-pages_auth_session';
export const SITE_SESSION_COOKIE = '__Host-pages_site_session';

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
  return false;
}

export function isSiteSessionHost(hostname, environment) {
  const classified = classifyHost(hostname, { environment });
  return classified.ok;
}

function buildSessionCookie(name, value, maxAgeSeconds) {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('Cookie Max-Age must be a non-negative integer');
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}
