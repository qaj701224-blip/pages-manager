import { ERROR_CODES, HEADERS, RUNTIME } from '@xd/pages-runtime-protocol';
import { PagesSDKError } from './errors.js';
import type { KVType, PagesKV } from './types.js';

export { PagesSDKError } from './errors.js';
export type { KVType } from './types.js';

export function createPagesClient(options: { basePath?: string; fetch?: typeof fetch } = {}): { kv: PagesKV } {
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

  return {
    kv: {
      async get<T = unknown>(key: string, getOptions: { type?: KVType } = {}): Promise<T | string | null> {
        const envelope = await post('/kv/get', { key, type: getOptions.type ?? 'json' });
        if (envelope.found === false) return null;
        return envelope.value as T | string;
      },
      async put(key: string, value: unknown, putOptions: { type?: KVType; expirationTtl?: number } = {}): Promise<void> {
        const body: { key: string; value: unknown; type: KVType; expirationTtl?: number } = {
          key,
          value,
          type: putOptions.type ?? 'json',
        };
        if (putOptions.expirationTtl !== undefined) body.expirationTtl = putOptions.expirationTtl;
        await post('/kv/put', body);
      },
      async delete(key: string): Promise<void> {
        await post('/kv/delete', { key });
      },
    },
  };
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
