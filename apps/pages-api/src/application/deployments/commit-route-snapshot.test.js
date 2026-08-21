import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRouteSnapshotCommit } from './commit-route-snapshot.js';

const command = {
  site: { id: 'site_1' },
  route: { id: 'route_1', activeVersionId: 'ver_2' },
  version: { id: 'ver_2' },
};

test('deployment route snapshot commit uses its narrow snapshot capability', async () => {
  const calls = [];
  const snapshot = { routeId: 'route_1', activeVersionId: 'ver_2' };
  const application = createDeploymentRouteSnapshotCommit({
    routeSnapshots: {
      async commitDeployment(input) {
        calls.push(input);
        return snapshot;
      },
    },
  });

  assert.deepEqual(await application.commit(command), { ok: true, snapshot });
  assert.deepEqual(calls, [command]);
});

test('deployment route snapshot commit maps infrastructure failures without hiding their cause', async () => {
  const cause = new Error('route snapshot unavailable');
  const application = createDeploymentRouteSnapshotCommit({
    routeSnapshots: {
      commitDeployment: async () => {
        throw cause;
      },
    },
  });

  assert.deepEqual(await application.commit(command), {
    ok: false,
    error: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', cause },
  });
});

test('deployment route snapshot commit requires its snapshot capability', () => {
  assert.throws(
    () => createDeploymentRouteSnapshotCommit({ routeSnapshots: {} }),
    /routeSnapshots\.commitDeployment is required/
  );
});
