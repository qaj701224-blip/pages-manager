import type { PagesDataStore, PagesRuntimeEnv } from '../types.js';
import { readLegacyKvEndpoint, readSiteDataEndpoint, readUserDataEndpoint } from './capabilities.js';
import { createDataStore } from './data-store.js';
import { createGatewayPost } from './gateway.js';

export function createPagesRuntime(options: { env: PagesRuntimeEnv; request?: Request }): {
  data: { site: PagesDataStore; user: PagesDataStore };
  /** @deprecated Use pages.data.site instead. */
  kv: PagesDataStore;
} {
  const { env, request } = options;
  const post = createGatewayPost(env);
  const data = {
    site: createDataStore(post, readSiteDataEndpoint(env, request)),
    user: createDataStore(post, readUserDataEndpoint(request)),
  };
  const kv = createDataStore(post, readLegacyKvEndpoint(env, request));

  return { data, kv };
}
