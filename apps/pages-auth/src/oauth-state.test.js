import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeOAuthState, createOAuthState } from './oauth-state.js';

const now = 1_700_000_000;

test('creates OAuth state bound to site host and return_to', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/reports?q=1',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  assert.equal(tx.publicState, 'ost_state.secret');
  assert.equal(tx.record.id, 'ost_state');
  assert.equal(tx.record.secretHash.length, 64);
  assert.equal(tx.record.returnTo, 'https://demo.pages.xd.team/reports?q=1');
  assert.equal(tx.record.siteHost, 'demo.pages.xd.team');
  assert.equal(tx.record.expiresAt, now + 300);
  assert.equal(tx.record.consumedAt, null);
});

test('rejects open redirects and cross-environment site hosts', async () => {
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'production',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'https://evil.example/path',
        now,
        ttlSeconds: 300,
      }),
    /return_to/i
  );
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'staging',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'https://demo.pages.xd.team/',
        now,
        ttlSeconds: 300,
      }),
    /site host/i
  );
});

test('rejects return_to values outside the exact default https origin', async () => {
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'production',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'http://demo.pages.xd.team/',
        now,
        ttlSeconds: 300,
      }),
    /return_to/i
  );
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'production',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'https://user:pass@demo.pages.xd.team/',
        now,
        ttlSeconds: 300,
      }),
    /return_to/i
  );
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'production',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'https://demo.pages.xd.team/#token',
        now,
        ttlSeconds: 300,
      }),
    /return_to/i
  );
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'production',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'https://demo.pages.xd.team:8443/',
        now,
        ttlSeconds: 300,
      }),
    /return_to/i
  );
});

test('rejects invalid OAuth state creation times', async () => {
  for (const invalidNow of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () =>
        createOAuthState({
          environment: 'production',
          siteHost: 'demo.pages.xd.team',
          returnTo: 'https://demo.pages.xd.team/',
          now: invalidNow,
          ttlSeconds: 300,
        }),
      /now/i
    );
  }

  for (const invalidTtl of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.5]) {
    await assert.rejects(
      () =>
        createOAuthState({
          environment: 'production',
          siteHost: 'demo.pages.xd.team',
          returnTo: 'https://demo.pages.xd.team/',
          now,
          ttlSeconds: invalidTtl,
        }),
      /ttl/i
    );
  }
});

test('consumes OAuth state once with matching secret', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  const consumed = await consumeOAuthState('ost_state.secret', tx.record, { now: now + 10 });

  assert.equal(consumed.ok, true);
  assert.equal(consumed.record.consumedAt, now + 10);
  assert.notEqual(consumed.record, tx.record);
  assert.equal(tx.record.consumedAt, now + 10);
  assert.equal(consumed.returnTo, 'https://demo.pages.xd.team/');

  await assert.rejects(() => consumeOAuthState('ost_state.secret', tx.record, { now: now + 11 }), /consumed/i);
});

test('rejects OAuth state with wrong secret or expiration', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  await assert.rejects(() => consumeOAuthState('ost_state.wrong', tx.record, { now: now + 10 }), /secret/i);
  await assert.rejects(() => consumeOAuthState('ost_state.secret', tx.record, { now: now + 300 }), /expired/i);
  await assert.rejects(() => consumeOAuthState('ost_state.secret', tx.record, { now: now + 301 }), /expired/i);
});

test('rejects OAuth state consumption with invalid times', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  await assert.rejects(() => consumeOAuthState('ost_state.secret', tx.record, { now: Number.NaN }), /now/i);
  await assert.rejects(
    () => consumeOAuthState('ost_state.secret', { ...tx.record, expiresAt: Number.NaN }, { now: now + 10 }),
    /expires/i
  );
  await assert.rejects(
    () => consumeOAuthState('ost_state.secret', { ...tx.record, expiresAt: undefined }, { now: now + 10 }),
    /expires/i
  );
});
