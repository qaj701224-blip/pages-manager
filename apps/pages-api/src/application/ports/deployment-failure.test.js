import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentFailurePort } from './deployment-failure.js';

test('deployment failure port exposes only bound terminal persistence capabilities', async () => {
  const store = {
    marker: 'bound',
    getDeployment(id, environment) {
      return [this.marker, 'get', id, environment];
    },
    updateDeployment(id, patch) {
      return [this.marker, 'update', id, patch];
    },
    createDeploymentForIdempotency() {},
  };
  const port = createDeploymentFailurePort(store);

  assert.deepEqual(Object.keys(port), ['get', 'update']);
  assert.deepEqual(await port.get('dep_1', 'production'), ['bound', 'get', 'dep_1', 'production']);
  assert.deepEqual(await port.update('dep_1', { status: 'failed' }), [
    'bound',
    'update',
    'dep_1',
    { status: 'failed' },
  ]);
});

test('deployment failure port requires both persistence capabilities', () => {
  assert.throws(
    () => createDeploymentFailurePort({ updateDeployment: async () => null }),
    /deployment failure port method is required: getDeployment/
  );
  assert.throws(
    () => createDeploymentFailurePort({ getDeployment: async () => null }),
    /deployment failure port method is required: updateDeployment/
  );
});
