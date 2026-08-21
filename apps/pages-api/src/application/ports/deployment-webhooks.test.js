import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentWebhookTeamsPort } from './deployment-webhooks.js';

test('deployment webhook teams port binds the optional Store capability', async () => {
  const calls = [];
  const store = {
    async getTeam(teamId) {
      calls.push(teamId);
      return { id: teamId };
    },
  };
  const port = createDeploymentWebhookTeamsPort(store);

  assert.deepEqual(await port.get('team_1'), { id: 'team_1' });
  assert.deepEqual(calls, ['team_1']);
  assert.equal(createDeploymentWebhookTeamsPort({}).get, null);
});
