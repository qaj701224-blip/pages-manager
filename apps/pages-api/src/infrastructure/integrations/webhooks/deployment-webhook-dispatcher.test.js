import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentWebhookDispatcher } from './deployment-webhook-dispatcher.js';

test('deployment webhook dispatcher scopes subscription lookup to the configured environment', async () => {
  const calls = [];
  const dispatcher = createDeploymentWebhookDispatcher({
    store: {
      async listWebhookSubscriptions(input) {
        calls.push(input);
        return [];
      },
    },
    env: {},
    config: { environment: 'staging' },
  });

  assert.deepEqual(await dispatcher.deliver({ type: 'site.deployed' }), []);
  assert.deepEqual(calls, [{ environment: 'staging' }]);
});
