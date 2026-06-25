import { jsonResponse } from '@xd/worker-kit';

import { getStore } from './context.js';

export async function handleHealth(_request, env = {}) {
  const store = env.store || env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__ || {};
  return jsonResponse({
    status: 'ok',
    service: 'pages-gateway',
    storeBackend: store.backend || env.PAGES_STORE_BACKEND || 'memory',
  });
}

export async function handleReady(_request, env = {}) {
  const store = getStore(env);

  try {
    const health = store.health ? await store.health() : { ok: true, backend: store.backend || 'unknown' };
    return jsonResponse({
      status: 'ready',
      service: 'pages-gateway',
      storeBackend: health.backend || store.backend || env.PAGES_STORE_BACKEND || 'memory',
    });
  } catch (error) {
    return jsonResponse(
      {
        status: 'not_ready',
        service: 'pages-gateway',
        storeBackend: store.backend || env.PAGES_STORE_BACKEND || 'unknown',
        error: error.message,
      },
      503
    );
  }
}
