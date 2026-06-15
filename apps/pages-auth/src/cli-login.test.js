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
  const tx = await createCliLogin({ environment: 'production', now, ttlSeconds: 600, loginId: 'cli_login', loginSecret: 'secret', deviceCode: '12345678' });

  await assert.rejects(() => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, tx.record, { now: now + 10 }), /pending/i);
});

test('confirms with matching device code and consumes once with login secret', async () => {
  const tx = await createCliLogin({ environment: 'production', now, ttlSeconds: 600, loginId: 'cli_login', loginSecret: 'secret', deviceCode: '12345678' });
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.userId, 'usr_123');

  const consumed = await consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 21 });

  assert.equal(consumed.userId, 'usr_123');
  assert.equal(consumed.record.status, 'consumed');
  await assert.rejects(() => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, consumed.record, { now: now + 22 }), /consumed/i);
});

test('rejects wrong device code, wrong login secret, and expiration', async () => {
  const tx = await createCliLogin({ environment: 'production', now, ttlSeconds: 600, loginId: 'cli_login', loginSecret: 'secret', deviceCode: '12345678' });

  assert.throws(() => confirmCliLogin({ deviceCode: '00000000', userId: 'usr_123' }, tx.record, { now: now + 20 }), /device/i);
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });
  await assert.rejects(() => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'wrong' }, confirmed, { now: now + 21 }), /secret/i);
  await assert.rejects(() => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 601 }), /expired/i);
});
