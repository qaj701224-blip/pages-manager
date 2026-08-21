import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRecoveryPort, createRollbackRecoveryPort } from './deployment-recovery.js';

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
    async getSiteVersion(...args) {
      calls.push(['version', ...args]);
      return { id: args[0] };
    },
    async updateSiteAccessPolicy(...args) {
      calls.push(['policy', ...args]);
      return { route: { id: 'route_1' } };
    },
  };
  const port = createRollbackRecoveryPort(store);
  const command = {
    siteId: 'site_1',
    previousRoute: { activeVersionId: 'ver_1' },
    expectedRoute: { activeVersionId: 'ver_2' },
    environment: 'production',
  };

  assert.deepEqual(await port.restore(command), { id: 'route_1' });
  assert.deepEqual(await port.getVersion('ver_1', 'production'), { id: 'ver_1' });
  assert.deepEqual(await port.updateAccessPolicy({ siteId: 'site_1' }), { route: { id: 'route_1' } });
  assert.deepEqual(calls, [
    ['current', 'site_1', command.previousRoute, command.expectedRoute, 'production'],
    ['version', 'ver_1', 'production'],
    ['policy', { siteId: 'site_1' }],
  ]);
});

test('deployment recovery port retains the legacy route restoration fallback', async () => {
  const calls = [];
  const port = createDeploymentRecoveryPort({
    async restoreSiteRoute(...args) {
      calls.push(args);
      return { id: 'route_1' };
    },
    async getSiteVersion(versionId) {
      return { id: versionId };
    },
    async updateSiteAccessPolicy() {
      return null;
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
});
