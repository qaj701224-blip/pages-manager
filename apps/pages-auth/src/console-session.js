import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

export async function createConsoleLoginCode(record, { user, now, ttlSeconds, codeSecret = createOpaqueToken('sec') }) {
  if (!record || typeof record !== 'object') throw new Error('Console login code invalid: missing state record');
  if (record.kind !== 'console') throw new Error('Console login code invalid: state is not for console');
  if (record.consumedAt === null) throw new Error('Console login code invalid: OAuth state is not consumed');
  if (record.consoleCode?.consumedAt === null) throw new Error('Console login code invalid: code already exists');
  validateUnixSecond('now', now);
  validateTtlSeconds(ttlSeconds);
  const normalizedUser = normalizeConsoleUser(user);

  record.consoleCode = {
    user: normalizedUser,
    secretHash: await sha256Hex(codeSecret),
    issuedAt: now,
    expiresAt: now + ttlSeconds,
    consumedAt: null,
  };

  return {
    consoleCode: `${record.id}.${codeSecret}`,
    record: { ...record },
  };
}

export async function consumeConsoleLoginCode(consoleCode, record, { now, environment }) {
  const [stateId, codeSecret] = parsePublicCode(consoleCode);
  if (!record || record.id !== stateId) throw new Error('Console login code invalid: unknown state');
  if (record.kind !== 'console') throw new Error('Console login code invalid: state is not for console');
  if (environment && record.environment !== environment) throw new Error('Console login code invalid: environment mismatch');
  if (!record.consoleCode || typeof record.consoleCode !== 'object') {
    throw new Error('Console login code invalid: missing code');
  }
  if (record.consoleCode.consumedAt !== null) throw new Error('Console login code invalid: already consumed');
  validateFiniteNumber('now', now);
  validateFiniteNumber('consoleCode.expiresAt', record.consoleCode.expiresAt);
  if (record.consoleCode.expiresAt <= now) throw new Error('Console login code invalid: expired');

  record.consoleCode.consumedAt = now;
  try {
    const actualHash = await sha256Hex(codeSecret);
    if (!constantTimeEqualHex(record.consoleCode.secretHash, actualHash)) {
      throw new Error('Console login code invalid: secret mismatch');
    }
  } catch (error) {
    record.consoleCode.consumedAt = null;
    throw error;
  }

  return {
    ok: true,
    record: { ...record },
    returnTo: record.returnTo,
    environment: record.environment,
    user: { ...record.consoleCode.user },
  };
}

function normalizeConsoleUser(user) {
  if (!user || typeof user !== 'object') throw new Error('Console login code invalid: user is required');
  const userId = normalizeRequiredString(user.userId ?? user.id, 'userId');
  return {
    userId,
    email: normalizeOptionalString(user.email).toLowerCase(),
    employeeStatus: normalizeEmployeeStatus(user.employeeStatus),
    sessionVersion: Number.isInteger(user.sessionVersion) && user.sessionVersion > 0 ? user.sessionVersion : 1,
  };
}

function parsePublicCode(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    throw new Error('Console login code invalid: malformed code');
  }
  return parts;
}

function normalizeRequiredString(value, label) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`Console login code invalid: ${label} is required`);
  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmployeeStatus(value) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (normalized === 'active') return 'active';
  if (normalized === 'disabled') return 'disabled';
  if (normalized === 'left') return 'left';
  return 'unknown';
}

function validateUnixSecond(name, value) {
  validateFiniteNumber(name, value);
  if (!Number.isInteger(value)) throw new Error(`Console login code invalid: ${name} must be an integer`);
}

function validateTtlSeconds(value) {
  validateUnixSecond('ttlSeconds', value);
  if (value <= 0) throw new Error('Console login code invalid: ttlSeconds must be positive');
}

function validateFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Console login code invalid: ${name} must be a finite number`);
  }
}
