import { ERROR_CODES, GATEWAY } from './protocol.js';
import { createHandlePagesRuntimeRequest } from './adapter.js';
import { PagesSDKError } from './errors.js';
import type { KVType, PagesKV, PagesRuntimeEnv } from './types.js';

export { PagesSDKError } from './errors.js';
export type { KVType, PagesRuntimeEnv } from './types.js';

const GATEWAY_ORIGIN = 'https://pages-kv-gateway.local';

export function createPagesRuntime(options: { env: PagesRuntimeEnv }): { kv: PagesKV } {
  const { env } = options;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await env.XD_PAGES_KV_GATEWAY.fetch(
      new Request(`${GATEWAY_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.XD_PAGES_KV_CAPABILITY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    );

    return readEnvelope(response);
  }

  async function get<T = unknown>(key: string, getOptions?: { type?: 'json' }): Promise<T | null>;
  async function get(key: string, getOptions: { type: 'text' }): Promise<string | null>;
  async function get<T = unknown>(key: string, getOptions: { type?: KVType } = {}): Promise<T | string | null> {
    const envelope = await post(GATEWAY.KV_GET_PATH, { key, type: getOptions.type ?? 'json' });
    if (typeof envelope.found !== 'boolean') {
      throw new PagesSDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
    }
    if (envelope.found === false) return null;
    return envelope.value as T | string;
  }

  async function put(
    key: string,
    value: unknown,
    putOptions: { type?: KVType; expirationTtl?: number } = {}
  ): Promise<void> {
    const body: { key: string; value: unknown; type: KVType; expirationTtl?: number } = {
      key,
      value,
      type: putOptions.type ?? 'json',
    };
    if (putOptions.expirationTtl !== undefined) body.expirationTtl = putOptions.expirationTtl;
    await post(GATEWAY.KV_PUT_PATH, body);
  }

  async function deleteKey(key: string): Promise<void> {
    await post(GATEWAY.KV_DELETE_PATH, { key });
  }

  return { kv: { get, put, delete: deleteKey } };
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
