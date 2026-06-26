import { jsonError, jsonOk, readJsonBody } from './http.js';

const EMPLOYEE_STATUSES = new Set(['active', 'disabled', 'left', 'unknown']);

export async function handleInternalApi(request, env, store) {
  if (!isInternalRequest(request)) return jsonError('NOT_FOUND', 'Endpoint not found.', 404);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/internal/users/upsert') {
    if (request.method !== 'POST') return methodNotAllowed();
    return upsertUser(request, env, store);
  }
  if (url.pathname === '/.xd-pages/internal/hostname-claims/acquire') {
    if (request.method !== 'POST') return methodNotAllowed();
    return acquireHostnameClaim(request, env, store);
  }
  if (url.pathname === '/.xd-pages/internal/hostname-claims/confirm') {
    if (request.method !== 'POST') return methodNotAllowed();
    return confirmHostnameClaim(request, env, store);
  }
  if (url.pathname === '/.xd-pages/internal/hostname-claims/release') {
    if (request.method !== 'POST') return methodNotAllowed();
    return releaseHostnameClaim(request, env, store);
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
      userId: record.id,
      email: record.email,
      employeeStatus: record.employeeStatus,
      sessionVersion: record.sessionVersion,
      lastLoginAt: record.lastLoginAt,
    },
  });
}

async function acquireHostnameClaim(request, env, store) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const claim = normalizeClaim(body.claim);
  if (!claim) return jsonError('HOSTNAME_CLAIM_INVALID', 'Hostname claim request is invalid.', 400);

  const result = await store.acquireHostnameClaim({
    ...claim,
    acquiredAt: new Date(readNow(env) * 1000).toISOString(),
  });
  if (!result.ok) {
    return jsonError(
      result.code || 'HOSTNAME_CLAIM_CONFLICT',
      'Hostname is already claimed.',
      409,
      'Use the original owner or choose another site name.'
    );
  }
  return jsonOk({ claim: result.claim });
}

async function confirmHostnameClaim(request, env, store) {
  const claim = await readAndNormalizeClaimRequest(request);
  if (claim instanceof Response) return claim;

  const result = await store.confirmHostnameClaim({
    ...claim,
    confirmedAt: new Date(readNow(env) * 1000).toISOString(),
  });
  if (!result.ok) {
    return jsonError(result.code || 'HOSTNAME_CLAIM_NOT_FOUND', 'Hostname claim was not found.', 404);
  }
  return jsonOk({ claim: result.claim });
}

async function releaseHostnameClaim(request, env, store) {
  const claim = await readAndNormalizeClaimRequest(request);
  if (claim instanceof Response) return claim;

  const result = await store.releaseHostnameClaim({
    ...claim,
    releaseReason: claim.releaseReason || 'v1_deploy_failed',
    releasedAt: new Date(readNow(env) * 1000).toISOString(),
  });
  if (!result.ok) {
    return jsonError(result.code || 'HOSTNAME_CLAIM_NOT_FOUND', 'Hostname claim was not found.', 404);
  }
  return jsonOk({ claim: result.claim });
}

async function readAndNormalizeClaimRequest(request) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const claim = normalizeClaim(body.claim);
  if (!claim) return jsonError('HOSTNAME_CLAIM_INVALID', 'Hostname claim request is invalid.', 400);
  claim.releaseReason = normalizeOptionalString(body.claim?.releaseReason) || null;
  claim.reuseHoldUntil = normalizeOptionalIsoString(body.claim?.reuseHoldUntil);
  return claim;
}

function normalizeUser(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const userId = normalizeRequiredString(value.userId);
  const email = normalizeRequiredString(value.email).toLowerCase();
  const employeeStatus = normalizeRequiredString(value.employeeStatus).toLowerCase();
  const sessionVersion = Number.isInteger(value.sessionVersion) && value.sessionVersion > 0 ? value.sessionVersion : 1;
  if (!userId || !email || !EMPLOYEE_STATUSES.has(employeeStatus)) return null;
  return {
    id: userId,
    userId,
    email,
    realname: normalizeOptionalString(value.realname) || null,
    account: normalizeOptionalString(value.account) || null,
    accountId: normalizeOptionalString(value.accountId) || null,
    employeenum: normalizeOptionalString(value.employeenum) || null,
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

function normalizeOptionalIsoString(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  if (Number.isNaN(Date.parse(normalized))) return null;
  return normalized;
}

function normalizeClaim(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const environment = normalizeRequiredString(value.environment);
  const hostname = normalizeRequiredString(value.hostname).toLowerCase();
  const normalizedSlug = normalizeRequiredString(value.normalizedSlug);
  const hostnameFamily = normalizeRequiredString(value.hostnameFamily);
  const ownerSystem = normalizeRequiredString(value.ownerSystem);
  const ownerId = normalizeRequiredString(value.ownerId);
  const source = normalizeRequiredString(value.source);
  if (!['production', 'staging', 'local'].includes(environment)) return null;
  if (!hostname || !normalizedSlug || !hostnameFamily || !ownerSystem || !ownerId || !source) return null;
  return {
    environment,
    hostname,
    normalizedSlug,
    hostnameFamily,
    ownerSystem,
    ownerId,
    ownerRef: normalizeOptionalString(value.ownerRef) || null,
    source,
    status: normalizeOptionalString(value.status) || 'active',
  };
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
