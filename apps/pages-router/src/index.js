import { isAllowedIP } from '@xd/ip-guard';
import { jsonResponse } from '@xd/worker-kit';

import { buildSiteSessionCookie } from '../../pages-auth/src/cookies.js';
import { signSessionJwt, verifySessionJwt } from '../../pages-auth/src/jwt.js';
import { evaluateAccessPolicy } from './access-policy.js';
import { classifyHost } from './host.js';
import { isPlatformPath } from './platform-path.js';
import { sanitizeRequestForUserWorker, sanitizeUserWorkerResponse } from './sanitize.js';

const VALID_ROUTER_ENVIRONMENTS = new Set(['production', 'staging']);
const SITE_SESSION_COOKIE = '__Host-pages_site_session';
const SITE_AUTH_CALLBACK_PATH = '/.xd-pages/auth/callback';
const DEFAULT_SITE_SESSION_TTL_SECONDS = 604_800;
const PRODUCTION_WORKER_PREFIX = 'pages-v2-';
const STAGING_WORKER_PREFIX = 'pages-v2-staging-';
const MAX_WORKER_NAME_LENGTH = 63;
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export default {
  async fetch(request, env) {
    const ipDecision = enforceIPAllowlist(request, env);
    if (ipDecision) return ipDecision;

    const url = new URL(request.url);
    const environment = readRouterEnvironment(env);
    if (!environment) return errorResponse('ROUTER_ENV_INVALID', 'Router environment is invalid.', 500);

    const host = classifyHost(url.hostname, { environment });
    if (!host.ok) return errorResponse(host.code, `Host ${url.hostname} is not a routable pages v2 site.`, 404);

    if (url.pathname === SITE_AUTH_CALLBACK_PATH) {
      const routeResult = await readUsableRoute(env, host.hostname, environment);
      if (!routeResult.ok) return routeResult.response;
      return handleSiteAuthCallback(request, env, routeResult.route);
    }

    if (isPlatformPath(url.pathname)) {
      return errorResponse('PLATFORM_PATH_RESERVED', 'This platform path is not dispatched to user workers.', 404);
    }

    const routeResult = await readUsableRoute(env, host.hostname, environment);
    if (!routeResult.ok) return routeResult.response;
    const route = routeResult.route;

    const identity = await readSiteIdentity(request, env, route);
    const policy = evaluateAccessPolicy(route, identity);
    if (!policy.ok) {
      if (policy.status === 302) return redirectToAuth(request, env, route, policy.code);
      return errorResponse(policy.code, 'Site access denied.', policy.status);
    }

    const dispatchTarget = env.PAGES_DISPATCH?.get(route.workerName);
    if (!dispatchTarget) return errorResponse('DISPATCH_UNAVAILABLE', 'Dispatch namespace is not available.', 503);

    let platformHeaders;
    try {
      platformHeaders = await buildPlatformHeaders(route, env, policy.user);
    } catch {
      return errorResponse('INTERNAL_JWT_CREATE_FAILED', 'Internal worker token could not be created.', 500);
    }
    const sanitizedRequest = sanitizeRequestForUserWorker(request, platformHeaders);
    const userResponse = await dispatchTarget.fetch(sanitizedRequest);
    return sanitizeUserWorkerResponse(userResponse);
  },
};

async function readUsableRoute(env, hostname, environment) {
  let route;
  try {
    route = await readRouteSnapshot(env, hostname, environment);
  } catch {
    return { ok: false, response: errorResponse('ROUTE_SNAPSHOT_INVALID', 'Route snapshot is invalid.', 503) };
  }
  if (!route) return { ok: false, response: errorResponse('ROUTE_NOT_FOUND', 'Site route not found.', 404) };
  if (route.environment !== environment || route.hostname !== hostname) {
    return {
      ok: false,
      response: errorResponse('ROUTE_ENV_MISMATCH', 'Route environment does not match router environment.', 403),
    };
  }
  if (route.routeStatus !== 'active' || route.runtime !== 'wfp') {
    return { ok: false, response: errorResponse('ROUTE_INACTIVE', 'Site route is not active.', 404) };
  }
  if (!isValidRouteWorkerName(route.workerName, environment)) {
    return { ok: false, response: errorResponse('ROUTE_WORKER_INVALID', 'Route worker target is invalid.', 403) };
  }

  return { ok: true, route };
}

function enforceIPAllowlist(request, env) {
  const allowlist = env.ROUTER_IP_ALLOWLIST_CIDRS;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!isAllowedIP(ip, allowlist)) {
    return errorResponse('IP_DENIED', 'Client IP is not allowed.', 403);
  }
  return null;
}

