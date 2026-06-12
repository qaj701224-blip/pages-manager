import {
  ERROR_CODES,
  HEADERS,
  RUNTIME,
  buildErrorEnvelope,
  buildOkEnvelope,
  validateKvType,
  validateTtl,
  validateUserKey,
} from '@xd/pages-runtime-protocol';
import { PagesSDKError } from './errors.js';
import type { KVType, PagesRuntimeEnv } from './types.js';

type RuntimeFactory = typeof import('./worker.js').createPagesRuntime;

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
      const runtime = createPagesRuntime({ env });
      if (action === 'get') {
        const type = validateKvType(body.value.type);
        if (!type.ok) return errorResponse(type.error.code, type.error.message, 400);
        const value = await runtime.kv.get(key.value, { type: type.value as KVType });
        return jsonResponse(buildOkEnvelope(value === null ? { found: false } : { found: true, value }));
      }

      if (action === 'put') {
        const type = validateKvType(body.value.type);
        if (!type.ok) return errorResponse(type.error.code, type.error.message, 400);
        const ttl = validateTtl(body.value.expirationTtl);
        if (!ttl.ok) return errorResponse(ttl.error.code, ttl.error.message, 400);
        await runtime.kv.put(key.value, body.value.value, { type: type.value as KVType, expirationTtl: ttl.value });
        return jsonResponse(buildOkEnvelope());
      }

      await runtime.kv.delete(key.value);
      return jsonResponse(buildOkEnvelope());
    } catch (error) {
      if (error instanceof PagesSDKError) {
        return errorResponse(error.code, error.message, error.status || 500);
      }
      return errorResponse(ERROR_CODES.KV_FAILED, 'KV request failed', 500);
    }
  };
}

function getRuntimeAction(pathname: string): 'get' | 'put' | 'delete' | null {
  if (pathname === RUNTIME.KV_GET_PATH) return 'get';
  if (pathname === RUNTIME.KV_PUT_PATH) return 'put';
  if (pathname === RUNTIME.KV_DELETE_PATH) return 'delete';
  return null;
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

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
