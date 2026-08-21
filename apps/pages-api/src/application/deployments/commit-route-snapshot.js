export function createDeploymentRouteSnapshotCommit({ routeSnapshots }) {
  if (typeof routeSnapshots?.commitDeployment !== 'function') {
    throw new TypeError('routeSnapshots.commitDeployment is required');
  }

  return { commit };

  async function commit(command) {
    try {
      const snapshot = await routeSnapshots.commitDeployment(command);
      return { ok: true, snapshot };
    } catch (cause) {
      return { ok: false, error: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', cause } };
    }
  }
}
