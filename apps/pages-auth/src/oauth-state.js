import { classifyHost } from '../../pages-router/src/host.js';
import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

export async function createOAuthState({
  environment,
  siteHost,
  returnTo,
  cliLoginId,
  deviceCode,
  recoveryAttempt = false,
  now,
  ttlSeconds,
  stateId = createOpaqueToken('ost'),
  stateSecret = createOpaqueToken('sec'),
  consoleLogin = false,
}) {
  validateUnixSecond('now', now);
  validateTtlSeconds(ttlSeconds);
  validateEnvironment(environment);
  const kind = consoleLogin ? 'console' : cliLoginId ? 'cli' : 'site';
  const normalizedSiteHost = kind === 'site' ? validateSiteHost(siteHost, environment) : null;
  const normalizedReturnTo =
    kind === 'site'
      ? validateReturnTo(returnTo, normalizedSiteHost)
      : kind === 'console'
        ? validateConsoleReturnTo(returnTo)
        : null;
  const normalizedCliLoginId = kind === 'cli' ? normalizeRequiredString(cliLoginId, 'cliLoginId') : null;
  const normalizedDeviceCode = kind === 'cli' ? normalizeDeviceCode(deviceCode) : null;

  return {
    publicState: `${stateId}.${stateSecret}`,
    record: {
      id: stateId,
      kind,
      environment,
      siteHost: normalizedSiteHost,
      returnTo: normalizedReturnTo,
      cliLoginId: normalizedCliLoginId,
      deviceCode: normalizedDeviceCode,
      recoveryAttempt: kind === 'site' ? Boolean(recoveryAttempt) : false,
      secretHash: await sha256Hex(stateSecret),
      issuedAt: now,
      expiresAt: now + ttlSeconds,
      consumedAt: null,
    },
  };
}

export async function consumeOAuthState(publicState, record, { now, environment }) {
  const [stateId, stateSecret] = parsePublicState(publicState);
  if (!record || record.id !== stateId) throw new Error('OAuth state invalid: unknown state');
  if (environment && record.environment !== environment) throw new Error('OAuth state invalid: environment mismatch');
  const previousConsumedAt = record.consumedAt;
  if (previousConsumedAt !== null) throw new Error('OAuth state invalid: already consumed');
  validateFiniteNumber('now', now);
  validateFiniteNumber('expiresAt', record.expiresAt);
  if (record.expiresAt <= now) throw new Error('OAuth state invalid: expired');

  record.consumedAt = now;
  try {
    const actualHash = await sha256Hex(stateSecret);
    if (!constantTimeEqualHex(record.secretHash, actualHash)) throw new Error('OAuth state invalid: secret mismatch');
  } catch (error) {
    record.consumedAt = previousConsumedAt;
    throw error;
  }

  const consumedRecord = { ...record };
  return {
    ok: true,
    record: consumedRecord,
    kind: record.kind || 'site',
    returnTo: record.returnTo,
    siteHost: record.siteHost,
    cliLoginId: record.cliLoginId,
    deviceCode: record.deviceCode,
    recoveryAttempt: Boolean(record.recoveryAttempt),
    environment: record.environment,
  };
}

export async function createOAuthSiteCode(record, { user, now, ttlSeconds, codeSecret = createOpaqueToken('sec') }) {
  if (!record || typeof record !== 'object') throw new Error('OAuth site code invalid: missing state record');
  if ((record.kind || 'site') !== 'site') throw new Error('OAuth site code invalid: state is not for a site');
  if (record.consumedAt === null) throw new Error('OAuth site code invalid: OAuth state is not consumed');
  if (record.siteCode?.consumedAt === null) throw new Error('OAuth site code invalid: site code already exists');
  validateUnixSecond('now', now);
  validateTtlSeconds(ttlSeconds);
  const normalizedUser = normalizeSiteCodeUser(user);

  record.siteCode = {
    user: normalizedUser,
    secretHash: await sha256Hex(codeSecret),
    issuedAt: now,
    expiresAt: now + ttlSeconds,
    consumedAt: null,
  };

  return {
    siteCode: `${record.id}.${codeSecret}`,
    record: { ...record },
  };
}

