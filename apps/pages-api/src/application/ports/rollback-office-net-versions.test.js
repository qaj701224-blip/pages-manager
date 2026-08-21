import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackOfficeNetVersionsPort } from './rollback-office-net-versions.js';

test('rollback OfficeNet versions port exposes only the bound version lookup', async () => {
  const store = {
    marker: 'bound',
    getSiteVersion(versionId, environment) {
      return [this.marker, versionId, environment];
    },
    createSiteVersion() {},
  };
  const port = createRollbackOfficeNetVersionsPort(store);

  assert.deepEqual(Object.keys(port), ['getById']);
  assert.deepEqual(await port.getById('ver_1', 'production'), ['bound', 'ver_1', 'production']);
});

test('rollback OfficeNet versions port requires its lookup capability', () => {
  assert.throws(
    () => createRollbackOfficeNetVersionsPort({}),
    /rollback OfficeNet versions port method is required: getSiteVersion/
  );
});
