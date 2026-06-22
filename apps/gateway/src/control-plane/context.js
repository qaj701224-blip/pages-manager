import { jsonResponse } from '@xd/worker-kit';

function flagFromEnv(value) {
  if (value === undefined || value === null || value === '') return null;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return null;
}

function shouldRequireSecret(env = {}, flagName) {
  const configured = flagFromEnv(env[flagName]);
  if (configured !== null) return configured;
  return env.NODE_ENV === 'production';
}

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
  if (!env.INTERNAL_CALLBACK_TOKEN) {
    if (shouldRequireSecret(env, 'INTERNAL_CALLBACK_TOKEN_REQUIRED')) {
      return jsonResponse({ error: 'Internal callback token is not configured' }, 500);
    }
    return null;
  }

  const token = request.headers.get('X-Pages-Callback-Token');
  if (token === env.INTERNAL_CALLBACK_TOKEN) return null;

  return jsonResponse({ error: 'Invalid callback token' }, 401);
}

export function verifyGatewayApiToken(request, env) {
  const expected = env.PAGES_GATEWAY_API_TOKEN || env.PAGES_INTERNAL_API_TOKEN;
  if (!expected) {
    if (shouldRequireSecret(env, 'PAGES_GATEWAY_API_TOKEN_REQUIRED')) {
      return jsonResponse({ error: 'Gateway API token is not configured' }, 500);
    }
    return null;
  }

  const token = request.headers.get('X-Pages-Gateway-Token') || request.headers.get('X-Pages-Internal-Token');
  if (token === expected) return null;

  return jsonResponse({ error: 'Invalid gateway API token' }, 401);
}
