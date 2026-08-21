export function createRollbackRouteFinalization({ routeSnapshots, recovery, leases, completion }) {
  if (typeof routeSnapshots?.commit !== 'function') throw new TypeError('routeSnapshots.commit is required');
  if (typeof recovery?.recover !== 'function') throw new TypeError('recovery.recover is required');
  if (typeof leases?.release !== 'function') throw new TypeError('leases.release is required');
  if (typeof completion?.finalize !== 'function') throw new TypeError('completion.finalize is required');

  return { finalize };

  async function finalize(command) {
    const snapshotResult = await routeSnapshots.commit({
      site: command.site,
      route: command.route,
      version: command.version,
      lease: command.lease,
    });
    if (!snapshotResult.ok) {
      const recovered = await recovery.recover({
        site: command.site,
        deploymentId: command.deployment.id,
        previousRoute: command.previousRoute,
        failedRoute: command.route,
        environment: command.environment,
        lease: command.lease,
      });
      await leases.release(command.lease);
      return { ok: false, error: { reason: 'snapshot_failed', recovery: recovered } };
    }

    await leases.release(command.lease);
    const completed = await completion.finalize({
      deployment: command.deployment,
      version: command.version,
      previousRoute: command.previousRoute,
    });
    return { ok: true, completed };
  }
}
