import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackLeaseAcquisition } from './acquire-rollback-lease.js';

const command = { environment: 'production', siteId: 'site_1' };

test('rollback lease acquisition returns the renewable lease through its narrow capability', async () => {
  const lease = { lockId: 'rollbacklock_1', fencingToken: 1 };
  const calls = [];
  const application = createRollbackLeaseAcquisition({
    leases: {
      async acquire(input) {
        calls.push(input);
        return lease;
      },
    },
  });

  assert.deepEqual(await application.acquire(command), { ok: true, lease });
  assert.deepEqual(calls, [command]);
});

test('rollback lease acquisition distinguishes contention from an acquisition failure', async () => {
  const conflict = createRollbackLeaseAcquisition({ leases: { acquire: async () => null } });
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

test('rollback lease acquisition requires its lease capability', () => {
  assert.throws(() => createRollbackLeaseAcquisition({ leases: {} }), /leases\.acquire is required/);
});
