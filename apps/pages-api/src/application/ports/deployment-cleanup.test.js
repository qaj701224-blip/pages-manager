import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentCleanupTasksPort } from './deployment-cleanup.js';

test('deployment cleanup tasks port binds the optional Store capability', async () => {
  const calls = [];
  const store = {
    async createDeploymentResourceCleanupTask(input) {
      calls.push(input);
      return input;
    },
  };
  const input = { id: 'cln_1' };
  const port = createDeploymentCleanupTasksPort(store);

  assert.equal(await port.create(input), input);
  assert.deepEqual(calls, [input]);
  assert.equal(createDeploymentCleanupTasksPort({}).create, null);
});
