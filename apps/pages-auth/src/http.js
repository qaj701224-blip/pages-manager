import { jsonResponse } from '@xd/worker-kit';

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
const PUBLIC_ERROR_DEFAULTS = new Map([
  ['AUTH_SESSION_CREATE_FAILED', { reason: 'auth_session_unavailable', step: 'auth.session' }],
  ['AUTH_SESSION_REQUIRED', { reason: 'auth_session_unavailable', step: 'auth.session' }],
  ['CLI_LOGIN_CONFIRM_CREATE_FAILED', { reason: 'cli_login_confirm_unavailable', step: 'cli.confirm' }],
  ['CLI_LOGIN_CONFIRM_FAILED', { reason: 'cli_login_confirm_unavailable', step: 'cli.confirm' }],
  ['CLI_LOGIN_CONFIRM_INVALID', { reason: 'cli_login_confirm_invalid', step: 'cli.confirm' }],
  ['CLI_LOGIN_CONFIRM_ORIGIN_FORBIDDEN', { reason: 'cli_login_confirm_forbidden', step: 'cli.confirm' }],
  ['CLI_LOGIN_CONFIRM_TOKEN_FORBIDDEN', { reason: 'cli_login_confirm_forbidden', step: 'cli.confirm' }],
  ['CLI_LOGIN_CONSUMED', { reason: 'cli_login_invalid_or_expired', step: 'cli.poll' }],
  ['CLI_LOGIN_ENV_MISMATCH', { reason: 'cli_login_invalid_or_expired', step: 'cli.poll' }],
  ['CLI_LOGIN_INVALID', { reason: 'cli_login_invalid_or_expired', step: 'cli.poll' }],
  ['CLI_LOGIN_EXCHANGE_FAILED', { reason: 'cli_login_unavailable', step: 'cli.poll' }],
  ['CLI_LOGIN_UNAVAILABLE', { reason: 'cli_login_unavailable', step: 'cli.start' }],
  ['OAUTH_AUTHORIZE_INVALID', { reason: 'oauth_request_invalid', step: 'oauth.authorize' }],
  ['OAUTH_CALLBACK_INVALID', { reason: 'oauth_request_invalid', step: 'oauth.callback' }],
  ['OAUTH_STATE_INVALID', { reason: 'oauth_state_invalid_or_expired', step: 'oauth.state' }],
  ['SSO_EXCHANGE_FAILED', { reason: 'sso_token_unavailable', step: 'sso.token' }],
  ['SSO_PROFILE_INACTIVE', { reason: 'sso_user_inactive', step: 'sso.user' }],
  ['SSO_PROFILE_INVALID', { reason: 'sso_profile_invalid', step: 'sso.profile' }],
  ['SSO_PROVIDER_UNCONFIGURED', { reason: 'sso_token_unavailable', step: 'sso.provider' }],
  ['SSO_USER_SYNC_FAILED', { reason: 'sso_user_sync_failed', step: 'sso.user_sync' }],
]);

export function jsonOk(data, status = 200) {
  return jsonResponse(data, status, { 'Cache-Control': 'no-store' });
}

export function jsonError(code, message, status, actionOrOptions) {
  const error = buildPublicError(code, message, actionOrOptions);
  return jsonResponse({ error }, status, { 'Cache-Control': 'no-store' });
}

export async function withRequestId(response, requestId) {
  if (!isPublicRequestId(requestId)) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  if (response.status < 400 || !isJsonResponse(response)) {
    return cloneResponse(response, response.body, headers);
  }

  const { body, changed } = await addRequestIdToJsonBody(response, requestId);
  if (changed) headers.delete('Content-Length');
  return cloneResponse(response, body, headers);
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
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function isPublicRequestId(value) {
  return typeof value === 'string' && /^req_(?:[a-f0-9]{32}|test_[A-Za-z0-9._-]{1,64})$/.test(value);
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

function buildPublicError(code, message, actionOrOptions) {
  const error = { code, message };
  const options = readErrorOptions(actionOrOptions);
  const defaults = PUBLIC_ERROR_DEFAULTS.get(code) || {};
  const reason = isPublicReason(options.reason) ? options.reason : defaults.reason;
  const step = isPublicStep(options.step) ? options.step : defaults.step;
  if (isPublicString(options.action)) error.action = options.action;
  if (isPublicReason(reason)) error.reason = reason;
  if (isPublicStep(step)) error.step = step;
  if (isPublicRequestId(options.requestId)) error.requestId = options.requestId;
  if (typeof options.retryable === 'boolean') error.retryable = options.retryable;
  const details = sanitizePublicDetails(options.details);
  if (details) error.details = details;
  return error;
}

function readErrorOptions(value) {
  if (!value) return {};
  if (typeof value === 'string') return { action: value };
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function isPublicString(value) {
  return typeof value === 'string' && value !== '';
}

function isPublicReason(value) {
  return isPublicString(value) && PUBLIC_REASONS.has(value);
}

function isPublicStep(value) {
  return isPublicString(value) && PUBLIC_STEPS.has(value);
}

function sanitizePublicDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;

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

function isJsonResponse(response) {
  const contentType = response.headers.get('Content-Type') || '';
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function cloneResponse(response, body, headers) {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function addRequestIdToJsonBody(response, requestId) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { body: text, changed: false };
  }

  if (payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)) {
    payload.error = {
      ...payload.error,
      requestId,
    };
    return { body: JSON.stringify(payload), changed: true };
  }
  return { body: text, changed: false };
}
