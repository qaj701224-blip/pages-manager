import { callPagesApiConsole, validateConsoleSession } from './pages-api-client.js';
import { createConsoleLogin, exchangeConsoleCode, normalizeConsoleReturnTo } from './pages-auth-client.js';
import { assertConsoleNetworkAllowed, assertSafeWriteRequest } from './security.js';
import {
  clearConsoleCsrfCookie,
  clearConsoleSessionCookie,
  readConsoleSession,
  serializeConsoleCsrfCookie,
  serializeConsoleSessionCookie,
} from './session.js';

function jsonError(code, message, status = 404, action = 'Check the endpoint and try again.') {
  return Response.json(
    {
      error: {
        code,
        message,
        action,
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

function jsonErrorResponse(code, message, status, init = {}) {
  const response = jsonError(code, message, status);
  for (const [key, value] of Object.entries(init.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) response.headers.append(key, item);
    } else {
      response.headers.set(key, value);
    }
  }
  return response;
}

async function getSession(request, env) {
  const configError = validateConsoleSessionJwtConfig(env);
  if (configError) return { error: configError };

  const signedSession = await readConsoleSession(request, env);
  if (!signedSession) return null;
  return validateConsoleSession(env, signedSession);
}

function validateConsoleSessionJwtConfig(env = {}) {
  const registry = typeof env.PAGES_SESSION_JWT_KEYS === 'string' ? env.PAGES_SESSION_JWT_KEYS.trim() : '';
  if (!registry) {
    return jsonError(
      'CONSOLE_SESSION_JWT_CONFIG_MISSING',
      'Console session JWT config is missing.',
      500,
      'Configure PAGES_SESSION_JWT_KEYS.'
    );
  }
  for (const rawEntry of registry.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parts = entry.split(':').map((part) => part.trim());
    const secretName = parts[2];
    if (!secretName || typeof env[secretName] !== 'string' || !env[secretName]) {
      return jsonError(
        'CONSOLE_SESSION_JWT_CONFIG_MISSING',
        'Console session JWT secret is missing.',
        500,
        'Configure the PAGES_SESSION_JWT_SECRET_* bindings referenced by PAGES_SESSION_JWT_KEYS.'
      );
    }
  }
  return null;
}

function isStagingHost(url) {
  return url.hostname === 'staging.workers.xd.team';
}

function isAuthBridgePath(pathname) {
  return pathname === '/api/console/auth/login' || pathname === '/api/console/auth/callback';
}

function isPublicConsoleShellPath(pathname) {
  return pathname === '/login' || pathname.startsWith('/assets/');
}

function requiresWorkspaceSession(pathname) {
  return pathname === '/workspace' || pathname.startsWith('/workspace/');
}

function requiresAdminSession(url) {
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return true;
  return isStagingHost(url) && !isAuthBridgePath(url.pathname) && !isPublicConsoleShellPath(url.pathname);
}

function redirect(location, headers = {}) {
  const nextHeaders = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
  });
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) nextHeaders.append(key, item);
    } else {
      nextHeaders.set(key, value);
    }
  }
  return new Response(null, {
    status: 302,
    headers: nextHeaders,
  });
}

