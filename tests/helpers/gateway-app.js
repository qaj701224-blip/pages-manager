import { createGatewayApp as createRuntimeGatewayApp } from '../../apps/gateway/src/index.js';

import { GatewayStoreFixture } from './gateway-store-fixture.js';

export function createGatewayApp(options = {}) {
  return createRuntimeGatewayApp({
    store: new GatewayStoreFixture(),
    ...options,
  });
}
