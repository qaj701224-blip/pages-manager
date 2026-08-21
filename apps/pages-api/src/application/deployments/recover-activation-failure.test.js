import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentActivationFailureRecovery } from './recover-activation-failure.js';

const site = { id: 'site_1', ownerType: 'team', ownerId: 'team_1' };
const restoredSite = { id: 'site_1', ownerType: 'user', ownerId: 'usr_1' };
const command = {
  site,
  worker: { uploaded: { workerName: 'worker-1' } },
  runtimeConfig: { siteId: 'site_1', enabled: true },
  ownerTransfer: { siteId: 'site_1', enabled: true },
};

test('activation failure recovery preserves cleanup, runtime, and owner restoration order', async () => {
  const calls = [];
  const application = createDeploymentActivationFailureRecovery({
    workers: { cleanup: async (input) => calls.push(['worker', input]) },
    runtimeConfig: { restore: async (input) => calls.push(['runtime', input]) },
    ownerTransfers: {
      async restore(input) {
        calls.push(['owner', input]);
        return restoredSite;
      },
    },
  });

  assert.deepEqual(await application.recover(command), { site: restoredSite });
  assert.deepEqual(calls, [
    ['worker', command.worker],
    ['runtime', command.runtimeConfig],
    ['owner', command.ownerTransfer],
  ]);
});

test('activation failure recovery retains the current site when owner restoration is skipped', async () => {
  const application = createDeploymentActivationFailureRecovery({
    workers: { cleanup: async () => null },
    runtimeConfig: { restore: async () => null },
    ownerTransfers: { restore: async () => null },
  });

  assert.deepEqual(await application.recover(command), { site });
});

test('activation failure recovery requires its narrow stages', () => {
  assert.throws(
    () => createDeploymentActivationFailureRecovery({ workers: {}, runtimeConfig: {}, ownerTransfers: {} }),
    /workers\.cleanup is required/
  );
});
