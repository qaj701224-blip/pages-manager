import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRecoveryPort } from './deployment-recovery.js';

test('deployment recovery port prefers the CAS route restoration capability', async () => {
  const calls = [];
  const store = {
    async restoreSiteRouteIfCurrent(...args) {
      calls.push(['current', ...args]);
      return { id: 'route_1' };
    },
    async restoreSiteRoute(...args) {
      calls.push(['fallback', ...args]);
      return null;
    },
    async transferSiteOwner(...args) {
      calls.push(['owner', ...args]);
      return { id: 'site_1' };
    },
  };
  const port = createDeploymentRecoveryPort(store);
  const command = {
    siteId: 'site_1',
    previousRoute: { activeVersionId: 'ver_1' },
    expectedRoute: { activeVersionId: 'ver_2' },
    environment: 'production',
  };

  assert.deepEqual(await port.restore(command), { id: 'route_1' });
  assert.deepEqual(await port.restoreOwner('site_1', { ownerId: 'usr_1' }, 'production'), { id: 'site_1' });
  assert.deepEqual(calls, [
    ['current', 'site_1', command.previousRoute, command.expectedRoute, 'production'],
    ['owner', 'site_1', { ownerId: 'usr_1' }, 'production'],
  ]);
});

test('deployment recovery port retains the legacy route restoration fallback', async () => {
  const calls = [];
  const port = createDeploymentRecoveryPort({
    async restoreSiteRoute(...args) {
      calls.push(args);
      return { id: 'route_1' };
    },
  });

  assert.deepEqual(
    await port.restore({
      siteId: 'site_1',
      previousRoute: { activeVersionId: 'ver_1' },
      expectedRoute: { activeVersionId: 'ver_2' },
      environment: 'staging',
    }),
    { id: 'route_1' }
  );
  assert.deepEqual(calls, [['site_1', { activeVersionId: 'ver_1' }, 'staging']]);
  assert.equal(port.restoreOwner, null);
});
