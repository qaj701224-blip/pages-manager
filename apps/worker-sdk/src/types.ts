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

export interface KVPutOptions {
  type?: KVValueType;
  expirationTtl?: number;
}

export interface KVNamespace {
  get(key: string, options?: { type?: 'text' }): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  put(key: string, value: string, options?: { type?: 'text'; expirationTtl?: number }): Promise<void>;
  put(key: string, value: unknown, options: { type: 'json'; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Runtime {
  kv: KVNamespace;
}