function readRouterEnvironment(env) {
  const environment = env.PAGES_ENV;
  if (!VALID_ROUTER_ENVIRONMENTS.has(environment)) return null;
  return environment;
}

async function readRouteSnapshot(env, hostname, environment) {
  if (typeof env.lookupRoute === 'function') return env.lookupRoute(hostname);
  if (typeof env.ROUTE_SNAPSHOTS?.get === 'function') return readKvRouteSnapshot(env.ROUTE_SNAPSHOTS, hostname, environment);
  return env.ROUTE_SNAPSHOTS?.[hostname] || null;
}

async function readKvRouteSnapshot(routeSnapshots, hostname, environment) {
  const pointer = await readJsonRecord(routeSnapshots, routePointerKey(environment, hostname));
  if (!pointer) return null;
  if (
    pointer.hostname !== hostname ||
    pointer.environment !== environment ||
    typeof pointer.snapshotKey !== 'string' ||
    pointer.snapshotKey === ''
  ) {
    throw new Error('Route pointer is invalid');
  }

  const snapshot = await readJsonRecord(routeSnapshots, pointer.snapshotKey);
  if (!snapshot) return null;
  if (
    snapshot.hostname !== hostname ||
    snapshot.routeGeneration !== pointer.routeGeneration ||
    snapshot.policyVersion !== pointer.policyVersion
  ) {
    throw new Error('Route snapshot does not match pointer');
  }
  return snapshot;
}

async function readJsonRecord(store, key) {
  const value = await store.get(key);
  if (value == null) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Route snapshot JSON is invalid');
  return parsed;
}

function routePointerKey(environment, hostname) {
  return `${environment}:route_pointer:${hostname}`;
}

function isValidRouteWorkerName(workerName, environment) {
  if (typeof workerName !== 'string') return false;
  if (workerName.length < 1 || workerName.length > MAX_WORKER_NAME_LENGTH) return false;
  if (!WORKER_NAME_RE.test(workerName)) return false;

  if (environment === 'staging') return workerName.startsWith(STAGING_WORKER_PREFIX);
  return workerName.startsWith(PRODUCTION_WORKER_PREFIX) && !workerName.startsWith(STAGING_WORKER_PREFIX);
}

async function readSiteIdentity(request, env, route) {
  const token = readCookie(request.headers.get('Cookie'), SITE_SESSION_COOKIE);
  if (!token) return null;

  try {
    const payload =
      typeof env.verifySiteSession === 'function'
        ? await env.verifySiteSession(token, { route, request })
        : await verifySessionJwt(token, env, {
            purpose: 'site_session',
            audience: route.hostname,
            now: readNowSeconds(env),
          });
    return identityFromSessionPayload(payload);
  } catch {
    return null;
  }
}

function identityFromSessionPayload(payload) {
  return {
    userId: payload.sub,
    siteId: payload.siteId,
    policyVersion: payload.policyVersion,
    sessionVersion: payload.sessionVersion,
    employeeStatus: payload.employeeStatus || 'unknown',
    email: payload.email || '',
    departments: Array.isArray(payload.departments) ? payload.departments : [],
  };
}

function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    if (trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1);
  }
  return '';
}

function readNowSeconds(env) {
  if (typeof env.nowSeconds === 'function') return env.nowSeconds();
  return Math.floor(Date.now() / 1000);
}

async function buildPlatformHeaders(route, env, identity) {
  const traceId = crypto.randomUUID();
  const internalJwt = await signInternalWorkerJwt(route, env, identity, traceId);
  return {
    'CF-Platform-Auth': internalJwt,
    'CF-Platform-User': identity?.userId || 'anonymous',
    'CF-Platform-Site-Id': route.siteId,
    'CF-Platform-Site-Slug': route.slug,
    'CF-Platform-Version': route.activeVersionId,
    'CF-Platform-Trace-Id': traceId,
  };
}

async function signInternalWorkerJwt(route, env, identity, traceId) {
  return signSessionJwt(
    {
      purpose: 'internal_worker_jwt',
      audience: route.workerName,
      subject: identity?.userId || 'anonymous',
      now: readNowSeconds(env),
      ttlSeconds: readInternalWorkerJwtTtlSeconds(env),
      claims: {
        siteId: route.siteId,
        siteUuid: route.siteUuid,
        routeId: route.routeId,
        slug: route.slug,
        versionId: route.activeVersionId,
        policyVersion: route.policyVersion,
        traceId,
        anonymous: !identity,
      },
    },
    env
  );
}

