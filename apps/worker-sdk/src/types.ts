export type KVValueType = 'json' | 'text';

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface RuntimeEnv {
  [binding: string]: unknown;
}

export interface RuntimeContext {
  authenticated: boolean;
  anonymous: boolean;
  userId: string | null;
  siteId: string;
  siteUuid: string;
  siteSlug: string;
  routeId: string;
  versionId: string;
  policyVersion: number;
  traceId: string;
  environment: string;
}

export interface KVGetOptions {
  type?: KVValueType;
}

export interface KVPutOptions<TMetadata = unknown> {
  type?: KVValueType;
  expiration?: number;
  expirationTtl?: number;
  metadata?: TMetadata;
}

export interface KVGetWithMetadataResult<TValue = string, TMetadata = unknown> {
  value: TValue | null;
  metadata: TMetadata | null;
}

export interface KVListKey<TMetadata = unknown> {
  name: string;
  expiration?: number;
  metadata?: TMetadata;
}

export interface KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface KVListResult<TMetadata = unknown> {
  keys: KVListKey<TMetadata>[];
  list_complete: boolean;
  cursor?: string;
}

export interface KVNamespace {
  get(key: string, options?: { type?: 'text' }): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  getWithMetadata<TMetadata = unknown>(
    key: string,
    options?: { type?: 'text' }
  ): Promise<KVGetWithMetadataResult<string, TMetadata>>;
  getWithMetadata<T = unknown, TMetadata = unknown>(
    key: string,
    options: { type: 'json' }
  ): Promise<KVGetWithMetadataResult<T, TMetadata>>;
  list<TMetadata = unknown>(options?: KVListOptions): Promise<KVListResult<TMetadata>>;
  put<TMetadata = unknown>(key: string, value: string, options?: KVPutOptions<TMetadata> & { type?: 'text' }): Promise<void>;
  put<TMetadata = unknown>(
    key: string,
    value: unknown,
    options: KVPutOptions<TMetadata> & { type: 'json' }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Runtime {
  kv: KVNamespace;
}
