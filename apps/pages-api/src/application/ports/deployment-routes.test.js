import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRoutesPort } from './deployment-routes.js';

test('deployment routes port translates the activation command to the Store contract', async () => {
  const calls = [];
  const activatedRoute = { id: 'route_1', activeVersionId: 'ver_2' };
  const store = {
    marker: 'store',
    async getRouteBySiteId(...args) {
      assert.equal(this, store);
      calls.push(['read', ...args]);
      return { id: 'route_1' };
    },
    async activateSiteVersion(...args) {
      assert.equal(this, store);
      calls.push(['activate', ...args]);
      return activatedRoute;
    },
  };
  const port = createDeploymentRoutesPort(store);
  const command = {
    siteId: 'site_1',
    route: { activeVersionId: 'ver_2', visibility: 'org' },
    environment: 'production',
    expectedRoute: { activeVersionId: 'ver_1', routeGeneration: 3 },
  };

  assert.deepEqual(await port.getBySiteId('site_1', 'production'), { id: 'route_1' });
  assert.equal(await port.activate(command), activatedRoute);
  assert.deepEqual(calls, [
    ['read', 'site_1', 'production'],
    ['activate', 'site_1', command.route, 'production', command.expectedRoute],
  ]);
});
