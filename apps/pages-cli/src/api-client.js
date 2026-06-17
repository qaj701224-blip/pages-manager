export class ApiError extends Error {
  constructor({ status, code, message, action }) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'API_ERROR';
    this.action = action;
  }
}

export function createApiClient({ apiBaseUrl, authBaseUrl, credential = null, fetch = globalThis.fetch } = {}) {
  if (typeof fetch !== 'function') throw new Error('Fetch implementation is required.');

  return {
    requestApi(method, path, body, options = {}) {
      if (!credential?.value) {
        throw new ApiError({
          status: 401,
          code: 'PAGES_CREDENTIAL_REQUIRED',
          message: 'Pages credential is required.',
          action: 'Run `pages login` and retry.',
        });
      }
      return requestJson(fetch, buildUrl(apiBaseUrl, path), {
        method,
        body,
        bearer: credential.value,
        idempotencyKey: options.idempotencyKey,
      });
    },
    requestApiForm(method, path, form, options = {}) {
      if (!credential?.value) {
        throw new ApiError({
          status: 401,
          code: 'PAGES_CREDENTIAL_REQUIRED',
          message: 'Pages credential is required.',
          action: 'Run `pages login` and retry.',
        });
      }
      return requestForm(fetch, buildUrl(apiBaseUrl, path), {
        method,
        form,
        bearer: credential.value,
        idempotencyKey: options.idempotencyKey,
      });
    },
    requestAuth(method, path, body) {
      return requestJson(fetch, buildUrl(authBaseUrl, path), { method, body });
    },
  };
}

async function requestForm(fetch, url, { method, form, bearer, idempotencyKey }) {
  const headers = new Headers();
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);

  const response = await fetch(new Request(url, { method, headers, body: form }));
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const error = payload?.error || {};
    throw new ApiError({
      status: response.status,
      code: error.code || `HTTP_${response.status}`,
      message: error.message || response.statusText,
      action: error.action,
    });
  }
  return payload;
}

async function requestJson(fetch, url, { method, body, bearer, idempotencyKey }) {
  const headers = new Headers();
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);

  const init = {
    method,
    headers,
  };
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }

  const response = await fetch(new Request(url, init));
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const error = payload?.error || {};
    throw new ApiError({
      status: response.status,
      code: error.code || `HTTP_${response.status}`,
      message: error.message || response.statusText,
      action: error.action,
    });
  }
  return payload;
}

async function readResponsePayload(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get('Content-Type') || 'unknown';
    throw new ApiError({
      status: response.status,
      code: 'INVALID_JSON_RESPONSE',
      message: `服务返回了非 JSON 响应（HTTP ${response.status}，Content-Type: ${contentType}）。`,
      action:
        '请确认当前环境和服务域名是否正确；可运行 pages env 查看，staging 测试请加 --env staging 或先运行 pages env use staging。',
    });
  }
}

function buildUrl(base, path) {
  if (!path.startsWith('/')) throw new Error('API path must be absolute.');
  return new URL(path, base).toString();
}
