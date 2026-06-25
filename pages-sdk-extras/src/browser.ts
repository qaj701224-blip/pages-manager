import { ERROR_CODES, HEADERS, RUNTIME } from './protocol.js';
import { PagesSDKError } from './errors.js';
import type { KVType, PagesClient, PagesDataStore } from './types.js';

export { PagesSDKError } from './errors.js';
export type { KVType } from './types.js';

export function createPagesClient(options: { basePath?: string; fetch?: typeof fetch } = {}): PagesClient {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const basePath = options.basePath ?? RUNTIME.BASE_PATH;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetchFn(buildRuntimePath(basePath, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADERS.RUNTIME_REQUEST]: '1',
      },
      body: JSON.stringify(body),
    });

    return readEnvelope(response);
  }

  const legacySite = createDataStore(post, {
    get: '/kv/get',
    set: '/kv/set',
    delete: '/kv/delete',
  });
  const data = {
    site: createDataStore(post, {
      get: '/data/site/get',
      set: '/data/site/set',
      delete: '/data/site/delete',
    }),
    user: createDataStore(post, {
      get: '/data/user/get',
      set: '/data/user/set',
      delete: '/data/user/delete',
    }),
  };

  return { data, kv: legacySite };
}

function createDataStore(
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>,
  paths: { get: string; set: string; delete: string }
): PagesDataStore {
  async function get<T = unknown>(key: string, getOptions?: { type?: 'json' }): Promise<T | null>;
  async function get(key: string, getOptions: { type: 'text' }): Promise<string | null>;
  async function get<T = unknown>(key: string, getOptions: { type?: KVType } = {}): Promise<T | string | null> {
    const envelope = await post(paths.get, { key, type: getOptions.type ?? 'json' });
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
    await post(paths.set, body);
  }

  async function deleteKey(key: string): Promise<void> {
    await post(paths.delete, { key });
  }

  return { get, set, delete: deleteKey };
}

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

function buildRuntimePath(basePath: string, actionPath: string): string {
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return `${normalizedBase}${actionPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
