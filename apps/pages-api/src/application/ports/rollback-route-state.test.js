import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackRouteStatePort } from './rollback-route-state.js';

test('rollback route state port exposes only the bound route lookup', async () => {
  const store = {
    marker: 'bound',
    getRouteBySiteId(siteId, environment) {
      return [this.marker, siteId, environment];
    },
    activateSiteVersion() {},
  };
  const port = createRollbackRouteStatePort(store);

  assert.deepEqual(Object.keys(port), ['getBySiteId']);
  assert.deepEqual(await port.getBySiteId('site_1', 'production'), ['bound', 'site_1', 'production']);
});

test('rollback route state port requires its lookup capability', () => {
  assert.throws(
    () => createRollbackRouteStatePort({}),
    /rollback route state port method is required: getRouteBySiteId/
  );
});
