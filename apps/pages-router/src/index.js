import { siteErrorResponse, wantsHtml } from '@xd/browser-pages';
import { isAllowedIP } from '@xd/ip-guard';
import {
  GATEWAY,
  HEADERS,
  RUNTIME,
  classifyHost,
  isValidSiteId,
  isValidSiteSlug,
  scopeForDataOperation,
} from '@xd/pages-runtime-protocol';
import {
  SITE_SESSION_COOKIE,
  buildSiteSessionCookie,
  readCookie,
  signSessionJwt,
  verifySessionJwt,
} from '@xd/session-kit';
import { jsonResponse } from '@xd/worker-kit';
import { accessModeFromVisibility, isValidAccessMode, visibilityFromAccessMode } from '@xd/pages-access-policy';

import { evaluateAccessPolicy } from './access-policy.js';
import { isPlatformPath } from './platform-path.js';
import { sanitizeRequestForUserWorker, sanitizeUserWorkerResponse } from './sanitize.js';

const VALID_ROUTER_ENVIRONMENTS = new Set(['production', 'staging']);
const SITE_AUTH_CALLBACK_PATH = '/.xd-pages/auth/callback';
const DEFAULT_SITE_SESSION_TTL_SECONDS = 604_800;
const MAX_SITE_SESSION_FRESHNESS_TTL_SECONDS = 900;
const DEFAULT_SITE_SESSION_FRESHNESS_TTL_SECONDS = 900;
const PRODUCTION_WORKER_PREFIX = 'pages-v2-';
const STAGING_WORKER_PREFIX = 'pages-v2-staging-';
const MAX_WORKER_NAME_LENGTH = 63;
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KV_CAPABILITY_ISSUER = 'pages-v2';
const KV_CAPABILITY_AUDIENCE = 'pages-kv-gateway';
const DEFAULT_KV_CAPABILITY_TTL_SECONDS = 60;
const RUNTIME_GATEWAY_PATHS = new Map([
  [RUNTIME.KV_GET_PATH, legacyRuntimeRoute(GATEWAY.KV_GET_PATH)],
  [RUNTIME.KV_GET_WITH_METADATA_PATH, legacyRuntimeRoute(GATEWAY.KV_GET_WITH_METADATA_PATH)],
  [RUNTIME.KV_LIST_PATH, legacyRuntimeRoute(GATEWAY.KV_LIST_PATH)],
  [RUNTIME.KV_SET_PATH, legacyRuntimeRoute(GATEWAY.KV_SET_PATH)],
  [RUNTIME.KV_DELETE_PATH, legacyRuntimeRoute(GATEWAY.KV_DELETE_PATH)],
  [RUNTIME.DATA_SITE_GET_PATH, dataRuntimeRoute(GATEWAY.DATA_SITE_GET_PATH, 'site', 'get')],
  [
    RUNTIME.DATA_SITE_GET_WITH_METADATA_PATH,
    dataRuntimeRoute(GATEWAY.DATA_SITE_GET_WITH_METADATA_PATH, 'site', 'get'),
  ],
  [RUNTIME.DATA_SITE_LIST_PATH, dataRuntimeRoute(GATEWAY.DATA_SITE_LIST_PATH, 'site', 'list')],
  [RUNTIME.DATA_SITE_SET_PATH, dataRuntimeRoute(GATEWAY.DATA_SITE_SET_PATH, 'site', 'set')],
  [RUNTIME.DATA_SITE_DELETE_PATH, dataRuntimeRoute(GATEWAY.DATA_SITE_DELETE_PATH, 'site', 'delete')],
  [RUNTIME.DATA_USER_GET_PATH, dataRuntimeRoute(GATEWAY.DATA_USER_GET_PATH, 'user', 'get')],
  [RUNTIME.DATA_USER_SET_PATH, dataRuntimeRoute(GATEWAY.DATA_USER_SET_PATH, 'user', 'set')],
  [RUNTIME.DATA_USER_DELETE_PATH, dataRuntimeRoute(GATEWAY.DATA_USER_DELETE_PATH, 'user', 'delete')],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const runtimeGatewayPath = runtimeGatewayPathFor(url.pathname);
    // runtime API 路径的错误响应固定为 JSON 契约,包括 IP/host/route/policy 前置错误,不做 HTML 协商。
    if (runtimeGatewayPath) request = withJsonOnlyAccept(request);

    const environment = readRouterEnvironment(env);
    if (!environment) return siteErrorResponse(request, 'ROUTER_ENV_INVALID');

    const host = classifyHost(url.hostname, { environment });
    if (!host.ok) {
      return siteErrorResponse(request, host.code, {
        message: `Host ${url.hostname} is not a routable XD Cell site.`,
      });
    }

    if (isPlatformPath(url.pathname) && url.pathname !== SITE_AUTH_CALLBACK_PATH && !runtimeGatewayPath) {
      return siteErrorResponse(request, 'PLATFORM_PATH_RESERVED');
    }

    const routePolicy = await readRoutePolicy(env, host.hostname, environment);
    const trustedPublic =
      routePolicy.ok &&
      (routePolicy.route.schemaVersion === 3 || routePolicy.route.schemaVersion === 4) &&
      routePolicy.route.exposure === 'public';
    const ipDecision = trustedPublic ? null : enforceIPAllowlist(request, env);
    if (ipDecision) return ipDecision;
    if (!routePolicy.ok) return routePolicyErrorResponse(request, host.hostname, routePolicy.code);

    const routeResult = validateUsableRoute(request, routePolicy.route);
    if (!routeResult.ok) return routeResult.response;
    const route = routeResult.route;

    if (url.pathname === SITE_AUTH_CALLBACK_PATH) return handleSiteAuthCallback(request, env, route);

    const identity = await readSiteIdentity(request, env, route);
    if (identity && requiresFreshIdentity(route) && !siteSessionIsFresh(identity, env)) {
      return redirectToAuth(request, env, route, 'SITE_SESSION_STALE');
    }
    const policy = evaluateAccessPolicy(route, identity);
    if (!policy.ok) {
      if (policy.status === 302) return redirectToAuth(request, env, route, policy.code);
      return siteErrorResponse(request, policy.code, { hostname: route.hostname });
    }

    if (runtimeGatewayPath) return handleRuntimeGatewayRequest(request, env, route, policy.user, runtimeGatewayPath);

    const dispatchTarget = resolveDispatchTarget(env, route);
    if (!dispatchTarget) return siteErrorResponse(request, 'DISPATCH_UNAVAILABLE', { hostname: route.hostname });

    let platformHeaders;
    try {
      platformHeaders = await buildPlatformHeaders(route, env, policy.user);
    } catch {
      return siteErrorResponse(request, 'INTERNAL_JWT_CREATE_FAILED', { hostname: route.hostname });
    }
    const sanitizedRequest = sanitizeRequestForUserWorker(request, platformHeaders);
    const userResponse = await dispatchTarget.fetch(sanitizedRequest);
    return sanitizeUserWorkerResponse(userResponse);
  },
};