export async function consumeOAuthSiteCode(siteCode, record, { now, siteHost, environment }) {
  const [stateId, codeSecret] = parsePublicState(siteCode);
  if (!record || record.id !== stateId) throw new Error('OAuth site code invalid: unknown state');
  if ((record.kind || 'site') !== 'site') throw new Error('OAuth site code invalid: state is not for a site');
  if (environment && record.environment !== environment) throw new Error('OAuth site code invalid: environment mismatch');
  if (!record.siteCode || typeof record.siteCode !== 'object') throw new Error('OAuth site code invalid: missing code');
  if (record.siteHost !== siteHost) throw new Error('OAuth site code invalid: site host mismatch');
  if (record.siteCode.consumedAt !== null) throw new Error('OAuth site code invalid: already consumed');
  validateFiniteNumber('now', now);
  validateFiniteNumber('siteCode.expiresAt', record.siteCode.expiresAt);
  if (record.siteCode.expiresAt <= now) throw new Error('OAuth site code invalid: expired');

  record.siteCode.consumedAt = now;
  try {
    const actualHash = await sha256Hex(codeSecret);
    if (!constantTimeEqualHex(record.siteCode.secretHash, actualHash)) {
      throw new Error('OAuth site code invalid: secret mismatch');
    }
  } catch (error) {
    record.siteCode.consumedAt = null;
    throw error;
  }

  return {
    ok: true,
    record: { ...record },
    returnTo: record.returnTo,
    siteHost: record.siteHost,
    user: { ...record.siteCode.user, departments: [...record.siteCode.user.departments] },
  };
}

function parsePublicState(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2 || parts.some((part) => part === '')) throw new Error('OAuth state invalid: malformed state');
  return parts;
}

function normalizeSiteCodeUser(user) {
  if (!user || typeof user !== 'object') throw new Error('OAuth site code invalid: user is required');
  const id = normalizeRequiredString(user.id, 'user.id');
  const accountId = normalizeOptionalString(user.accountId);
  const name = normalizeOptionalString(user.name);
  return {
    id,
    email: normalizeOptionalString(user.email).toLowerCase(),
    ...(accountId ? { accountId } : {}),
    ...(name ? { name } : {}),
    employeeStatus: normalizeEmployeeStatus(user.employeeStatus),
    departments: Array.isArray(user.departments)
      ? user.departments.map((value) => normalizeOptionalString(value)).filter(Boolean)
      : [],
    sessionVersion: Number.isInteger(user.sessionVersion) && user.sessionVersion > 0 ? user.sessionVersion : 1,
  };
}

function normalizeEmployeeStatus(value) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (normalized === 'active') return 'active';
  if (normalized === 'disabled') return 'disabled';
  if (normalized === 'left') return 'left';
  return 'unknown';
}

function validateEnvironment(environment) {
  if (environment !== 'production' && environment !== 'staging' && environment !== 'local') {
    throw new Error('OAuth state invalid: environment is invalid');
  }
}

function normalizeRequiredString(value, label) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`OAuth site code invalid: ${label} is required`);
  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDeviceCode(value) {
  const deviceCode = normalizeRequiredString(value, 'deviceCode');
  if (!/^[0-9]{8}$/.test(deviceCode)) throw new Error('OAuth state invalid: deviceCode must be 8 digits');
  return deviceCode;
}

function validateSiteHost(siteHost, environment) {
  const host = String(siteHost || '')
    .trim()
    .toLowerCase();
  const classified = classifyHost(host, { environment });
  if (!classified.ok) throw new Error('OAuth state invalid: site host is not allowed');
  return classified.hostname;
}

function validateReturnTo(returnTo, siteHost) {
  let url;
  try {
    url = new URL(returnTo);
  } catch {
    throw new Error('OAuth state invalid: return_to must be an absolute URL');
  }

  if (url.protocol !== 'https:') throw new Error('OAuth state invalid: return_to must use https');
  if (url.username || url.password) throw new Error('OAuth state invalid: return_to credentials are not allowed');
  if (url.hash) throw new Error('OAuth state invalid: return_to fragment is not allowed');
  if (url.origin !== `https://${siteHost}`) throw new Error('OAuth state invalid: return_to origin is not allowed');
  return url.toString();
}

function validateConsoleReturnTo(returnTo) {
  const value = String(returnTo || '').trim() || '/';
  if (value.startsWith('//')) throw new Error('OAuth state invalid: return_to must be relative');
  let url;
  try {
    url = new URL(value, 'https://workers.xd.team');
  } catch {
    throw new Error('OAuth state invalid: return_to is invalid');
  }
  if (url.origin !== 'https://workers.xd.team') throw new Error('OAuth state invalid: return_to must be relative');
  if (url.username || url.password || url.hash) throw new Error('OAuth state invalid: return_to is invalid');

  const path = `${url.pathname}${url.search}`;
  if (url.pathname === '/' || url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) return path;
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return path;
  throw new Error('OAuth state invalid: return_to is not allowed');
}

function validateUnixSecond(name, value) {
  validateFiniteNumber(name, value);
  if (!Number.isInteger(value)) throw new Error(`OAuth state invalid: ${name} must be an integer`);
}

function validateTtlSeconds(value) {
  validateUnixSecond('ttlSeconds', value);
  if (value <= 0) throw new Error('OAuth state invalid: ttlSeconds must be positive');
}

function validateFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`OAuth state invalid: ${name} must be a finite number`);
  }
}
