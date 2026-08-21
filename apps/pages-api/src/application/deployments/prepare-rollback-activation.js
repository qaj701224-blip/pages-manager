export function createRollbackActivationPreparation({ leases, routes }) {
  if (typeof leases?.acquire !== 'function') throw new TypeError('leases.acquire is required');
  if (typeof leases?.release !== 'function') throw new TypeError('leases.release is required');
  if (typeof routes?.read !== 'function') throw new TypeError('routes.read is required');

  return { prepare };

  async function prepare(command) {
    const leaseResult = await leases.acquire({
      environment: command.environment,
      siteId: command.siteId,
    });
    if (!leaseResult.ok) return leaseResult;

    const routeBeforeActivation = command.currentRoute;
    const routeState = await routes.read({
      siteId: command.siteId,
      environment: command.environment,
    });
    if (!routeState.ok) {
      await leases.release(leaseResult.lease);
      return routeState;
    }

    return {
      ok: true,
      lease: leaseResult.lease,
      route: routeState.route,
      routeBeforeActivation,
    };
  }
}