async function readRoutePolicy(env, hostname, environment) {
  let route;
  try {
    route = await readRouteSnapshot(env, hostname, environment);
  } catch {
    return { ok: false, code: 'ROUTE_SNAPSHOT_INVALID' };
  }
  if (!route) return { ok: false, code: 'ROUTE_NOT_FOUND' };
  if (route.environment !== environment || route.hostname !== hostname) return { ok: false, code: 'ROUTE_ENV_MISMATCH' };
  try {
    return { ok: true, route: normalizeRoutePolicy(route) };
  } catch (error) {
    return { ok: false, code: error?.message === 'SITE_POLICY_INVALID' ? 'SITE_POLICY_INVALID' : 'ROUTE_SNAPSHOT_INVALID' };
  }
}

function validateUsableRoute(request, route) {
  if (route.routeStatus !== 'active' || !routeRuntimeIsActive(route.runtime)) {
    return { ok: false, response: siteErrorResponse(request, 'ROUTE_INACTIVE', { hostname: route.hostname }) };
  }
  if (!isValidRouteWorkerName(route.workerName, route.environment)) {
    return { ok: false, response: siteErrorResponse(request, 'ROUTE_WORKER_INVALID', { hostname: route.hostname }) };
  }

  return { ok: true, route };
}

function routePolicyErrorResponse(request, hostname, code) {
  if (code === 'ROUTE_NOT_FOUND') return siteErrorResponse(request, code, { hostname });
  if (code === 'ROUTE_ENV_MISMATCH') return siteErrorResponse(request, code, { hostname });
  return siteErrorResponse(request, code, { hostname });
}

