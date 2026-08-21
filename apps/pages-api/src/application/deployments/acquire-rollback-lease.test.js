import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackLeaseAcquisition } from './acquire-rollback-lease.js';

const command = { environment: 'production', siteId: 'site_1' };
const telemetry = { start: () => null, finish: async () => null };

test('rollback lease acquisition returns the renewable lease through its narrow capability', async () => {
  const lease = { lockId: 'rollbacklock_1', fencingToken: 1 };
  const calls = [];
  const stage = { operation: 'rollback_policy_lock' };
  const application = createRollbackLeaseAcquisition({
    leases: {
      async acquire(input) {
        calls.push(input);
        return lease;
      },
    },
    telemetry: {
      start() {
        calls.push(['start']);
        return stage;
      },
      async finish(receivedStage, outcome) {
        calls.push(['finish', receivedStage, outcome]);
      },
    },
  });

  assert.deepEqual(await application.acquire(command), { ok: true, lease });
  assert.deepEqual(calls, [
    ['start'],
    command,
    ['finish', stage, { status: 'succeeded' }],
  ]);
});

test('rollback lease acquisition distinguishes contention from an acquisition failure', async () => {
  const conflict = createRollbackLeaseAcquisition({ leases: { acquire: async () => null }, telemetry });
  assert.deepEqual(await conflict.acquire(command), {
    ok: false,
    error: {
      code: 'SITE_POLICY_CONFLICT',
      reason: 'lease_unavailable',
    },
  });

  const cause = new Error('lock store unavailable');
  const failed = createRollbackLeaseAcquisition({
    leases: {
      acquire: async () => {
        throw cause;
      },
    },
    telemetry,
  });
  assert.deepEqual(await failed.acquire(command), {
    ok: false,
    error: {
      code: 'SITE_POLICY_LOCKED',
      reason: 'acquire_failed',
      cause,
    },
  });
});

test('rollback lease acquisition starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createRollbackLeaseAcquisition({
    leases: { acquire: async () => assert.fail('lease acquisition must not run') },
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.acquire(command), (error) => error === startError);
});

test('rollback lease acquisition requires its lease capability', () => {
  assert.throws(() => createRollbackLeaseAcquisition({ leases: {}, telemetry }), /leases\.acquire is required/);
});
