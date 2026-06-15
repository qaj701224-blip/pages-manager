import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmCliLogin, consumeCliLogin, createCliLogin } from './cli-login.js';

const now = 1_700_000_000;

test('creates pending CLI login with login secret and device code', async () => {
  const tx = await createCliLogin({
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_login',
    loginSecret: 'secret',
    deviceCode: '12345678',
  });

  assert.equal(tx.loginId, 'cli_login');
  assert.equal(tx.loginSecret, 'secret');
  assert.equal(tx.deviceCode, '12345678');
  assert.equal(tx.record.status, 'pending');
  assert.equal(tx.record.expiresAt, now + 600);
  assert.equal(tx.record.secretHash.length, 64);
});

test('does not let CLI consume before browser confirmation', async () => {
  const tx = await createTestCliLogin();

  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, tx.record, { now: now + 10 }),
    /pending/i
  );
});

test('confirms with matching device code and consumes once with login secret', async () => {
  const tx = await createTestCliLogin();
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.userId, 'usr_123');

  const consumed = await consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 21 });

  assert.equal(consumed.userId, 'usr_123');
  assert.equal(consumed.record.status, 'consumed');
  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, consumed.record, { now: now + 22 }),
    /consumed/i
  );
});

test('rejects wrong device code, wrong login secret, and expiration', async () => {
  const tx = await createTestCliLogin();

  assert.throws(() => confirmCliLogin({ deviceCode: '00000000', userId: 'usr_123' }, tx.record, { now: now + 20 }), /device/i);
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });
  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'wrong' }, confirmed, { now: now + 21 }),
    /secret/i
  );
  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 601 }),
    /expired/i
  );
});

test('rejects CLI login creation with invalid times', async () => {
  for (const invalidNow of [undefined, Number.NaN, -1, 1.5]) {
    await assert.rejects(
      () =>
        createCliLogin({
          environment: 'production',
          now: invalidNow,
          ttlSeconds: 600,
          loginId: 'cli_login',
          loginSecret: 'secret',
          deviceCode: '12345678',
        }),
      /now/i
    );
  }

  for (const invalidTtl of [undefined, Number.NaN, 0, -1, 1.5]) {
    await assert.rejects(
      () =>
        createCliLogin({
          environment: 'production',
          now,
          ttlSeconds: invalidTtl,
          loginId: 'cli_login',
          loginSecret: 'secret',
          deviceCode: '12345678',
        }),
      /ttl/i
    );
  }
});

test('rejects CLI login confirmation and consumption with invalid times', async () => {
  const tx = await createTestCliLogin();

  assert.throws(() => confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: Number.NaN }), /now/i);
  assert.throws(
    () =>
      confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, { ...tx.record, expiresAt: Number.NaN }, { now: now + 20 }),
    /expires/i
  );

  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });

  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: Number.NaN }),
    /now/i
  );
  await assert.rejects(
    () =>
      consumeCliLogin(
        { loginId: 'cli_login', loginSecret: 'secret' },
        { ...confirmed, expiresAt: Number.NaN },
        { now: now + 21 }
      ),
    /expires/i
  );
});

test('does not allow concurrent CLI login consumes against the same confirmed record', async () => {
  const tx = await createTestCliLogin();
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });

  const results = await Promise.allSettled([
    consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 21 }),
    consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 22 }),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /consumed/i);
  assert.equal(confirmed.status, 'consumed');
  assert.equal(confirmed.consumedAt, fulfilled[0].value.record.consumedAt);
});

test('does not burn confirmed CLI login after wrong login secret', async () => {
  const tx = await createTestCliLogin();
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });

  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'wrong' }, confirmed, { now: now + 21 }),
    /secret/i
  );
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.consumedAt, null);

  const consumed = await consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 22 });

  assert.equal(consumed.userId, 'usr_123');
  assert.equal(consumed.record.status, 'consumed');
});

function createTestCliLogin(overrides = {}) {
  return createCliLogin({
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_login',
    loginSecret: 'secret',
    deviceCode: '12345678',
    ...overrides,
  });
}