function normalizeRoutePolicy(route) {
  const schemaVersion = route.schemaVersion == null ? 2 : route.schemaVersion;
  if (schemaVersion === 2) {
    const accessMode = accessModeFromVisibility(route.visibility);
    if (!accessMode) throw new Error('SITE_POLICY_INVALID');
    return { ...route, schemaVersion: 2, exposure: 'internal', accessMode, visibility: route.visibility };
  }
  if (schemaVersion !== 3 && schemaVersion !== 4) throw new Error('ROUTE_SNAPSHOT_SCHEMA_INVALID');
  if (
    schemaVersion === 4 &&
    (route.kind !== 'serve' ||
      !isValidSiteId(route.siteId) ||
      !isValidSiteSlug(route.slug) ||
      !isValidSiteSlug(route.dataNamespace) ||
      !Number.isInteger(route.routeGeneration) ||
      !Number.isInteger(route.policyVersion))
  ) {
    throw new Error('ROUTE_SNAPSHOT_SCHEMA_INVALID');
  }
  const exposure = route.exposure === 'public' ? 'public' : 'internal';
  if (!isValidAccessMode(route.accessMode)) throw new Error('SITE_POLICY_INVALID');
  const visibility = visibilityFromAccessMode(route.accessMode);
  if (route.visibility !== visibility) throw new Error('SITE_POLICY_INVALID');
  return { ...route, schemaVersion, exposure, accessMode: route.accessMode, visibility };
}

function routeRuntimeIsActive(runtime) {
  return runtime === 'worker' || runtime === 'wfp';
}

function resolveDispatchTarget(env, route) {
  const dispatch = route.dispatch || dispatchFromLegacyRoute(route);
  if (dispatch?.type === 'service-binding') {
    if (!isValidSlotBindingName(dispatch.bindingName)) return null;
    return env[dispatch.bindingName] || null;
  }
  if (dispatch?.type === 'dispatch-namespace') {
    return env.PAGES_DISPATCH?.get(route.workerName) || null;
  }
  return null;
}

function dispatchFromLegacyRoute(route) {
  if (route.dispatchType === 'service-binding') {
    return {
      type: 'service-binding',
      bindingName: route.dispatchBindingName,
      slotId: route.slotId || null,
    };
  }
  return { type: 'dispatch-namespace' };
}

function isValidSlotBindingName(value) {
  return /^SITE_SLOT_\d{3,}$/.test(String(value || ''));
}

function enforceIPAllowlist(request, env) {
  const allowlist = env.ROUTER_IP_ALLOWLIST_CIDRS;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!isAllowedIP(ip, allowlist)) {
    return siteErrorResponse(request, 'IP_DENIED', {
      detail: `状态详情：IP_DENIED\n当前 IP：${ip || '未知'}`,
    });
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
    !Number.isInteger(pointer.routeGeneration) ||
    !Number.isInteger(pointer.policyVersion) ||
    typeof pointer.snapshotKey !== 'string' ||
    pointer.snapshotKey === ''
  ) {
    throw new Error('Route pointer is invalid');
  }

  const snapshot = await readJsonRecord(routeSnapshots, pointer.snapshotKey);
  if (!snapshot) return null;
  if (
    snapshot.hostname !== hostname ||
    snapshot.environment !== environment ||
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
    accountId: payload.accountId || null,
    name: payload.name || null,
    departments: Array.isArray(payload.departments) ? payload.departments : [],
    userCheckedAt: Number.isInteger(payload.userCheckedAt) ? payload.userCheckedAt : 0,
  };
}

function readNowSeconds(env) {
  if (typeof env.nowSeconds === 'function') return env.nowSeconds();
  return Math.floor(Date.now() / 1000);
}

async function buildPlatformHeaders(route, env, identity) {
  const traceId = crypto.randomUUID();
  const internalJwt = await signInternalWorkerJwt(route, env, identity, traceId);
  const headers = {
    'CF-Platform-Auth': internalJwt,
    'CF-Platform-User': identity?.userId || 'anonymous',
    'CF-Platform-Site-Id': route.siteId,
    'CF-Platform-Site-Slug': route.slug,
    'CF-Platform-Version': route.activeVersionId,
    'CF-Platform-Trace-Id': traceId,
  };
  if (route.kv?.enabled) {
    headers['CF-Platform-Data-Site-Capability'] = await signKvCapability(route, env, identity, traceId, {
      dataScope: 'site',
      scope: dataScopes(route, 'site'),
    });
    if (identity) {
      headers['CF-Platform-Data-User-Capability'] = await signKvCapability(route, env, identity, traceId, {
        dataScope: 'user',
        scope: dataScopes(route, 'user'),
      });
    }
    headers['CF-Platform-KV-Capability'] = await signKvCapability(route, env, identity, traceId, {
      legacy: true,
      scope: legacyKvScopes(route),
    });
  }
  return headers;
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
        user: identity
          ? {
              id: identity.userId,
              email: identity.email || null,
              accountId: identity.accountId || null,
              name: identity.name || null,
              departments: identity.departments,
              employeeStatus: identity.employeeStatus,
            }
          : null,
      },
    },
    env
  );
}

