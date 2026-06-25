import {
  ERROR_CODES,
  HEADERS,
  RUNTIME,
  buildErrorEnvelope,
  buildOkEnvelope,
  validateKvType,
  validateTtl,
  validateUserKey,
} from '../../protocol.js';
import { PagesSDKError } from '../../errors.js';
import type { KVType, PagesDataStore, PagesRuntimeEnv } from '../../types.js';

type RuntimeFactory = typeof import('../../worker/index.js').createPagesRuntime;

export function createHandlePagesRuntimeRequest(createPagesRuntime: RuntimeFactory) {
  return async function handlePagesRuntimeRequest(
    request: Request,
    env: PagesRuntimeEnv,
    options: {
      checkAccess?: (request: Request, env: PagesRuntimeEnv) => Response | null | Promise<Response | null>;
    } = {}
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const action = getRuntimeAction(url.pathname);
    if (!action) return null;

    if (request.method !== 'POST') {
      return errorResponse(ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed', 405);
    }

    if (!hasJsonContentType(request)) {
      return errorResponse(ERROR_CODES.INVALID_CONTENT_TYPE, 'Content-Type must be application/json', 415);
    }

    if (request.headers.get(HEADERS.RUNTIME_REQUEST) !== '1') {
      return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
    }

    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
    }

    const origin = request.headers.get('Origin');
    if (origin && originFromHeader(origin) !== url.origin) {
      return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
    }

    if (!options.checkAccess) {
      return errorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', 403);
    }

    const accessResponse = await options.checkAccess(request, env);
    if (accessResponse) return accessResponse;

    const body = await parseBody(request);
    if (!body.ok) return errorResponse(body.code, body.message, 400);

    const key = validateUserKey(body.value.key);
    if (!key.ok) return errorResponse(key.error.code, key.error.message, 400);

    try {
      const runtime = createPagesRuntime({ env, request });
      const store = storeForAction(runtime, action);
      if (action.operation === 'get') {
        const type = validateKvType(body.value.type);
        if (!type.ok) return errorResponse(type.error.code, type.error.message, 400);
        const value =
          type.value === 'text'
            ? await store.get(key.value, { type: 'text' })
            : await store.get(key.value, { type: 'json' });
        return runtimeResponse(buildOkEnvelope(value === null ? { found: false } : { found: true, value }), action);
      }

      if (action.operation === 'set') {
        const type = validateKvType(body.value.type);
        if (!type.ok) return errorResponse(type.error.code, type.error.message, 400);
        const ttl = validateTtl(body.value.expirationTtl);
        if (!ttl.ok) return errorResponse(ttl.error.code, ttl.error.message, 400);
        await store.set(key.value, body.value.value, { type: type.value as KVType, expirationTtl: ttl.value });
        return runtimeResponse(buildOkEnvelope(), action);
      }

      await store.delete(key.value);
      return runtimeResponse(buildOkEnvelope(), action);
    } catch (error) {
      if (error instanceof PagesSDKError) {
        return errorResponse(error.code, error.message, error.status || 500);
      }
      return errorResponse(ERROR_CODES.KV_FAILED, 'Data request failed', 500);
    }
  };
}

type RuntimeAction = {
  operation: 'get' | 'set' | 'delete';
  dataScope: 'legacy-site' | 'site' | 'user';
};

function getRuntimeAction(pathname: string): RuntimeAction | null {
  if (pathname === RUNTIME.KV_GET_PATH) return { operation: 'get', dataScope: 'legacy-site' };
  if (pathname === RUNTIME.KV_SET_PATH) return { operation: 'set', dataScope: 'legacy-site' };
  if (pathname === RUNTIME.KV_DELETE_PATH) return { operation: 'delete', dataScope: 'legacy-site' };
  if (pathname === RUNTIME.DATA_SITE_GET_PATH) return { operation: 'get', dataScope: 'site' };
  if (pathname === RUNTIME.DATA_SITE_SET_PATH) return { operation: 'set', dataScope: 'site' };
  if (pathname === RUNTIME.DATA_SITE_DELETE_PATH) return { operation: 'delete', dataScope: 'site' };
  if (pathname === RUNTIME.DATA_USER_GET_PATH) return { operation: 'get', dataScope: 'user' };
  if (pathname === RUNTIME.DATA_USER_SET_PATH) return { operation: 'set', dataScope: 'user' };
  if (pathname === RUNTIME.DATA_USER_DELETE_PATH) return { operation: 'delete', dataScope: 'user' };
  return null;
}

function storeForAction(runtime: ReturnType<RuntimeFactory>, action: RuntimeAction): PagesDataStore {
  if (action.dataScope === 'user') return runtime.data.user;
  if (action.dataScope === 'site') return runtime.data.site;
  return runtime.kv;
}

function originFromHeader(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function hasJsonContentType(request: Request): boolean {
  return request.headers.get('Content-Type')?.toLowerCase().includes('application/json') ?? false;
}

async function parseBody(request: Request): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string }
> {
  try {
    const body: unknown = await request.json();
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return { ok: true, value: body as Record<string, unknown> };
    }
  } catch {
    return { ok: false, code: ERROR_CODES.INVALID_JSON, message: 'Invalid JSON body' };
  }

  return { ok: false, code: ERROR_CODES.INVALID_JSON, message: 'Invalid JSON body' };
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse(buildErrorEnvelope(code, message), status);
}

function runtimeResponse(body: unknown, action: RuntimeAction, status = 200): Response {
  const response = jsonResponse(body, status);
  if (action.dataScope === 'legacy-site') response.headers.set('Deprecation', 'true');
  return response;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
