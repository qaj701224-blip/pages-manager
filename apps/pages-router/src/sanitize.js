const PLATFORM_HEADER_PREFIXES = ['cf-platform-', 'x-pages-', 'x-xd-pages-'];
const PLATFORM_COOKIE_PREFIXES = ['__Host-pages_', '__Secure-pages_'];
const COOKIE_DOMAIN_ATTRIBUTE_RE = /;\s*domain\s*=/i;

export function sanitizeRequestForUserWorker(request, platformHeaders = {}) {
  const headers = new Headers(request.headers);

  for (const name of [...headers.keys()]) {
    if (isPlatformHeader(name)) headers.delete(name);
  }

  const cookie = sanitizeCookieHeader(headers.get('Cookie'));
  if (cookie) {
    headers.set('Cookie', cookie);
  } else {
    headers.delete('Cookie');
  }

  for (const [name, value] of Object.entries(platformHeaders)) {
    headers.set(name, value);
  }

  return new Request(request, { headers });
}

export function sanitizeUserWorkerResponse(response) {
  const headers = new Headers(response.headers);
  const setCookies = getSetCookies(headers);

  for (const name of [...headers.keys()]) {
    if (isPlatformHeader(name) || name.toLowerCase() === 'set-cookie') headers.delete(name);
  }

  for (const setCookie of setCookies.filter(isAllowedSetCookie)) {
    headers.append('Set-Cookie', setCookie);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sanitizeCookieHeader(value) {
  if (!value) return '';

  const kept = [];
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;

    const [name] = trimmed.split('=', 1);
    if (isPlatformCookieName(name)) continue;
    kept.push(trimmed);
  }

  return kept.join('; ');
}

function isAllowedSetCookie(value) {
  const name = String(value || '').split('=', 1)[0];
  if (isPlatformCookieName(name)) return false;
  if (COOKIE_DOMAIN_ATTRIBUTE_RE.test(value)) return false;
  return true;
}

function isPlatformHeader(name) {
  const lower = String(name || '').toLowerCase();
  return PLATFORM_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isPlatformCookieName(name) {
  return PLATFORM_COOKIE_PREFIXES.some((prefix) => String(name || '').startsWith(prefix));
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('Set-Cookie');
  return value ? [value] : [];
}
