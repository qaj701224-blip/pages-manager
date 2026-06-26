import { ERROR_CODES } from '../protocol.js';
import { SDKError } from '../errors.js';
import type {
  KVGetWithMetadataResult,
  KVListKey,
  KVListOptions,
  KVListResult,
  KVNamespace,
  KVPutOptions,
  KVValueType,
} from '../types.js';
import type { DataEndpointReader } from './capabilities.js';
import type { GatewayPost } from './gateway.js';

export function createDataStore(post: GatewayPost, readEndpoint: DataEndpointReader): KVNamespace {
  async function get(key: string, getOptions?: { type?: 'text' }): Promise<string | null>;
  async function get<T = unknown>(key: string, getOptions: { type: 'json' }): Promise<T | null>;
  async function get<T = unknown>(key: string, getOptions: { type?: KVValueType } = {}): Promise<T | string | null> {
    const endpoint = readEndpoint();
    const envelope = await post(endpoint.paths.get, { key, type: getOptions.type ?? 'text' }, endpoint.capability);
    if (typeof envelope.found !== 'boolean') {
      throw new SDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
    }
    if (envelope.found === false) return null;
    return envelope.value as T | string;
  }

  async function put(key: string, value: string, setOptions?: { type?: 'text'; expirationTtl?: number }): Promise<void>;
  async function put(key: string, value: unknown, setOptions: { type: 'json'; expirationTtl?: number }): Promise<void>;
  async function put(
    key: string,
    value: unknown,
    setOptions: KVPutOptions & { type?: KVValueType } = {}
  ): Promise<void> {
    const body: { key: string; value: unknown; type: KVValueType; expirationTtl?: number; expiration?: number; metadata?: unknown } = {
      key,
      value,
      type: setOptions.type ?? 'text',
    };
    if (setOptions.expirationTtl !== undefined) body.expirationTtl = setOptions.expirationTtl;
    if (setOptions.expiration !== undefined) body.expiration = setOptions.expiration;
    if (setOptions.metadata !== undefined) body.metadata = setOptions.metadata;
    const endpoint = readEndpoint();
    await post(endpoint.paths.set, body, endpoint.capability);
  }

  async function getWithMetadata<TMetadata = unknown>(
    key: string,
    getOptions?: { type?: 'text' }
  ): Promise<KVGetWithMetadataResult<string, TMetadata>>;
  async function getWithMetadata<T = unknown, TMetadata = unknown>(
    key: string,
    getOptions: { type: 'json' }
  ): Promise<KVGetWithMetadataResult<T, TMetadata>>;
  async function getWithMetadata<T = unknown, TMetadata = unknown>(
    key: string,
    getOptions: { type?: KVValueType } = {}
  ): Promise<KVGetWithMetadataResult<T | string, TMetadata>> {
    const endpoint = readEndpoint();
    const envelope = await post(
      endpoint.paths.getWithMetadata,
      { key, type: getOptions.type ?? 'text' },
      endpoint.capability
    );
    if (typeof envelope.found !== 'boolean') {
      throw new SDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
    }
    if (envelope.found === false) return { value: null, metadata: null };
    return {
      value: envelope.value as T | string,
      metadata: (envelope.metadata ?? null) as TMetadata | null,
    };
  }

  async function list<TMetadata = unknown>(options: KVListOptions = {}): Promise<KVListResult<TMetadata>> {
    const endpoint = readEndpoint();
    const body: KVListOptions = {};
    if (options.prefix !== undefined) body.prefix = options.prefix;
    if (options.limit !== undefined) body.limit = options.limit;
    if (options.cursor !== undefined) body.cursor = options.cursor;

    const envelope = await post(endpoint.paths.list, body, endpoint.capability);
    if (!Array.isArray(envelope.keys) || typeof envelope.list_complete !== 'boolean') {
      throw new SDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
    }
    const result: KVListResult<TMetadata> = {
      keys: envelope.keys.map(readListKey<TMetadata>),
      list_complete: envelope.list_complete,
    };
    if (typeof envelope.cursor === 'string') result.cursor = envelope.cursor;
    return result;
  }

  async function deleteKey(key: string): Promise<void> {
    const endpoint = readEndpoint();
    await post(endpoint.paths.delete, { key }, endpoint.capability);
  }

  return { get, getWithMetadata, list, put, delete: deleteKey };
}

function readListKey<TMetadata>(value: unknown): KVListKey<TMetadata> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string') {
    throw new SDKError(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'Invalid runtime response');
  }
  const key: KVListKey<TMetadata> = { name: record.name };
  if (typeof record.expiration === 'number') key.expiration = record.expiration;
  if (record.metadata !== undefined) key.metadata = record.metadata as TMetadata;
  return key;
}
