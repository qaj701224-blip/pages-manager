import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confirmStoredCliLogin,
  consumeStoredCliLogin,
  pollStoredCliLogin,
  consumeStoredOAuthState,
  createStoredCliLogin,
  createStoredOAuthState,
  createStoredSession,
  refreshStoredSession,
  revokeStoredSession,
} from './do-storage.js';

const now = 1_800_000_000;

test('creates and consumes OAuth state once through storage', async () => {
  const storage = createFakeStorage();
  const created = await createStoredOAuthState(storage, {
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/app',
    now,
    ttlSeconds: 300,
    stateId: 'ost_test',
    stateSecret: 'state-secret',
  });

  assert.equal(created.publicState, 'ost_test.state-secret');
  assert.equal(created.record.siteHost, 'demo.pages.xd.team');
  assert.equal(Object.hasOwn(created.record, 'secretHash'), false);
  assert.equal((await storage.get('record')).secretHash.length, 64);

  const consumed = await consumeStoredOAuthState(storage, 'ost_test.state-secret', { now: now + 1 });

  assert.equal(consumed.returnTo, 'https://demo.pages.xd.team/app');
  assert.equal(consumed.siteHost, 'demo.pages.xd.team');
  assert.equal(consumed.record.consumedAt, now + 1);
  assert.equal(Object.hasOwn(consumed.record, 'secretHash'), false);
  assert.equal((await storage.get('record')).consumedAt, now + 1);

  await assert.rejects(() => consumeStoredOAuthState(storage, 'ost_test.state-secret', { now: now + 2 }), /already consumed/);
});

test('creates pending CLI login and confirms with matching device code', async () => {
  const storage = createFakeStorage();
  const created = await createStoredCliLogin(storage, {
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_test',
    loginSecret: 'login-secret',
    deviceCode: '12345678',
  });

  assert.equal(created.loginId, 'cli_test');
  assert.equal(created.loginSecret, 'login-secret');
  assert.equal(created.deviceCode, '12345678');
  assert.equal(created.record.status, 'pending');
  assert.equal(Object.hasOwn(created.record, 'secretHash'), false);
  assert.equal((await storage.get('record')).secretHash.length, 64);

  await assert.rejects(
    () => confirmStoredCliLogin(storage, { deviceCode: '87654321', userId: 'usr_123' }, { now: now + 1 }),
    /device code mismatch/
  );

  const confirmed = await confirmStoredCliLogin(storage, { deviceCode: '12345678', userId: 'usr_123' }, { now: now + 2 });

  assert.equal(confirmed.record.status, 'confirmed');
  assert.equal(confirmed.record.userId, 'usr_123');
  assert.equal(Object.hasOwn(confirmed.record, 'secretHash'), false);
  assert.equal((await storage.get('record')).status, 'confirmed');
});

test('CLI login consume requires login secret and only succeeds once', async () => {
  const storage = createFakeStorage();
  await createStoredCliLogin(storage, {
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_test',
    loginSecret: 'login-secret',
    deviceCode: '12345678',
  });
  await confirmStoredCliLogin(storage, { deviceCode: '12345678', userId: 'usr_123' }, { now: now + 1 });

  await assert.rejects(
    () => consumeStoredCliLogin(storage, { loginId: 'cli_test', loginSecret: 'wrong-secret' }, { now: now + 2 }),
    /secret mismatch/
  );
  assert.equal((await storage.get('record')).status, 'confirmed');

  const consumed = await consumeStoredCliLogin(storage, { loginId: 'cli_test', loginSecret: 'login-secret' }, { now: now + 3 });

  assert.equal(consumed.userId, 'usr_123');
  assert.equal(consumed.environment, 'production');
  assert.equal(consumed.record.status, 'consumed');
  assert.equal(Object.hasOwn(consumed.record, 'secretHash'), false);

  await assert.rejects(
    () => consumeStoredCliLogin(storage, { loginId: 'cli_test', loginSecret: 'login-secret' }, { now: now + 4 }),
    /already consumed/
  );
});

test('CLI login poll returns pending, consumes confirmed login, and rejects repeated poll', async () => {
  const storage = createFakeStorage();
  await createStoredCliLogin(storage, {
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_test',
    loginSecret: 'login-secret',
    deviceCode: '12345678',
  });

  const pending = await pollStoredCliLogin(storage, { loginId: 'cli_test', loginSecret: 'login-secret' }, { now: now + 1 });

  assert.deepEqual(pending, { status: 'pending', expiresAt: now + 600 });
  assert.equal((await storage.get('record')).status, 'pending');

  await assert.rejects(
    () => pollStoredCliLogin(storage, { loginId: 'cli_test', loginSecret: 'wrong-secret' }, { now: now + 2 }),
    /secret mismatch/
  );
  await confirmStoredCliLogin(storage, { deviceCode: '12345678', userId: 'usr_123' }, { now: now + 3 });

  const confirmed = await pollStoredCliLogin(storage, { loginId: 'cli_test', loginSecret: 'login-secret' }, { now: now + 4 });

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.userId, 'usr_123');
  assert.equal(confirmed.record.status, 'consumed');
  assert.equal(Object.hasOwn(confirmed.record, 'secretHash'), false);

  await assert.rejects(
    () => pollStoredCliLogin(storage, { loginId: 'cli_test', loginSecret: 'login-secret' }, { now: now + 5 }),
    /already consumed/
  );
});

test('creates, refreshes, and revokes auth session records through storage', async () => {
  const storage = createFakeStorage();
  const created = await createStoredSession(storage, {
    sid: 'sid_test',
    userId: 'usr_123',
    purpose: 'auth_session',
    now,
    idleTtlSeconds: 120,
    absoluteTtlSeconds: 300,
  });

  assert.equal(created.sid, 'sid_test');
  assert.equal(created.expiresAt, now + 120);
  assert.deepEqual(await storage.get('session:sid_test'), created);

  const refreshed = await refreshStoredSession(storage, 'sid_test', { now: now + 100, idleTtlSeconds: 120 });

  assert.equal(refreshed.lastSeenAt, now + 100);
  assert.equal(refreshed.expiresAt, now + 220);
  assert.deepEqual(await storage.get('session:sid_test'), refreshed);

  const revoked = await revokeStoredSession(storage, 'sid_test', { now: now + 110 });

  assert.equal(revoked.revokedAt, now + 110);
  assert.deepEqual(await storage.get('session:sid_test'), revoked);
});

function createFakeStorage() {
  const records = new Map();
  return {
    async get(key) {
      return clone(records.get(key));
    },
    async put(key, value) {
      records.set(key, clone(value));
    },
    async delete(key) {
      records.delete(key);
    },
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
