import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRoutesPort } from './deployment-routes.js';

test('deployment routes port translates the activation command to the Store contract', async () => {
  const calls = [];
  const activatedRoute = { id: 'route_1', activeVersionId: 'ver_2' };
  const store = {
    marker: 'store',
    async activateSiteVersion(...args) {
      assert.equal(this, store);
      calls.push(args);
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

  assert.equal(await port.activate(command), activatedRoute);
  assert.deepEqual(calls, [
    ['site_1', command.route, 'production', command.expectedRoute],
  ]);
});
