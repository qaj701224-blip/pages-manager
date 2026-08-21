import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackLeasePort } from './rollback-lease.js';

test('rollback lease port creates the renewable lease with scoped id and timing options', async () => {
  const store = { acquireSiteCommitLock: async () => null };
  const lease = { lockId: 'rollbacklock_1', fencingToken: 1 };
  const calls = [];
  const port = createRollbackLeasePort({
    store,
    async acquireRenewable(...args) {
      calls.push(args);
      return lease;
    },
    ids: { next: (prefix) => `${prefix}_1` },
    options: { renewIntervalMs: 1000, timeoutMs: 5000 },
  });

  assert.equal(await port.acquire({ environment: 'production', siteId: 'site_1' }), lease);
  assert.deepEqual(calls, [
    [
      store,
      'production',
      'site_1',
      { lockId: 'rollbacklock_1', renewIntervalMs: 1000, timeoutMs: 5000 },
    ],
  ]);
});

test('rollback lease port preserves the legacy missing-lock capability conflict', async () => {
  let idCreated = false;
  const port = createRollbackLeasePort({
    store: {},
    acquireRenewable: async () => assert.fail('renewable lease must not be requested'),
    ids: {
      next() {
        idCreated = true;
      },
    },
  });

  assert.equal(await port.acquire({ environment: 'production', siteId: 'site_1' }), null);
  assert.equal(idCreated, false);
});

test('rollback lease port requires its composition capabilities', () => {
  assert.throws(
    () => createRollbackLeasePort({ store: {}, ids: { next: () => 'id' } }),
    /acquireRenewable is required/
  );
  assert.throws(
    () => createRollbackLeasePort({ store: {}, acquireRenewable: async () => null, ids: {} }),
    /ids\.next is required/
  );
});
