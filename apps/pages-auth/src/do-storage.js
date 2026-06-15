import { confirmCliLogin, consumeCliLogin, createCliLogin } from './cli-login.js';
import { constantTimeEqualHex, sha256Hex } from './id.js';
import { consumeOAuthState, createOAuthState } from './oauth-state.js';
import { createSessionRecord, refreshSessionRecord, revokeSessionRecord } from './session-record.js';

const SINGLE_RECORD_KEY = 'record';

export async function createStoredOAuthState(storage, input) {
  const created = await createOAuthState(input);
  await storage.put(SINGLE_RECORD_KEY, created.record);
  return {
    publicState: created.publicState,
    record: stripSecretHash(created.record),
  };
}

export async function consumeStoredOAuthState(storage, publicState, options) {
  return runStorageTransaction(storage, async (transaction) => {
    const record = await transaction.get(SINGLE_RECORD_KEY);
    const consumed = await consumeOAuthState(publicState, record, options);
    await transaction.put(SINGLE_RECORD_KEY, consumed.record);

    return {
      ...consumed,
      record: stripSecretHash(consumed.record),
    };
  });
}

export async function createStoredCliLogin(storage, input) {
  const created = await createCliLogin(input);
  await storage.put(SINGLE_RECORD_KEY, created.record);

  return {
    loginId: created.loginId,
    loginSecret: created.loginSecret,
    deviceCode: created.deviceCode,
    record: stripSecretHash(created.record),
  };
}

export async function confirmStoredCliLogin(storage, input, options) {
  return runStorageTransaction(storage, async (transaction) => {
    const record = await transaction.get(SINGLE_RECORD_KEY);
    const confirmed = confirmCliLogin(input, record, options);
    await transaction.put(SINGLE_RECORD_KEY, confirmed);
    return { record: stripSecretHash(confirmed) };
  });
}

export async function consumeStoredCliLogin(storage, input, options) {
  return runStorageTransaction(storage, async (transaction) => {
    const record = await transaction.get(SINGLE_RECORD_KEY);
    const consumed = await consumeCliLogin(input, record, options);
    await transaction.put(SINGLE_RECORD_KEY, consumed.record);

    return {
      userId: consumed.userId,
      environment: consumed.environment,
      record: stripSecretHash(consumed.record),
    };
  });
}

export async function pollStoredCliLogin(storage, input, options) {
  return runStorageTransaction(storage, async (transaction) => {
    const record = await transaction.get(SINGLE_RECORD_KEY);
    await assertCliLoginPollAllowed(record, input, options);

    if (record.status === 'pending') {
      return {
        status: 'pending',
        expiresAt: record.expiresAt,
      };
    }

    const consumed = await consumeCliLogin(input, record, options);
    await transaction.put(SINGLE_RECORD_KEY, consumed.record);

    return {
      status: 'confirmed',
      userId: consumed.userId,
      environment: consumed.environment,
      record: stripSecretHash(consumed.record),
    };
  });
}

export async function peekStoredCliLogin(storage, input, options) {
  const record = await storage.get(SINGLE_RECORD_KEY);
  await assertCliLoginPollAllowed(record, input, options);

  if (record.status === 'pending') {
    return {
      status: 'pending',
      expiresAt: record.expiresAt,
    };
  }

  return {
    status: 'confirmed',
    userId: record.userId,
    environment: record.environment,
    record: stripSecretHash(record),
  };
}

export async function createStoredSession(storage, input) {
  const record = createSessionRecord(input);
  await storage.put(sessionKey(record.sid), record);
  return record;
}

export async function refreshStoredSession(storage, sid, options) {
  return runStorageTransaction(storage, async (transaction) => {
    const record = await transaction.get(sessionKey(sid));
    const refreshed = refreshSessionRecord(record, options);
    await transaction.put(sessionKey(sid), refreshed);
    return refreshed;
  });
}

export async function revokeStoredSession(storage, sid, options) {
  return runStorageTransaction(storage, async (transaction) => {
    const record = await transaction.get(sessionKey(sid));
    const revoked = revokeSessionRecord(record, options);
    await transaction.put(sessionKey(sid), revoked);
    return revoked;
  });
}

function sessionKey(sid) {
  return `session:${sid}`;
}

function stripSecretHash(record) {
  if (!record || typeof record !== 'object') return record;
  const { secretHash, ...safeRecord } = record;
  void secretHash;
  return safeRecord;
}

async function assertCliLoginPollAllowed(record, input, { now }) {
  if (!record || typeof record !== 'object') throw new Error('CLI login invalid: missing record');
  if (record.id !== input.loginId) throw new Error('CLI login invalid: unknown login id');
  if (!Number.isInteger(now) || now < 0) throw new Error('CLI login invalid: now must be a non-negative integer');
  if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) throw new Error('CLI login invalid: expired');
  if (record.status === 'consumed') throw new Error('CLI login invalid: already consumed');
  if (record.status !== 'pending' && record.status !== 'confirmed')
    throw new Error(`CLI login invalid: status is ${record.status}`);

  const actualHash = await sha256Hex(input.loginSecret);
  if (!constantTimeEqualHex(record.secretHash, actualHash)) throw new Error('CLI login invalid: secret mismatch');
}

async function runStorageTransaction(storage, callback) {
  if (typeof storage?.transaction === 'function') {
    return storage.transaction((transaction) => callback(transaction));
  }
  return callback(storage);
}
