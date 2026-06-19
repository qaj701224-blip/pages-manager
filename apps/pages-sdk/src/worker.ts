import { ERROR_CODES, GATEWAY } from './protocol.js';
import { createHandlePagesRuntimeRequest } from './adapter-core.js';
import { PagesSDKError } from './errors.js';
import type { KVType, PagesDataStore, PagesPlatformContext, PagesRuntimeEnv } from './types.js';

export { PagesSDKError } from './errors.js';
export type { KVType, PagesPlatformContext, PagesRuntimeEnv } from './types.js';

const GATEWAY_ORIGIN = 'https://pages-kv-gateway.local';
const KV_CAPABILITY_HEADER = 'CF-Platform-KV-Capability';
const DATA_SITE_CAPABILITY_HEADER = 'CF-Platform-Data-Site-Capability';
const DATA_USER_CAPABILITY_HEADER = 'CF-Platform-Data-User-Capability';
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const SITE_UUID_RE = /^[0-9a-f]{32}$/;

export function createPagesRuntime(options: { env: PagesRuntimeEnv; request?: Request }): {
  data: { site: PagesDataStore; user: PagesDataStore };
  /** @deprecated Use pages.data.site instead. */
  kv: PagesDataStore;
} {
  const { env, request } = options;
  const dataSitePaths = {
    get: GATEWAY.DATA_SITE_GET_PATH,
    set: GATEWAY.DATA_SITE_SET_PATH,
    delete: GATEWAY.DATA_SITE_DELETE_PATH,
  };
  const dataUserPaths = {
    get: GATEWAY.DATA_USER_GET_PATH,
    set: GATEWAY.DATA_USER_SET_PATH,
    delete: GATEWAY.DATA_USER_DELETE_PATH,
  };
  const legacyPaths = {
    get: GATEWAY.KV_GET_PATH,
    set: GATEWAY.KV_SET_PATH,
    delete: GATEWAY.KV_DELETE_PATH,
  };

  async function post(path: string, body: unknown, capability: string): Promise<Record<string, unknown>> {
    const response = await env.XD_PAGES_KV_GATEWAY.fetch(
      new Request(`${GATEWAY_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${capability}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    );

    return readEnvelope(response);
  }

  const data = {
    site: createDataStore(post, readSiteDataEndpoint(env, request, dataSitePaths, legacyPaths)),
    user: createDataStore(post, readDataEndpoint(readUserDataCapability(request), dataUserPaths)),
  };
  const kv = createDataStore(post, readDataEndpoint(readLegacyKvCapability(env, request), legacyPaths));

  return { data, kv };
}

type GatewayPaths = { get: string; set: string; delete: string };

function createDataStore(
  post: (path: string, body: unknown, capability: string) => Promise<Record<string, unknown>>,
  readEndpoint: () => { capability: string; paths: GatewayPaths }
): PagesDataStore {
  async function get<T = unknown>(key: string, getOptions?: { type?: 'json' }): Promise<T | null>;
  async function get(key: string, getOptions: { type: 'text' }): Promise<string | null>;
  async function get<T = unknown>(key: string, getOptions: { type?: KVType } = {}): Promise<T | string | null> {
    const endpoint = readEndpoint();
    const envelope = await post(endpoint.paths.get, { key, type: getOptions.type ?? 'json' }, endpoint.capability);
    if (typeof envelope.found !== 'boolean') {
      throw new PagesSDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
    }
    if (envelope.found === false) return null;
    return envelope.value as T | string;
  }

  async function set(
    key: string,
    value: unknown,
    setOptions: { type?: KVType; expirationTtl?: number } = {}
  ): Promise<void> {
    const body: { key: string; value: unknown; type: KVType; expirationTtl?: number } = {
      key,
      value,
      type: setOptions.type ?? 'json',
    };
    if (setOptions.expirationTtl !== undefined) body.expirationTtl = setOptions.expirationTtl;
    const endpoint = readEndpoint();
    await post(endpoint.paths.set, body, endpoint.capability);
  }

  async function deleteKey(key: string): Promise<void> {
    const endpoint = readEndpoint();
    await post(endpoint.paths.delete, { key }, endpoint.capability);
  }

  return { get, set, delete: deleteKey };
}

function readLegacyKvCapability(env: PagesRuntimeEnv, request?: Request): () => string {
  return () => requireCapability(env.XD_PAGES_KV_CAPABILITY || request?.headers.get(KV_CAPABILITY_HEADER), 'KV capability is missing');
}

function readUserDataCapability(request?: Request): () => string {
  return () => requireCapability(request?.headers.get(DATA_USER_CAPABILITY_HEADER), 'User data capability is missing');
}

function readDataEndpoint(readCapability: () => string, paths: GatewayPaths): () => { capability: string; paths: GatewayPaths } {
  return () => ({ capability: readCapability(), paths });
}

function readSiteDataEndpoint(
  env: PagesRuntimeEnv,
  request: Request | undefined,
  dataSitePaths: GatewayPaths,
  legacyPaths: GatewayPaths
): () => { capability: string; paths: GatewayPaths } {
  return () => {
    const requestSiteCapability = request?.headers.get(DATA_SITE_CAPABILITY_HEADER);
    if (requestSiteCapability) return { capability: requestSiteCapability, paths: dataSitePaths };
    if (env.XD_PAGES_DATA_SITE_CAPABILITY) {
      return { capability: env.XD_PAGES_DATA_SITE_CAPABILITY, paths: dataSitePaths };
    }
    const legacyCapability = env.XD_PAGES_KV_CAPABILITY || request?.headers.get(KV_CAPABILITY_HEADER);
    if (legacyCapability) return { capability: legacyCapability, paths: legacyPaths };
    return { capability: requireCapability(undefined, 'Site data capability is missing'), paths: dataSitePaths };
  };
}

function requireCapability(value: string | null | undefined, message: string): string {
  if (!value) throw new PagesSDKError(ERROR_CODES.INVALID_PLATFORM_CONTEXT, message);
  return value;
}

export function readPlatformContext(request: Request): PagesPlatformContext | null {
  const token = request.headers.get('CF-Platform-Auth');
  if (!token) return null;

  const payload = decodePlatformJwtPayload(token);
  const context = platformContextFromPayload(payload);
  requireHeaderValue(request.headers, 'CF-Platform-User', context.anonymous ? 'anonymous' : context.userId);
  requireHeaderValue(request.headers, 'CF-Platform-Site-Id', context.siteId);
  requireHeaderValue(request.headers, 'CF-Platform-Site-Slug', context.siteSlug);
  requireHeaderValue(request.headers, 'CF-Platform-Version', context.versionId);
  requireHeaderValue(request.headers, 'CF-Platform-Trace-Id', context.traceId);
  return context;
}

export const handlePagesRuntimeRequest = createHandlePagesRuntimeRequest(createPagesRuntime);

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw new PagesSDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status);
  }

  if (!isRecord(envelope) || typeof envelope.ok !== 'boolean') {
    throw new PagesSDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status);
  }

  if (!envelope.ok) {
    const error = isRecord(envelope.error) ? envelope.error : undefined;
    const code = typeof error?.code === 'string' ? error.code : ERROR_CODES.INVALID_RUNTIME_RESPONSE;
    const message = typeof error?.message === 'string' ? error.message : 'Runtime request failed';
    throw new PagesSDKError(code, message, response.status, error);
  }

  return envelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePlatformJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw invalidPlatformContext('Malformed platform token');
  }

  try {
    const payloadJson = decodeBase64Url(parts[1]);
    const payload: unknown = JSON.parse(payloadJson);
    if (!isRecord(payload)) throw new Error('payload is not an object');
    return payload;
  } catch {
    throw invalidPlatformContext('Malformed platform token payload');
  }
}

function platformContextFromPayload(payload: Record<string, unknown>): PagesPlatformContext {
  if (payload.purpose !== 'internal_worker_jwt') throw invalidPlatformContext('Platform token purpose is invalid');

  const anonymous = readBooleanClaim(payload, 'anonymous');
  const subject = readSafeStringClaim(payload, 'sub');
  if (anonymous && subject !== 'anonymous') throw invalidPlatformContext('Anonymous platform subject is invalid');

  return {
    authenticated: !anonymous,
    anonymous,
    userId: anonymous ? null : subject,
    siteId: readSafeStringClaim(payload, 'siteId'),
    siteUuid: readSiteUuidClaim(payload, 'siteUuid'),
    siteSlug: readSiteSlugClaim(payload, 'slug'),
    routeId: readSafeStringClaim(payload, 'routeId'),
    versionId: readSafeStringClaim(payload, 'versionId'),
    policyVersion: readPositiveIntegerClaim(payload, 'policyVersion'),
    traceId: readSafeStringClaim(payload, 'traceId'),
    environment: readSafeStringClaim(payload, 'env'),
  };
}

function requireHeaderValue(headers: Headers, name: string, expected: string | null): void {
  if (expected === null || headers.get(name) !== expected) {
    throw invalidPlatformContext(`Platform header ${name} does not match token claims`);
  }
}

function readSafeStringClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value;
}

function readSiteSlugClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !SITE_SLUG_RE.test(value)) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value;
}

function readSiteUuidClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !SITE_UUID_RE.test(value)) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value;
}

function readBooleanClaim(payload: Record<string, unknown>, name: string): boolean {
  const value = payload[name];
  if (typeof value !== 'boolean') throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  return value;
}

function readPositiveIntegerClaim(payload: Record<string, unknown>, name: string): number {
  const value = payload[name];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value as number;
}

function decodeBase64Url(value: string): string {
  if (/[^A-Za-z0-9_-]/.test(value)) throw new Error('Invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function invalidPlatformContext(message: string): PagesSDKError {
  return new PagesSDKError(ERROR_CODES.INVALID_PLATFORM_CONTEXT, message);
}
