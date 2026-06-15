import { isAllowedIP } from '@xd/ip-guard';
import { jsonResponse } from '@xd/worker-kit';

import { classifyHost } from './host.js';
import { isPlatformPath } from './platform-path.js';
import { sanitizeRequestForUserWorker, sanitizeUserWorkerResponse } from './sanitize.js';

export default {
  async fetch(request, env) {
    const ipDecision = enforceIPAllowlist(request, env);
    if (ipDecision) return ipDecision;

    const url = new URL(request.url);
    const environment = env.PAGES_ENV || 'production';
    const host = classifyHost(url.hostname, { environment });
    if (!host.ok) return errorResponse(host.code, `Host ${url.hostname} is not a routable pages v2 site.`, 404);

    if (isPlatformPath(url.pathname)) {
      return errorResponse('PLATFORM_PATH_RESERVED', 'This platform path is not dispatched to user workers.', 404);
    }

    const route = await readRouteSnapshot(env, host.hostname);
    if (!route) return errorResponse('ROUTE_NOT_FOUND', 'Site route not found.', 404);
    if (route.environment !== environment || route.hostname !== host.hostname) {
      return errorResponse('ROUTE_ENV_MISMATCH', 'Route environment does not match router environment.', 403);
    }
    if (route.routeStatus !== 'active' || route.runtime !== 'wfp') {
      return errorResponse('ROUTE_INACTIVE', 'Site route is not active.', 404);
    }

    const dispatchTarget = env.PAGES_DISPATCH?.get(route.workerName);
    if (!dispatchTarget) return errorResponse('DISPATCH_UNAVAILABLE', 'Dispatch namespace is not available.', 503);

    const sanitizedRequest = sanitizeRequestForUserWorker(request, buildPlatformHeaders(route, env));
    const userResponse = await dispatchTarget.fetch(sanitizedRequest, env);
    return sanitizeUserWorkerResponse(userResponse);
  },
};

function enforceIPAllowlist(request, env) {
  const allowlist = env.ROUTER_IP_ALLOWLIST_CIDRS;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!isAllowedIP(ip, allowlist)) {
    return errorResponse('IP_DENIED', 'Client IP is not allowed.', 403);
  }
  return null;
}

async function readRouteSnapshot(env, hostname) {
  if (typeof env.lookupRoute === 'function') return env.lookupRoute(hostname);
  return env.ROUTE_SNAPSHOTS?.[hostname] || null;
}

function buildPlatformHeaders(route, env) {
  return {
    'CF-Platform-Auth': env.TEST_INTERNAL_JWT || '',
    'CF-Platform-User': 'anonymous',
    'CF-Platform-Site-Id': route.siteId,
    'CF-Platform-Site-Slug': route.slug,
    'CF-Platform-Version': route.activeVersionId,
    'CF-Platform-Trace-Id': crypto.randomUUID(),
  };
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
