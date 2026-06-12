export type KVType = 'json' | 'text';

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface PagesRuntimeEnv {
  XD_PAGES_KV_GATEWAY: Fetcher;
  XD_PAGES_KV_CAPABILITY: string;
  XD_PAGES_SITE_ID?: string;
  XD_PAGES_SITE_UUID?: string;
  XD_PAGES_ENV?: string;
}

export interface PagesKV {
  get<T = unknown>(key: string, options?: { type?: KVType }): Promise<T | string | null>;
  put(key: string, value: unknown, options?: { type?: KVType; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
