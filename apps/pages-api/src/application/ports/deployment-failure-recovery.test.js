import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentFailureRecoveryPort } from './deployment-failure-recovery.js';

test('deployment failure recovery port exposes only the bound deployment lookup', async () => {
  const store = {
    marker: 'bound',
    getDeployment(id, environment) {
      return [this.marker, id, environment];
    },
    updateDeployment() {},
  };
  const port = createDeploymentFailureRecoveryPort(store);

  assert.deepEqual(Object.keys(port), ['get']);
  assert.deepEqual(await port.get('dep_1', 'production'), ['bound', 'dep_1', 'production']);
});

test('deployment failure recovery port requires its lookup capability', () => {
  assert.throws(
    () => createDeploymentFailureRecoveryPort({}),
    /deployment failure recovery port method is required: getDeployment/
  );
});
