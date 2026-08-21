import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentCompletionPort } from './deployment-completion.js';

test('deployment completion port binds the Store update contract', async () => {
  const calls = [];
  const store = {
    marker: 'store',
    async updateDeployment(...args) {
      assert.equal(this, store);
      calls.push(args);
      return { id: args[0], ...args[1] };
    },
  };
  const port = createDeploymentCompletionPort(store);
  const patch = { status: 'succeeded', versionId: 'ver_2' };

  assert.deepEqual(await port.update('dep_1', patch), { id: 'dep_1', ...patch });
  assert.deepEqual(calls, [['dep_1', patch]]);
});

test('deployment completion port requires the Store update method', () => {
  assert.throws(() => createDeploymentCompletionPort({}), /deployment completion port method is required/);
});
