import { ERROR_CODES } from '../protocol.js';
import { PagesSDKError } from '../errors.js';
import type { KVType, PagesDataStore } from '../types.js';
import type { DataEndpointReader } from './capabilities.js';
import type { GatewayPost } from './gateway.js';

export function createDataStore(post: GatewayPost, readEndpoint: DataEndpointReader): PagesDataStore {
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
