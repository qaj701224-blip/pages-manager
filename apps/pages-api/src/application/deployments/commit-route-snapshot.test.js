import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRouteSnapshotCommit } from './commit-route-snapshot.js';

const command = {
  site: { id: 'site_1' },
  route: { id: 'route_1', activeVersionId: 'ver_2' },
  version: { id: 'ver_2' },
  lease: { lockId: 'lock_1' },
};
const leases = { assertHealthy: () => null };
const telemetry = { start: () => null, finish: async () => null };

test('deployment route snapshot commit uses its narrow snapshot capability', async () => {
  const calls = [];
  const snapshot = { routeId: 'route_1', activeVersionId: 'ver_2' };
  const stage = { operation: 'write_route_snapshot' };
  const application = createDeploymentRouteSnapshotCommit({
    routeSnapshots: {
      async commitDeployment(input) {
        calls.push(['snapshot', input]);
        return snapshot;
      },
    },
    leases: {
      assertHealthy(lease) {
        calls.push(['lease', lease]);
      },
    },
    telemetry: {
      start() {
        calls.push(['start']);
        return stage;
      },
      async finish(receivedStage, outcome) {
        calls.push(['finish', receivedStage, outcome]);
      },
    },
  });

  assert.deepEqual(await application.commit(command), { ok: true, snapshot });
  assert.deepEqual(calls, [
    ['start'],
    ['lease', command.lease],
    ['snapshot', { site: command.site, route: command.route, version: command.version }],
    ['lease', command.lease],
    ['finish', stage, { status: 'succeeded' }],
  ]);
});

test('deployment route snapshot commit maps infrastructure failures without hiding their cause', async () => {
  const cause = new Error('route snapshot unavailable');
  const calls = [];
  const stage = { operation: 'write_route_snapshot' };
  const application = createDeploymentRouteSnapshotCommit({
    routeSnapshots: {
      commitDeployment: async () => {
        calls.push(['snapshot']);
        throw cause;
      },
    },
    leases: {
      assertHealthy() {
        calls.push(['lease']);
      },
    },
    telemetry: {
      start() {
        calls.push(['start']);
        return stage;
      },
      async finish(receivedStage, outcome) {
        calls.push(['finish', receivedStage, outcome]);
      },
    },
  });

  assert.deepEqual(await application.commit(command), {
    ok: false,
    error: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', cause },
  });
  assert.deepEqual(calls, [
    ['start'],
    ['lease'],
    ['snapshot'],
    ['finish', stage, { status: 'failed', reason: 'snapshot_error', cause }],
  ]);
});

test('deployment route snapshot commit starts telemetry synchronously before recovery can catch it', () => {
  const startError = new Error('invalid trace');
  const application = createDeploymentRouteSnapshotCommit({
    routeSnapshots: { commitDeployment: async () => assert.fail('snapshot must not run') },
    leases,
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.commit(command), (error) => error === startError);
});

test('deployment route snapshot commit requires its snapshot capability', () => {
  assert.throws(
    () => createDeploymentRouteSnapshotCommit({ routeSnapshots: {}, leases, telemetry }),
    /routeSnapshots\.commitDeployment is required/
  );
  assert.throws(
    () =>
      createDeploymentRouteSnapshotCommit({
        routeSnapshots: { commitDeployment: async () => null },
        leases: {},
        telemetry,
      }),
    /leases\.assertHealthy is required/
  );
});
