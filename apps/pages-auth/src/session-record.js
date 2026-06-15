export function createSessionRecord({ sid, userId, purpose, now, idleTtlSeconds, absoluteTtlSeconds }) {
  requireString(sid, 'sid');
  requireString(userId, 'userId');
  requireString(purpose, 'purpose');
  requirePositive(idleTtlSeconds, 'idleTtlSeconds');
  requirePositive(absoluteTtlSeconds, 'absoluteTtlSeconds');

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
  requirePositive(idleTtlSeconds, 'idleTtlSeconds');
  assertActive(record, now, idleTtlSeconds);

  return {
    ...record,
    lastSeenAt: now,
    expiresAt: Math.min(now + idleTtlSeconds, record.absoluteExpiresAt),
  };
}

export function revokeSessionRecord(record, { now }) {
  if (!record || typeof record !== 'object') throw new Error('Session record is missing');
  if (record.revokedAt !== null) return record;
  return { ...record, revokedAt: now };
}

function assertActive(record, now, idleTtlSeconds) {
  if (!record || typeof record !== 'object') throw new Error('Session record is missing');
  if (record.revokedAt !== null) throw new Error('Session record revoked');
  if (record.absoluteExpiresAt <= now) throw new Error('Session record expired');
  if (record.expiresAt <= now && now + idleTtlSeconds < record.absoluteExpiresAt) throw new Error('Session record expired');
}

function requireString(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`Session ${label} is required`);
}

function requirePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Session ${label} must be positive`);
}
