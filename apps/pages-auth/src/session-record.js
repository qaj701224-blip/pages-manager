export function createSessionRecord({ sid, userId, purpose, now, idleTtlSeconds, absoluteTtlSeconds }) {
  requireString(sid, 'sid');
  requireString(userId, 'userId');
  requireString(purpose, 'purpose');
  requireTimestamp(now, 'now');
  requirePositiveInteger(idleTtlSeconds, 'idleTtlSeconds');
  requirePositiveInteger(absoluteTtlSeconds, 'absoluteTtlSeconds');
  if (absoluteTtlSeconds < idleTtlSeconds) {
    throw new Error('Session absoluteTtlSeconds must be greater than or equal to idleTtlSeconds');
  }

  return {
    sid,
    userId,
    purpose,
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: now + idleTtlSeconds,
    absoluteExpiresAt: now + absoluteTtlSeconds,
    revokedAt: null,
    authTime: now,
  };
}

export function refreshSessionRecord(record, { now, idleTtlSeconds }) {
  requireTimestamp(now, 'now');
  requirePositiveInteger(idleTtlSeconds, 'idleTtlSeconds');
  assertActive(record, now);

  return {
    ...record,
    lastSeenAt: now,
    expiresAt: Math.min(now + idleTtlSeconds, record.absoluteExpiresAt),
  };
}

export function revokeSessionRecord(record, { now }) {
  requireTimestamp(now, 'now');
  if (!record || typeof record !== 'object') throw new Error('Session record is missing');
  if (record.revokedAt !== null) {
    requireTimestamp(record.revokedAt, 'revokedAt');
    return record;
  }
  return { ...record, revokedAt: now };
}

function assertActive(record, now) {
  if (!record || typeof record !== 'object') throw new Error('Session record is missing');
  requireTimestamp(record.expiresAt, 'expiresAt');
  requireTimestamp(record.absoluteExpiresAt, 'absoluteExpiresAt');
  if (record.revokedAt !== null) throw new Error('Session record revoked');
  if (record.absoluteExpiresAt <= now) throw new Error('Session record expired');
  if (record.expiresAt <= now) throw new Error('Session record expired');
}

function requireString(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`Session ${label} is required`);
}

function requireTimestamp(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Session ${label} must be a non-negative integer timestamp`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Session ${label} must be a positive integer`);
}
