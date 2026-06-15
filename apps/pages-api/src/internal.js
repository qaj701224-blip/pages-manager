import { jsonError, jsonOk, readJsonBody } from './http.js';

const EMPLOYEE_STATUSES = new Set(['active', 'disabled', 'left', 'unknown']);

export async function handleInternalApi(request, env, store) {
  if (!isInternalRequest(request)) return jsonError('NOT_FOUND', 'Endpoint not found.', 404);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/internal/users/upsert') {
    if (request.method !== 'POST') return methodNotAllowed();
    return upsertUser(request, env, store);
  }

  return null;
}

async function upsertUser(request, env, store) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const user = normalizeUser(body.user, readNow(env));
  if (!user) return jsonError('USER_SYNC_INVALID', 'User sync request is invalid.', 400);

  const record = await store.upsertUserFromSso(user);
  return jsonOk({
    user: {
      id: record.id,
      email: record.email,
      employeeStatus: record.employeeStatus,
      sessionVersion: record.sessionVersion,
      lastLoginAt: record.lastLoginAt,
    },
  });
}

function normalizeUser(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeRequiredString(value.id);
  const ssoSubject = normalizeRequiredString(value.ssoSubject) || id;
  const email = normalizeRequiredString(value.email).toLowerCase();
  const employeeStatus = normalizeRequiredString(value.employeeStatus).toLowerCase();
  const sessionVersion = Number.isInteger(value.sessionVersion) && value.sessionVersion > 0 ? value.sessionVersion : 1;
  if (!id || !ssoSubject || !email || !EMPLOYEE_STATUSES.has(employeeStatus)) return null;
  return {
    id,
    ssoSubject,
    email,
    name: normalizeOptionalString(value.name) || null,
    employeeStatus,
    sessionVersion,
    lastLoginAt: new Date(now * 1000).toISOString(),
    updatedAt: new Date(now * 1000).toISOString(),
  };
}

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isInternalRequest(request) {
  return new URL(request.url).hostname === 'pages-api.internal';
}

function readNow(env) {
  if (Number.isInteger(env?.now)) return env.now;
  if (typeof env?.nowSeconds === 'function') return env.nowSeconds();
  if (typeof env?.now === 'function') {
    const value = env.now();
    if (Number.isInteger(value)) return value;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
