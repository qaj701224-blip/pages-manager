import { confirmCliLogin, consumeCliLogin, createCliLogin } from './cli-login.js';
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
  const record = await storage.get(SINGLE_RECORD_KEY);
  const consumed = await consumeOAuthState(publicState, record, options);
  await storage.put(SINGLE_RECORD_KEY, consumed.record);

  return {
    ...consumed,
    record: stripSecretHash(consumed.record),
  };
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
  const record = await storage.get(SINGLE_RECORD_KEY);
  const confirmed = confirmCliLogin(input, record, options);
  await storage.put(SINGLE_RECORD_KEY, confirmed);
  return { record: stripSecretHash(confirmed) };
}

export async function consumeStoredCliLogin(storage, input, options) {
  const record = await storage.get(SINGLE_RECORD_KEY);
  const consumed = await consumeCliLogin(input, record, options);
  await storage.put(SINGLE_RECORD_KEY, consumed.record);

  return {
    userId: consumed.userId,
    environment: consumed.environment,
    record: stripSecretHash(consumed.record),
  };
}

export async function createStoredSession(storage, input) {
  const record = createSessionRecord(input);
  await storage.put(sessionKey(record.sid), record);
  return record;
}

export async function refreshStoredSession(storage, sid, options) {
  const record = await storage.get(sessionKey(sid));
  const refreshed = refreshSessionRecord(record, options);
  await storage.put(sessionKey(sid), refreshed);
  return refreshed;
}

export async function revokeStoredSession(storage, sid, options) {
  const record = await storage.get(sessionKey(sid));
  const revoked = revokeSessionRecord(record, options);
  await storage.put(sessionKey(sid), revoked);
  return revoked;
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
