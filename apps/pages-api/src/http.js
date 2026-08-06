import { jsonResponse } from '@xd/worker-kit';

export function jsonOk(data, status = 200) {
  return jsonResponse(data, status, { 'Cache-Control': 'no-store' });
}

export function jsonError(code, message, status, action, diagnostics = {}) {
  const error = { code, message };
  if (action) error.action = action;
  if (typeof diagnostics.retryable === 'boolean') error.retryable = diagnostics.retryable;
  return jsonResponse({ error }, status, { 'Cache-Control': 'no-store' });
}

export class JsonBodyTooLargeError extends Error {
  constructor() {
    super('JSON body is too large');
    this.name = 'JsonBodyTooLargeError';
    this.code = 'JSON_BODY_TOO_LARGE';
  }
}

export async function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!isJsonContentType(contentType)) throw new Error('JSON content type is required');

  const text = await request.text();
  if (new globalThis.TextEncoder().encode(text).byteLength > maxBytes) throw new JsonBodyTooLargeError();

  try {
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object is required');
    return parsed;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function isJsonContentType(value) {
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}
