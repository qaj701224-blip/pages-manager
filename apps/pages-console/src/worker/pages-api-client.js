const INTERNAL_API_BASE = 'https://pages-api.internal';
const BFF_PATH_PREFIX = '/api/console';
const INTERNAL_PATH_PREFIX = '/.xd-pages/api/console';

export async function callPagesApiConsole(env, request, { session, path, requireAdmin = false } = {}) {
  if (!env?.PAGES_API || typeof env.PAGES_API.fetch !== 'function') {
    throw new Error('PAGES_API binding is missing');
  }

  const incomingUrl = new URL(request.url);
  const internalPath = normalizeConsoleApiPath(path || incomingUrl.pathname);
  const internalUrl = new URL(`${INTERNAL_API_BASE}${internalPath}`);
  internalUrl.search = incomingUrl.search;

  const headers = buildConsoleHeaders(session, { requireAdmin });

  const init = {
    method: request.method,
    headers,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);
    init.body = await request.arrayBuffer();
  }

  const response = await env.PAGES_API.fetch(new Request(internalUrl.toString(), init));

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.delete('Content-Length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function validateConsoleSession(env, session) {
  if (!session?.userId || !env?.PAGES_API || typeof env.PAGES_API.fetch !== 'function') return null;

  const response = await env.PAGES_API.fetch(
    new Request(`${INTERNAL_API_BASE}${INTERNAL_PATH_PREFIX}/auth/session`, {
      method: 'GET',
      headers: buildConsoleHeaders(session),
    })
  );
  if (!response.ok) return null;

  const payload = await response.json().catch(() => null);
  const current = payload?.session;
  if (!current?.userId) return null;

  const sessionVersion = Number(current.sessionVersion);
  return {
    ...session,
    userId: String(current.userId),
    email: typeof current.email === 'string' ? current.email : session.email || '',
    employeeStatus: typeof current.employeeStatus === 'string' ? current.employeeStatus : '',
    isPlatformAdmin: Boolean(current.isPlatformAdmin),
    sessionVersion: Number.isInteger(sessionVersion) && sessionVersion > 0 ? sessionVersion : session.sessionVersion,
  };
}

function normalizeConsoleApiPath(pathname) {
  if (!pathname.startsWith(BFF_PATH_PREFIX)) throw new Error('Console API path is invalid');
  return `${INTERNAL_PATH_PREFIX}${pathname.slice(BFF_PATH_PREFIX.length)}`;
}

function buildConsoleHeaders(session, { requireAdmin = false } = {}) {
  const headers = new Headers({
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
  });
  if (requireAdmin) headers.set('X-Console-Require-Admin', 'true');
  if (session?.userId) {
    headers.set('X-Console-User-Id', session.userId);
    if (session.email) headers.set('X-Console-Email', session.email);
    headers.set('X-Console-Session-Version', String(session.sessionVersion || 1));
  }
  return headers;
}
