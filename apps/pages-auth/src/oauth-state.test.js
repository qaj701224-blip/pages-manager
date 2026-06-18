import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeOAuthSiteCode, consumeOAuthState, createOAuthSiteCode, createOAuthState } from './oauth-state.js';

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
  assert.equal(tx.record.kind, 'site');
  assert.equal(tx.record.environment, 'production');
  assert.equal(tx.record.secretHash.length, 64);
  assert.equal(tx.record.returnTo, 'https://demo.pages.xd.team/reports?q=1');
  assert.equal(tx.record.siteHost, 'demo.pages.xd.team');
  assert.equal(tx.record.expiresAt, now + 300);
  assert.equal(tx.record.consumedAt, null);
});

test('creates OAuth state for CLI login without site redirect fields', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    cliLoginId: 'cli_test',
    deviceCode: '12345678',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  assert.equal(tx.record.kind, 'cli');
  assert.equal(tx.record.cliLoginId, 'cli_test');
  assert.equal(tx.record.deviceCode, '12345678');
  assert.equal(tx.record.siteHost, null);
  assert.equal(tx.record.returnTo, null);

  const consumed = await consumeOAuthState(tx.publicState, tx.record, { now: now + 1, environment: 'production' });
  assert.equal(consumed.kind, 'cli');
  assert.equal(consumed.cliLoginId, 'cli_test');
  assert.equal(consumed.deviceCode, '12345678');
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

test('rejects OAuth state consumption across environments', async () => {
  const tx = await createOAuthState({
    environment: 'staging',
    siteHost: 'demo-staging.pages.xd.team',
    returnTo: 'https://demo-staging.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  await assert.rejects(
    () => consumeOAuthState('ost_state.secret', tx.record, { now: now + 10, environment: 'production' }),
    /environment/i
  );
});

test('does not allow concurrent consumes against the same record', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  const results = await Promise.allSettled([
    consumeOAuthState('ost_state.secret', tx.record, { now: now + 10 }),
    consumeOAuthState('ost_state.secret', tx.record, { now: now + 11 }),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /consumed/i);
  assert.equal(tx.record.consumedAt, fulfilled[0].value.record.consumedAt);
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
  assert.equal(tx.record.consumedAt, null);
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

test('creates and consumes a one-time site code after OAuth callback', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/private',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });
  await consumeOAuthState('ost_state.secret', tx.record, { now: now + 10 });

  const created = await createOAuthSiteCode(tx.record, {
    user: {
      id: 'usr_1',
      email: 'user@example.com',
      employeeStatus: 'active',
      departments: ['dept_design'],
      sessionVersion: 3,
    },
    now: now + 11,
    ttlSeconds: 60,
    codeSecret: 'site-secret',
  });
  const consumed = await consumeOAuthSiteCode('ost_state.site-secret', tx.record, {
    now: now + 12,
    siteHost: 'demo.pages.xd.team',
  });

  assert.equal(created.siteCode, 'ost_state.site-secret');
  assert.equal(created.record.siteCode.secretHash.length, 64);
  assert.equal(consumed.returnTo, 'https://demo.pages.xd.team/private');
  assert.deepEqual(consumed.user, {
    id: 'usr_1',
    email: 'user@example.com',
    employeeStatus: 'active',
    departments: ['dept_design'],
    sessionVersion: 3,
  });
  assert.equal(tx.record.siteCode.consumedAt, now + 12);
  await assert.rejects(
    () => consumeOAuthSiteCode('ost_state.site-secret', tx.record, { now: now + 13, siteHost: 'demo.pages.xd.team' }),
    /consumed/i
  );
});

test('site code user defaults unknown employee status instead of active', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/private',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });
  await consumeOAuthState('ost_state.secret', tx.record, { now: now + 10 });

  await createOAuthSiteCode(tx.record, {
    user: { id: 'usr_1' },
    now: now + 11,
    ttlSeconds: 60,
    codeSecret: 'site-secret',
  });

  const consumed = await consumeOAuthSiteCode('ost_state.site-secret', tx.record, {
    now: now + 12,
    siteHost: 'demo.pages.xd.team',
    environment: 'production',
  });

  assert.equal(consumed.user.employeeStatus, 'unknown');
});
