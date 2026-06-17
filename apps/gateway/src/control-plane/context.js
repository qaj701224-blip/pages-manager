import { jsonResponse } from '@xd/worker-kit';

export function required(value, name) {
  if (value === undefined || value === null || value === '') {
    const error = new Error(`${name} is required`);
    error.status = 400;
    throw error;
  }
  return value;
}

export function getStore(env) {
  if (!env.store) {
    env.store = env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  }
  if (!env.store) {
    const error = new Error('Gateway store is not configured');
    error.status = 500;
    throw error;
  }
  return env.store;
}

export function verifyInternalCallbackToken(request, env) {
  if (!env.INTERNAL_CALLBACK_TOKEN) return null;

  const token = request.headers.get('X-Pages-Callback-Token');
  if (token === env.INTERNAL_CALLBACK_TOKEN) return null;

  return jsonResponse({ error: 'Invalid callback token' }, 401);
}