function wantsHtml(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html') || accept === '' || accept.includes('*/*');
}

function wantsBrowserNavigation(request) {
  return (request.headers.get('Accept') || '').includes('text/html');
}

function buildLoginLocation(url) {
  const returnTo = `${url.pathname}${url.search}`;
  const login = new URL('/login', url.origin);
  login.searchParams.set('returnTo', returnTo);
  return `${login.pathname}${login.search}`;
}

async function handleAuthLogin(url, env) {
  const { authorizeUrl } = await createConsoleLogin(env, url.searchParams.get('returnTo') || '/');
  return redirect(authorizeUrl);
}

async function handleAuthCallback(url, env) {
  const exchanged = await exchangeConsoleCode(env, url.searchParams.get('code') || '');
  if (isStagingHost(url) && !exchanged.isPlatformAdmin) {
    return jsonErrorResponse('ADMIN_REQUIRED', 'Platform administrator access is required.', 403, {
      headers: { 'Set-Cookie': [clearConsoleSessionCookie(), clearConsoleCsrfCookie()] },
    });
  }
  if (!exchanged.consoleSessionToken) {
    return jsonError(
      'CONSOLE_SESSION_TOKEN_MISSING',
      'Console session token is missing.',
      500,
      'Check pages-auth console exchange configuration.'
    );
  }

  const cookie = serializeConsoleSessionCookie(exchanged.consoleSessionToken);
  return redirect(normalizeConsoleReturnTo(exchanged.returnTo), {
    'Set-Cookie': [cookie, serializeConsoleCsrfCookie()],
  });
}

function handleLogout(url, env) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Location: buildAuthLogoutLocation(url, env),
  });
  headers.append('Set-Cookie', clearConsoleSessionCookie());
  headers.append('Set-Cookie', clearConsoleCsrfCookie());
  return new Response(null, {
    status: 302,
    headers,
  });
}

function buildAuthLogoutLocation(url, env) {
  const authBase = normalizeOrigin(env.PUBLIC_AUTH_BASE) || defaultAuthBase(url, env);
  const consoleBase = normalizeOrigin(env.PUBLIC_CONSOLE_BASE) || url.origin;
  const returnTo = new URL('/login', consoleBase);
  returnTo.searchParams.set('loggedOut', '1');

  const logout = new URL('/.xd-pages/auth/logout', authBase);
  logout.searchParams.set('return_to', returnTo.href);
  return logout.href;
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.origin;
  } catch {
    return '';
  }
  return '';
}

function defaultAuthBase(url, env) {
  if (env.PAGES_ENV === 'staging' || url.hostname === 'staging.workers.xd.team') return 'https://auth-staging.pages.xd.team';
  return 'https://auth.pages.xd.team';
}

function handleSession(session) {
  if (!session) {
    return Response.json(
      {
        authenticated: false,
        user: null,
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }

  return Response.json(
    {
      authenticated: true,
      user: {
        userId: session.userId,
        email: session.email || '',
        isPlatformAdmin: Boolean(session.isPlatformAdmin),
      },
    },
    {
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}

function isPagesApiProxyPath(pathname) {
  if (pathname === '/api/console/directory') return true;
  if (pathname === '/api/console/workspace/sites') return true;
  if (pathname === '/api/console/access-keys' || pathname.startsWith('/api/console/access-keys/')) return true;
  if (/^\/api\/console\/teams\/[^/]+\/access-keys(?:\/[^/]+)?$/.test(pathname)) return true;
  if (pathname === '/api/console/teams' || pathname.startsWith('/api/console/teams/')) return true;
  if (pathname === '/api/console/admin' || pathname.startsWith('/api/console/admin/')) return true;
  if (/^\/api\/console\/sites\/[^/]+(?:\/(?:deployments|access|config))?$/.test(pathname)) return true;
  return /^\/api\/console\/sites\/[^/]+\/config\/(?:vars|secrets)\/[^/]+$/.test(pathname);
}

async function serveAsset(request, env) {
  let response;
  if (env?.ASSETS && typeof env.ASSETS.fetch === 'function') {
    response = await env.ASSETS.fetch(request);
  } else {
    response = new Response('<!doctype html><div id="root"></div>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return withCsrfCookieForHtml(response);
}

function withCsrfCookieForHtml(response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) return response;
  const next = new Response(response.body, response);
  next.headers.append('Set-Cookie', serializeConsoleCsrfCookie());
  return next;
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);

    const networkDenied = assertConsoleNetworkAllowed(request, env);
    if (networkDenied) return networkDenied;

    if (url.pathname.startsWith('/api/console/')) {
      const unsafeWrite = await assertSafeWriteRequest(request);
      if (unsafeWrite) return unsafeWrite;
    }

    if (url.pathname === '/api/console/auth/login') return handleAuthLogin(url, env);
    if (url.pathname === '/api/console/auth/callback') return handleAuthCallback(url, env);
    if (url.pathname === '/api/console/auth/logout') return handleLogout(url, env);
    if (url.pathname === '/api/console/auth/session') {
      const session = await getSession(request, env);
      if (session?.error) return session.error;
      return handleSession(session);
    }

    if (requiresAdminSession(url)) {
      const session = await getSession(request, env);
      if (session?.error) return session.error;
      if (!session) {
        if (wantsBrowserNavigation(request)) return redirect(buildLoginLocation(url));
        return jsonError('SESSION_REQUIRED', 'Login is required.', 401, 'Sign in and try again.');
      }
      if (!session?.isPlatformAdmin) {
        if (wantsBrowserNavigation(request)) return serveAsset(request, env);
        return jsonError('ADMIN_REQUIRED', 'Platform administrator access is required.', 403, 'Use an admin account.');
      }
    }

    if (isPagesApiProxyPath(url.pathname)) {
      const session = await getSession(request, env);
      if (session?.error) return session.error;
      return callPagesApiConsole(env, request, { session });
    }

    if (requiresWorkspaceSession(url.pathname)) {
      const session = await getSession(request, env);
      if (session?.error) return session.error;
      if (!session) {
        if (wantsHtml(request)) return redirect(buildLoginLocation(url));
        return jsonError('SESSION_REQUIRED', 'Login is required.', 401, 'Sign in and try again.');
      }
    }

    if (url.pathname.startsWith('/api/console/')) {
      return jsonError('NOT_FOUND', 'Console API endpoint was not found.');
    }

    return serveAsset(request, env);
  },
};
