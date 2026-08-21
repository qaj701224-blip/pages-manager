import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentCommitReconciliationPort } from './deployment-commit-reconciliation.js';

test('deployment commit reconciliation port exposes only bound state capabilities', async () => {
  const store = {
    marker: 'bound',
    getSiteVersion(id, environment) {
      return [this.marker, 'version', id, environment];
    },
    getRouteBySiteId(id, environment) {
      return [this.marker, 'route', id, environment];
    },
    updateDeployment(id, patch) {
      return [this.marker, 'update', id, patch];
    },
    getSite() {},
  };
  const port = createDeploymentCommitReconciliationPort(store);

  assert.deepEqual(Object.keys(port), ['getVersion', 'getRoute', 'updateDeployment']);
  assert.deepEqual(await port.getVersion('ver_1', 'production'), ['bound', 'version', 'ver_1', 'production']);
  assert.deepEqual(await port.getRoute('site_1', 'production'), ['bound', 'route', 'site_1', 'production']);
  assert.deepEqual(await port.updateDeployment('dep_1', { status: 'succeeded' }), [
    'bound',
    'update',
    'dep_1',
    { status: 'succeeded' },
  ]);
});

test('deployment commit reconciliation port requires every state capability', () => {
  for (const method of ['getSiteVersion', 'getRouteBySiteId', 'updateDeployment']) {
    const store = {
      getSiteVersion() {},
      getRouteBySiteId() {},
      updateDeployment() {},
    };
    delete store[method];
    assert.throws(
      () => createDeploymentCommitReconciliationPort(store),
      new RegExp(`deployment commit reconciliation port method is required: ${method}`)
    );
  }
});
