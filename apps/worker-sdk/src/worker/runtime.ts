import type { Runtime, RuntimeEnv } from '../types.js';
import { readSiteDataEndpoint } from './capabilities.js';
import { createDataStore } from './data-store.js';
import { createGatewayPost } from './gateway.js';
import { createOfficeNet } from './office-net.js';

export function createRuntime(options: { env: RuntimeEnv; request?: Request }): Runtime {
  const { env, request } = options;
  const post = createGatewayPost(env);
  const kv = createDataStore(post, readSiteDataEndpoint(env, request));
  const officeNet = createOfficeNet(env);

  return { kv, officeNet };
}
