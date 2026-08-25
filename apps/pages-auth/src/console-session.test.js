import assert from 'node:assert/strict';
import test from 'node:test';

import { createConsoleLoginCode, consumeConsoleLoginCode } from './console-session.js';
import { consumeOAuthState, createOAuthState } from './oauth-state.js';

const now = 1_800_000_000;

test('creates and consumes a one-time console login code', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    consoleLogin: true,
    returnTo: '/workspace',
    now,
    ttlSeconds: 300,
    stateId: 'ost_console',
    stateSecret: 'state-secret',
  });
  await consumeOAuthState('ost_console.state-secret', tx.record, { now: now + 1, environment: 'production' });

  const created = await createConsoleLoginCode(tx.record, {
    user: {
      userId: 'usr_1',
      email: 'user@example.com',
      employeeStatus: 'active',
      departments: ['dept_design'],
      sessionVersion: 7,
      providerResourceId: 'secret-provider-id',
    },
    now: now + 2,
    ttlSeconds: 60,
    codeSecret: 'console-secret',
  });

  assert.equal(created.consoleCode, 'ost_console.console-secret');
  assert.equal(created.record.consoleCode.secretHash.length, 64);

  const consumed = await consumeConsoleLoginCode('ost_console.console-secret', tx.record, {
    now: now + 3,
    environment: 'production',
  });

  assert.deepEqual(consumed.user, {
    userId: 'usr_1',
    email: 'user@example.com',
    employeeStatus: 'active',
    sessionVersion: 7,
  });
  assert.equal(consumed.returnTo, '/workspace');
  assert.equal(consumed.environment, 'production');
  assert.equal(tx.record.consoleCode.consumedAt, now + 3);

  await assert.rejects(
    () => consumeConsoleLoginCode('ost_console.console-secret', tx.record, { now: now + 4, environment: 'production' }),
    /consumed/i
  );
});

test('console login code rejects wrong environment and signature', async () => {
  const tx = await createOAuthState({
    environment: 'staging',
    consoleLogin: true,
    returnTo: '/admin',
    now,
    ttlSeconds: 300,
    stateId: 'ost_console',
    stateSecret: 'state-secret',
  });
  await consumeOAuthState('ost_console.state-secret', tx.record, { now: now + 1, environment: 'staging' });
  await createConsoleLoginCode(tx.record, {
    user: { userId: 'usr_1', employeeStatus: 'active' },
    now: now + 2,
    ttlSeconds: 60,
    codeSecret: 'console-secret',
  });

  await assert.rejects(
    () => consumeConsoleLoginCode('ost_console.console-secret', tx.record, { now: now + 3, environment: 'production' }),
    /environment/i
  );
  await assert.rejects(
    () => consumeConsoleLoginCode('ost_console.wrong', tx.record, { now: now + 3, environment: 'staging' }),
    /secret/i
  );
});
