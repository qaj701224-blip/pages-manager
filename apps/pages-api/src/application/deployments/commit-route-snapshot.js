export function createDeploymentRouteSnapshotCommit({ routeSnapshots, leases, telemetry }) {
  if (typeof routeSnapshots?.commitDeployment !== 'function') {
    throw new TypeError('routeSnapshots.commitDeployment is required');
  }
  if (typeof leases?.assertHealthy !== 'function') throw new TypeError('leases.assertHealthy is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');

  return { commit };

  function commit(command) {
    const stage = telemetry.start();
    return commitAfterStart(command, stage);
  }

  async function commitAfterStart(command, stage) {
    const { lease, ...snapshotCommand } = command;
    try {
      leases.assertHealthy(lease);
      const snapshot = await routeSnapshots.commitDeployment(snapshotCommand);
      leases.assertHealthy(lease);
      await telemetry.finish(stage, { status: 'succeeded' });
      return { ok: true, snapshot };
    } catch (cause) {
      await telemetry.finish(stage, { status: 'failed', reason: 'snapshot_error', cause });
      return { ok: false, error: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', cause } };
    }
  }
}
