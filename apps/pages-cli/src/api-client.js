const PUBLIC_REASONS = new Set([
  'auth_session_unavailable',
  'cli_login_confirm_forbidden',
  'cli_login_confirm_invalid',
  'cli_login_confirm_unavailable',
  'cli_login_invalid_or_expired',
  'cli_login_unavailable',
  'oauth_request_invalid',
  'oauth_state_invalid_or_expired',
  'sso_profile_invalid',
  'sso_profile_unavailable',
  'sso_token_unavailable',
  'sso_user_inactive',
  'sso_user_sync_failed',
]);
const PUBLIC_STEPS = new Set([
  'auth.session',
  'cli.confirm',
  'cli.poll',
  'cli.start',
  'oauth.authorize',
  'oauth.callback',
  'oauth.state',
  'sso.profile',
  'sso.provider',
  'sso.token',
  'sso.user',
  'sso.user_sync',
]);
const PUBLIC_DETAIL_KEYS = new Set(['httpStatus', 'providerEndpointType']);
const PUBLIC_PROVIDER_ENDPOINT_TYPES = new Set(['sso_authorization', 'sso_token', 'sso_profile']);

export class ApiError extends Error {
  constructor({ status, code, message, action, reason, step, requestId, retryable, details }) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'API_ERROR';
    this.action = action;
    Object.assign(this, readPublicDiagnostics({ reason, step, requestId, retryable, details }));
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
      ...readPublicDiagnostics(error),
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
      ...readPublicDiagnostics(error),
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
      action: '请确认 CLI 登录状态、服务地址和网络访问是否正确；如果是内部测试环境，请按维护文档切换环境后重试。',
    });
  }
}

function buildUrl(base, path) {
  if (!path.startsWith('/')) throw new Error('API path must be absolute.');
  return new URL(path, base).toString();
}

export function readPublicDiagnostics(error) {
  const diagnostics = {};
  if (isPublicReason(error.reason)) diagnostics.reason = error.reason;
  if (isPublicStep(error.step)) diagnostics.step = error.step;
  if (isPublicRequestId(error.requestId)) diagnostics.requestId = error.requestId;
  if (typeof error.retryable === 'boolean') diagnostics.retryable = error.retryable;
  const details = sanitizePublicDetails(error.details);
  if (details) diagnostics.details = details;
  return diagnostics;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPublicReason(value) {
  return typeof value === 'string' && value !== '' && PUBLIC_REASONS.has(value);
}

function isPublicStep(value) {
  return typeof value === 'string' && value !== '' && PUBLIC_STEPS.has(value);
}

function isPublicRequestId(value) {
  return typeof value === 'string' && /^req_(?:[a-f0-9]{32}|test_[A-Za-z0-9._-]{1,64})$/.test(value);
}

function sanitizePublicDetails(details) {
  if (!isPlainObject(details)) return null;

  const safeDetails = {};
  for (const key of PUBLIC_DETAIL_KEYS) {
    if (Object.hasOwn(details, key) && isPublicDetailValue(key, details[key])) safeDetails[key] = details[key];
  }
  return Object.keys(safeDetails).length > 0 ? safeDetails : null;
}

function isPublicDetailValue(key, value) {
  if (key === 'httpStatus') return Number.isInteger(value) && value >= 100 && value <= 599;
  if (key === 'providerEndpointType') return PUBLIC_PROVIDER_ENDPOINT_TYPES.has(value);
  return false;
}
