import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentCommitLeasePort } from './deployment-commit-lease.js';

test('deployment commit lease port applies the stable deploy lock options', async () => {
  const calls = [];
  const lease = { lockId: 'deploylock_1', fencingToken: 2 };
  const store = {
    async withSiteCommitLock(environment, siteId, work, options) {
      calls.push({ environment, siteId, options });
      return work(lease);
    },
  };
  const port = createDeploymentCommitLeasePort({
    store,
    ids: {
      next(prefix) {
        calls.push({ prefix });
        return 'deploylock_1';
      },
    },
  });

  assert.equal(
    await port.run({ environment: 'production', siteId: 'site_1' }, async (receivedLease) => {
      assert.equal(receivedLease, lease);
      return 'committed';
    }),
    'committed'
  );
  assert.deepEqual(calls, [
    { prefix: 'deploylock' },
    {
      environment: 'production',
      siteId: 'site_1',
      options: { lockId: 'deploylock_1', bestEffortRelease: true },
    },
  ]);
});

test('deployment commit lease port reports an unavailable store capability without allocating an id', async () => {
  const port = createDeploymentCommitLeasePort({
    store: {},
    ids: { next: () => assert.fail('id must not be allocated') },
  });

  assert.equal(await port.run({ environment: 'production', siteId: 'site_1' }, async () => 'unused'), null);
});

test('deployment commit lease port requires its id capability', () => {
  assert.throws(() => createDeploymentCommitLeasePort({ store: {}, ids: {} }), /ids\.next is required/);
});
