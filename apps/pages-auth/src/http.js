import { jsonResponse } from '@xd/worker-kit';

const SENSITIVE_QUERY_KEYS = new Set(['code', 'state', 'access_token', 'client_secret', 'login_secret', 'token']);

export function jsonOk(data, status = 200) {
  return jsonResponse(data, status, { 'Cache-Control': 'no-store' });
}

export function jsonError(code, message, status, action) {
  const error = { code, message };
  if (action) error.action = action;
  return jsonResponse({ error }, status, { 'Cache-Control': 'no-store' });
}

export async function readJsonBody(request, { maxBytes = 4096 } = {}) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!isJsonContentType(contentType)) throw new Error('JSON content type is required');

  const text = await request.text();
  if (new globalThis.TextEncoder().encode(text).byteLength > maxBytes) throw new Error('JSON body is too large');

  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export function safeRedirect(location, status = 302) {
  if (!Number.isInteger(status) || status < 300 || status > 399) throw new Error('Invalid redirect status');

  const url = parseUrl(location, 'Invalid redirect URL');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid redirect URL');
  if (url.username || url.password || url.hash) throw new Error('Invalid redirect URL');

  return new Response(null, {
    status,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export function redactUrl(value) {
  const url = parseUrl(value, 'Invalid URL');
  for (const key of SENSITIVE_QUERY_KEYS) {
    if (url.searchParams.has(key)) url.searchParams.set(key, '[REDACTED]');
  }
  return url.toString();
}

function isJsonContentType(value) {
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function parseUrl(value, message) {
  try {
    return new URL(String(value || ''));
  } catch {
    throw new Error(message);
  }
}