async function handleRuntimeGatewayRequest(request, env, route, identity, runtimeRoute) {
  if (!route.kv?.enabled) return errorResponse('RUNTIME_NOT_ENABLED', 'Runtime API is not enabled for this site.', 404);
  if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  if (route.exposure === 'public' && !runtimeContentTypeIsJson(request)) {
    return errorResponse('RUNTIME_CONTENT_TYPE_INVALID', 'Runtime request content type must be application/json.', 415);
  }
  if (request.headers.get(HEADERS.RUNTIME_REQUEST) !== '1') {
    return errorResponse('RUNTIME_REQUEST_REQUIRED', 'Runtime request header is required.', 403);
  }
  const originDecision = runtimeOriginDecision(request, route.exposure === 'public');
  if (originDecision === 'required') {
    return errorResponse('RUNTIME_ORIGIN_REQUIRED', 'Runtime request origin is required.', 403);
  }
  if (originDecision === 'denied' || (route.exposure === 'public' && !runtimeFetchMetadataAllowed(request))) {
    return errorResponse('RUNTIME_ORIGIN_DENIED', 'Runtime request origin is denied.', 403);
  }
  if (runtimeRoute.dataScope === 'user' && !identity) {
    return errorResponse('USER_REQUIRED', 'User identity is required.', 401);
  }
  if (typeof env.XD_PAGES_KV_GATEWAY?.fetch !== 'function') {
    return errorResponse('RUNTIME_GATEWAY_UNAVAILABLE', 'Runtime gateway is unavailable.', 503);
  }

  let capability;
  try {
    capability = await signKvCapability(route, env, identity, crypto.randomUUID(), runtimeCapabilityOptions(route, runtimeRoute));
  } catch {
    return errorResponse('RUNTIME_CAPABILITY_CREATE_FAILED', 'Runtime capability could not be created.', 500);
  }

  const headers = new Headers();
  headers.set('Authorization', `Bearer ${capability}`);
  headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  const body = await request.text();
  const gatewayResponse = await env.XD_PAGES_KV_GATEWAY.fetch(
    new Request(`https://pages-kv-gateway.local${runtimeRoute.gatewayPath}`, {
      method: 'POST',
      headers,
      body,
    })
  );
  return sanitizeRuntimeGatewayResponse(gatewayResponse);
}

function runtimeGatewayPathFor(pathname) {
  return RUNTIME_GATEWAY_PATHS.get(pathname) || null;
}

function withJsonOnlyAccept(request) {
  const headers = new Headers(request.headers);
  headers.set('Accept', 'application/json');
  return new Request(request, { headers });
}

function legacyRuntimeRoute(gatewayPath) {
  return { gatewayPath, legacy: true, scope: null };
}

function dataRuntimeRoute(gatewayPath, dataScope, operation) {
  return { gatewayPath, dataScope, operation };
}

