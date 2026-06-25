import { ERROR_CODES } from '../protocol.js';
import { PagesSDKError } from '../errors.js';
import type { PagesRuntimeEnv } from '../types.js';
import { INTERNAL_GATEWAY_ORIGIN } from './constants.js';

export type GatewayPost = (path: string, body: unknown, capability: string) => Promise<Record<string, unknown>>;

export function createGatewayPost(env: PagesRuntimeEnv): GatewayPost {
  return async function post(path: string, body: unknown, capability: string): Promise<Record<string, unknown>> {
    const response = await env.XD_PAGES_KV_GATEWAY.fetch(
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
