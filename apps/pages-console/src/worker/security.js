import { isAllowedIP } from '@xd/ip-guard';

const ALLOWED_HOSTS = new Set(['workers.xd.team', 'staging.workers.xd.team']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function jsonError(code, message, status = 403) {
  return Response.json(
    {
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return rawValue.join('=');
  }
  return '';
}

function isSameOrigin(value, origin) {
  if (!value) return false;
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

export function isAllowedConsoleHost(url) {
  return ALLOWED_HOSTS.has(url.hostname);
}

export function assertConsoleNetworkAllowed(request, env = {}) {
  const url = new URL(request.url);
  if (!isAllowedConsoleHost(url)) {
    return jsonError('HOST_DENIED', 'Console host is not allowed.');
  }

  const clientIP = request.headers.get('CF-Connecting-IP');
  if (!isAllowedIP(clientIP, env.IP_ALLOWLIST)) {
    return jsonError('IP_DENIED', 'Console access is limited to the company network.');
  }

  return null;
}

export function isWriteMethod(method) {
  return !SAFE_METHODS.has(String(method || '').toUpperCase());
}

export async function assertSafeWriteRequest(request) {
  if (!isWriteMethod(request.method)) return null;

  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  const csrfCookie = getCookie(request, '__Host-xd_cell_csrf');
  const csrfHeader = request.headers.get('X-CSRF-Token') || '';

  const sameOrigin = isSameOrigin(origin, url.origin) || (!origin && isSameOrigin(referer, url.origin));
  if (!sameOrigin || !csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return jsonError('CSRF_ORIGIN_INVALID', 'Write request failed CSRF or origin validation.');
  }

  return null;
}
