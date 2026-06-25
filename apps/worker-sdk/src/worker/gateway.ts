import { ERROR_CODES } from '../protocol.js';
import { SDKError } from '../errors.js';
import type { Fetcher, RuntimeEnv } from '../types.js';
import { INTERNAL_GATEWAY_ORIGIN } from './constants.js';

export type GatewayPost = (path: string, body: unknown, capability: string) => Promise<Record<string, unknown>>;

const GATEWAY_BINDING_NAMES = ['XD_CELL_KV_GATEWAY', 'XD_PAGES_KV_GATEWAY'] as const;

export function createGatewayPost(env: RuntimeEnv): GatewayPost {
  const gateway = readGatewayBinding(env);
  return async function post(path: string, body: unknown, capability: string): Promise<Record<string, unknown>> {
    const response = await gateway.fetch(
      new Request(`${INTERNAL_GATEWAY_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${capability}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    );

    return readEnvelope(response);
  };
}

function readGatewayBinding(env: RuntimeEnv): Fetcher {
  for (const name of GATEWAY_BINDING_NAMES) {
    const value = env[name];
    if (isFetcher(value)) return value;
  }
  throw new SDKError(ERROR_CODES.INVALID_PLATFORM_CONTEXT, 'KV gateway binding is missing');
}

function isFetcher(value: unknown): value is Fetcher {
  return typeof value === 'object' && value !== null && 'fetch' in value && typeof value.fetch === 'function';
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw new SDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status);
  }

  if (!isRecord(envelope) || typeof envelope.ok !== 'boolean') {
    throw new SDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response', response.status);
  }

  if (!envelope.ok) {
    const error = isRecord(envelope.error) ? envelope.error : undefined;
    const code = typeof error?.code === 'string' ? error.code : ERROR_CODES.INVALID_RUNTIME_RESPONSE;
    const message = typeof error?.message === 'string' ? error.message : 'Runtime request failed';
    throw new SDKError(code, message, response.status, error);
  }

  return envelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