async function handleSiteAuthCallback(request, env, route) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return errorResponse('SITE_AUTH_CALLBACK_INVALID', 'Site auth callback is invalid.', 400);

  let consumed;
  try {
    consumed = await consumeSiteCode(env, { code, siteHost: route.hostname });
  } catch {
    return errorResponse('SITE_AUTH_CODE_INVALID', 'Site auth code is invalid.', 400);
  }

  const identity = identityFromSiteCode(route, consumed.user);
  const policy = evaluateAccessPolicy(route, identity);
  if (!policy.ok) return errorResponse(policy.code, 'Site access denied.', policy.status === 302 ? 403 : policy.status);

  let token;
  try {
    token = await signSessionJwt(
      {
        purpose: 'site_session',
        audience: route.hostname,
        subject: identity.userId,
        now: readNowSeconds(env),
        ttlSeconds: readSiteSessionTtlSeconds(env),
        claims: {
          sid: crypto.randomUUID(),
          siteId: route.siteId,
          policyVersion: route.policyVersion,
          sessionVersion: identity.sessionVersion,
          employeeStatus: identity.employeeStatus,
          email: identity.email,
          departments: identity.departments,
        },
      },
      env
    );
  } catch {
    return errorResponse('SITE_SESSION_CREATE_FAILED', 'Site session could not be created.', 500);
  }

  let returnTo;
  try {
    returnTo = validateSiteReturnTo(consumed.returnTo, route.hostname);
  } catch {
    return errorResponse('SITE_AUTH_RETURN_INVALID', 'Site auth return URL is invalid.', 400);
  }

  const response = new Response(null, {
    status: 302,
    headers: {
      Location: returnTo,
      'Cache-Control': 'no-store',
    },
  });
  response.headers.set('Set-Cookie', buildSiteSessionCookie(token, { maxAgeSeconds: readSiteSessionTtlSeconds(env) }));
  return response;
}

async function consumeSiteCode(env, { code, siteHost }) {
  if (typeof env.consumeSiteCode === 'function') return env.consumeSiteCode({ code, siteHost });

  if (!env.PAGES_AUTH || typeof env.PAGES_AUTH.fetch !== 'function') throw new Error('PAGES_AUTH binding is required');
  const response = await env.PAGES_AUTH.fetch(
    new Request('https://pages-auth.internal/.xd-pages/internal/consume-site-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteCode: code, siteHost, now: readNowSeconds(env) }),
    })
  );
  if (!response.ok) throw new Error('Site code consume failed');
  return response.json();
}

function identityFromSiteCode(route, user = {}) {
  return {
    userId: user.id,
    siteId: route.siteId,
    policyVersion: route.policyVersion,
    sessionVersion: user.sessionVersion || 1,
    employeeStatus: user.employeeStatus || 'unknown',
    email: user.email || '',
    departments: Array.isArray(user.departments) ? user.departments : [],
  };
}

function validateSiteReturnTo(value, hostname) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.origin !== `https://${hostname}`) {
    throw new Error('Invalid site return URL');
  }
  return url.toString();
}

function readSiteSessionTtlSeconds(env) {
  const value = Number(env.SITE_SESSION_IDLE_TTL_SECONDS || DEFAULT_SITE_SESSION_TTL_SECONDS);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_SITE_SESSION_TTL_SECONDS;
  return value;
}

function readInternalWorkerJwtTtlSeconds(env) {
  const value = Number(env.INTERNAL_WORKER_JWT_TTL_SECONDS || 60);
  if (!Number.isInteger(value) || value < 30 || value > 60) return 60;
  return value;
}

function redirectToAuth(request, env, route, reason) {
  let authBase;
  try {
    authBase = new URL(env.PUBLIC_AUTH_BASE);
  } catch {
    return errorResponse('AUTH_BASE_INVALID', 'Auth base URL is invalid.', 500);
  }
  if (authBase.protocol !== 'https:' || authBase.username || authBase.password || authBase.search || authBase.hash) {
    return errorResponse('AUTH_BASE_INVALID', 'Auth base URL is invalid.', 500);
  }

  const redirect = new URL('/.xd-pages/auth/authorize', authBase);
  redirect.searchParams.set('site_host', route.hostname);
  redirect.searchParams.set('return_to', request.url);
  redirect.searchParams.set('reason', reason);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(code, message, status) {
  return jsonResponse(
    {
      error: {
        code,
        message,
      },
    },
    status,
    { 'Cache-Control': 'no-store' }
  );
}
