import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionRecord, refreshSessionRecord, revokeSessionRecord } from './session-record.js';

const now = 1_700_000_000;

test('creates revocable auth session records with idle and absolute expiration', () => {
  const record = createSessionRecord({
    sid: 'sid_auth',
    userId: 'usr_123',
    purpose: 'auth_session',
    now,
    idleTtlSeconds: 120,
    absoluteTtlSeconds: 300,
  });

  assert.deepEqual(record, {
    sid: 'sid_auth',
    userId: 'usr_123',
    purpose: 'auth_session',
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: now + 120,
    absoluteExpiresAt: now + 300,
    revokedAt: null,
    authTime: now,
  });
});

test('refreshes idle expiration without passing absolute expiration', () => {
  const record = createSessionRecord({ sid: 'sid_auth', userId: 'usr_123', purpose: 'auth_session', now, idleTtlSeconds: 120, absoluteTtlSeconds: 300 });
  const refreshed = refreshSessionRecord(record, { now: now + 250, idleTtlSeconds: 120 });

  assert.equal(refreshed.lastSeenAt, now + 250);
  assert.equal(refreshed.expiresAt, now + 300);
});

test('rejects refresh after idle expiration, absolute expiration, or revocation', () => {
  const record = createSessionRecord({ sid: 'sid_auth', userId: 'usr_123', purpose: 'auth_session', now, idleTtlSeconds: 120, absoluteTtlSeconds: 300 });

  assert.throws(() => refreshSessionRecord(record, { now: now + 121, idleTtlSeconds: 120 }), /expired/i);
  assert.throws(() => refreshSessionRecord(record, { now: now + 301, idleTtlSeconds: 120 }), /expired/i);

  const revoked = revokeSessionRecord(record, { now: now + 30 });
  assert.equal(revoked.revokedAt, now + 30);
  assert.throws(() => refreshSessionRecord(revoked, { now: now + 31, idleTtlSeconds: 120 }), /revoked/i);
});
