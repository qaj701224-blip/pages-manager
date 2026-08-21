import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentOwnerTransferRestoration } from './restore-owner-transfer.js';

const previousSite = {
  ownerType: 'user',
  ownerId: 'usr_1',
  ownerUserId: 'usr_1',
  defaultVisibility: 'internal',
  updatedAt: '2026-08-21T00:00:00.000Z',
};

test('owner transfer restoration maps the previous authority through its narrow port', async () => {
  const restoredSite = { id: 'site_1', ...previousSite };
  let input;
  const application = createDeploymentOwnerTransferRestoration({
    owners: {
      async restore(command) {
        input = command;
        return restoredSite;
      },
    },
  });

  assert.equal(
    await application.restore({
      siteId: 'site_1',
      environment: 'production',
      enabled: true,
      previousSite,
    }),
    restoredSite
  );
  assert.deepEqual(input, {
    siteId: 'site_1',
    environment: 'production',
    owner: previousSite,
  });
});

test('owner transfer restoration skips inactive compensation and isolates restore failures', async () => {
  let calls = 0;
  const application = createDeploymentOwnerTransferRestoration({
    owners: {
      async restore() {
        calls += 1;
        throw new Error('restore failed');
      },
    },
  });

  assert.equal(await application.restore({ enabled: false, previousSite }), null);
  assert.equal(await application.restore({ enabled: true, previousSite: null }), null);
  assert.equal(await application.restore({ enabled: true, previousSite }), null);
  assert.equal(calls, 1);
});

test('owner transfer restoration requires its narrow capability', () => {
  assert.throws(() => createDeploymentOwnerTransferRestoration({ owners: {} }), /owners\.restore is required/);
});