function runtimeContentTypeIsJson(request) {
  const contentType = request.headers.get('Content-Type');
  if (!contentType) return false;
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function runtimeOriginDecision(request, requireOrigin) {
  const origin = request.headers.get('Origin');
  if (!origin) return requireOrigin ? 'required' : 'allowed';
  try {
    return new URL(origin).origin === new URL(request.url).origin ? 'allowed' : 'denied';
  } catch {
    return 'denied';
  }
}

function runtimeFetchMetadataAllowed(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return false;
  const mode = request.headers.get('Sec-Fetch-Mode');
  if (mode && mode !== 'cors' && mode !== 'same-origin') return false;
  const destination = request.headers.get('Sec-Fetch-Dest');
  return !destination || destination === 'empty';
}

function sanitizeRuntimeGatewayResponse(response) {
  const headers = new Headers(response.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'set-cookie' ||
      lower.startsWith('access-control-') ||
      lower.startsWith('cf-platform-') ||
      lower.startsWith('x-pages-') ||
      lower.startsWith('x-xd-pages-')
    ) {
      headers.delete(name);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function signKvCapability(route, env, identity, traceId, options = {}) {
  if (typeof env.signKvCapability === 'function') return env.signKvCapability({ route, identity, traceId, options });
  const activeKid = readRequired(env.PAGES_CAP_JWT_ACTIVE_KID, 'PAGES_CAP_JWT_ACTIVE_KID');
  const registry = parseJwtKeyRegistry(env.PAGES_CAP_JWT_KEYS, env, 'PAGES_CAP_JWT_KEYS', 'PAGES_CAP_JWT_SECRET_');
  const key = registry.get(activeKid);
  if (!key) throw new Error('PAGES_CAP_JWT_ACTIVE_KID is not present in PAGES_CAP_JWT_KEYS');
  const now = readNowSeconds(env);
  const ttl = readKvCapabilityTtlSeconds(env);
  const subject = options.dataScope === 'site' ? 'anonymous' : identity?.userId || 'anonymous';
  const anonymous = options.dataScope === 'site' ? true : !identity;
  const payload = {
    iss: KV_CAPABILITY_ISSUER,
    aud: KV_CAPABILITY_AUDIENCE,
    env: route.environment,
    siteId: route.schemaVersion === 4 ? route.siteId : route.slug,
    siteUuid: route.siteUuid,
    routeId: route.routeId,
    versionId: route.activeVersionId,
    policyVersion: route.policyVersion,
    sub: subject,
    anonymous,
    scope: options.scope || legacyKvScopes(route),
    traceId,
    iat: now,
    nbf: now,
    exp: now + ttl,
  };

  if (route.schemaVersion === 4) {
    payload.namespaceVersion = 2;
    payload.dataNamespace = route.dataNamespace;
  }

  if (!options.legacy) {
    payload.apiVersion = 2;
    payload.dataScope = options.dataScope || 'site';
  }

  return createHs256Jwt({
    kid: activeKid,
    secret: key.secret,
    payload,
  });
}

function legacyKvScopes(route) {
  return Array.isArray(route.kv?.scopes) ? route.kv.scopes : [];
}

function dataScopes(route, dataScope) {
  const operations = new Set();
  for (const scope of legacyKvScopes(route)) {
    if (scope === 'kv:get') operations.add('get');
    if (scope === 'kv:set') operations.add('set');
    if (scope === 'kv:delete') operations.add('delete');
    if (scope === 'kv:list' && dataScope === 'site') operations.add('list');
  }
  return [...operations].map((operation) => scopeForDataOperation(dataScope, operation));
}

function runtimeCapabilityOptions(route, runtimeRoute) {
  if (runtimeRoute.legacy) return runtimeRoute;
  const allowedScope = scopeForDataOperation(runtimeRoute.dataScope, runtimeRoute.operation);
  const scope = dataScopes(route, runtimeRoute.dataScope).includes(allowedScope) ? [allowedScope] : [];
  return { ...runtimeRoute, scope };
}

function readKvCapabilityTtlSeconds(env) {
  const configured = Number(env.KV_CAPABILITY_TTL_SECONDS || DEFAULT_KV_CAPABILITY_TTL_SECONDS);
  if (!Number.isInteger(configured) || configured <= 0) return DEFAULT_KV_CAPABILITY_TTL_SECONDS;
  return Math.min(configured, DEFAULT_KV_CAPABILITY_TTL_SECONDS);
}

function parseJwtKeyRegistry(value, env, registryName, secretPrefix) {
  const registry = new Map();
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [kid, alg, secretEnvName, extra] = entry.split(':').map((part) => part.trim());
    if (extra !== undefined || !kid || alg !== 'HS256' || !secretEnvName || !secretEnvName.startsWith(secretPrefix)) {
      throw new Error(`${registryName} is invalid`);
    }
    const secret = env[secretEnvName];
    if (typeof secret !== 'string' || !secret) throw new Error(`${secretEnvName} is required`);
    if (registry.has(kid)) throw new Error(`${registryName} contains duplicate kid`);
    registry.set(kid, { alg, secret });
  }

  if (registry.size === 0) throw new Error(`${registryName} is empty`);
  return registry;
}

async function createHs256Jwt({ kid, secret, payload }) {
  const header = { typ: 'JWT', alg: 'HS256', kid };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHs256(secret, signingInput);
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function signHs256(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(value));
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(new globalThis.TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readRequired(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

async function handleSiteAuthCallback(request, env, route) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return siteErrorResponse(request, 'SITE_AUTH_CALLBACK_INVALID', { hostname: route.hostname });

  let consumed;
  try {
    consumed = await consumeSiteCode(env, { code, siteHost: route.hostname });
  } catch {
    return handleSiteAuthCodeInvalid(request, env, route);
  }

  const identity = identityFromSiteCode(route, consumed.user);
  const policy = evaluateAccessPolicy(route, identity);
  if (!policy.ok) {
    return siteErrorResponse(request, policy.code, { hostname: route.hostname });
  }

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
          userCheckedAt: readNowSeconds(env),
          employeeStatus: identity.employeeStatus,
          email: identity.email,
          accountId: identity.accountId,
          name: identity.name,
          departments: identity.departments,
        },
      },
      env
    );
  } catch {
    return siteErrorResponse(request, 'SITE_SESSION_CREATE_FAILED', { hostname: route.hostname });
  }

  let returnTo;
  try {
    returnTo = validateSiteReturnTo(consumed.returnTo, route.hostname);
  } catch {
    return siteErrorResponse(request, 'SITE_AUTH_RETURN_INVALID', { hostname: route.hostname });
  }

  const response = new Response(null, {
    status: 302,
    headers: {
      Location: returnTo,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
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

function handleSiteAuthCodeInvalid(request, env, route) {
  const url = new URL(request.url);
  if (wantsHtml(request) && url.searchParams.get('auth_recovery') !== '1') {
    return redirectToAuth(request, env, route, 'SITE_AUTH_CODE_INVALID', {
      returnTo: recoveryReturnTo(url, route.hostname),
      authRecovery: true,
    });
  }

  return siteErrorResponse(request, 'SITE_AUTH_CODE_INVALID', { hostname: route.hostname });
}

function identityFromSiteCode(route, user = {}) {
  return {
    userId: user.id,
    siteId: route.siteId,
    policyVersion: route.policyVersion,
    sessionVersion: user.sessionVersion || 1,
    employeeStatus: user.employeeStatus || 'unknown',
    email: user.email || '',
    accountId: user.accountId || null,
    name: user.name || null,
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

function recoveryReturnTo(url, hostname) {
  try {
    const returnTo = validateSiteReturnTo(url.searchParams.get('return_to') || '', hostname);
    const parsed = new URL(returnTo);
    if (parsed.pathname === SITE_AUTH_CALLBACK_PATH) throw new Error('Callback URL cannot be a return target');
    return parsed.toString();
  } catch {
    return `https://${hostname}/`;
  }
}

function readSiteSessionTtlSeconds(env) {
  const value = Number(env.SITE_SESSION_IDLE_TTL_SECONDS || DEFAULT_SITE_SESSION_TTL_SECONDS);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_SITE_SESSION_TTL_SECONDS;
  return value;
}

function readSiteSessionFreshnessTtlSeconds(env) {
  const value = Number(env.SITE_SESSION_FRESHNESS_TTL_SECONDS || DEFAULT_SITE_SESSION_FRESHNESS_TTL_SECONDS);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_SITE_SESSION_FRESHNESS_TTL_SECONDS;
  }
  return Math.min(value, MAX_SITE_SESSION_FRESHNESS_TTL_SECONDS);
}

function requiresFreshIdentity(route) {
  return route?.accessMode === 'org' || route?.accessMode === 'acl' || route?.accessMode === 'owner';
}

function siteSessionIsFresh(identity, env) {
  if (!Number.isInteger(identity?.userCheckedAt) || identity.userCheckedAt <= 0) return false;
  return readNowSeconds(env) - identity.userCheckedAt <= readSiteSessionFreshnessTtlSeconds(env);
}

function readInternalWorkerJwtTtlSeconds(env) {
  const value = Number(env.INTERNAL_WORKER_JWT_TTL_SECONDS || 60);
  if (!Number.isInteger(value) || value < 30 || value > 60) return 60;
  return value;
}

function redirectToAuth(request, env, route, reason, options = {}) {
  let authBase;
  try {
    authBase = new URL(env.PUBLIC_AUTH_BASE);
  } catch {
    return siteErrorResponse(request, 'AUTH_BASE_INVALID');
  }
  if (authBase.protocol !== 'https:' || authBase.username || authBase.password || authBase.search || authBase.hash) {
    return siteErrorResponse(request, 'AUTH_BASE_INVALID');
  }

  const redirect = new URL('/.xd-pages/auth/authorize', authBase);
  redirect.searchParams.set('site_host', route.hostname);
  redirect.searchParams.set('return_to', options.returnTo || request.url);
  redirect.searchParams.set('reason', reason);
  if (options.authRecovery) redirect.searchParams.set('auth_recovery', '1');
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
