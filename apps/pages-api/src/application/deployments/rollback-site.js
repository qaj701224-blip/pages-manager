export function createRollbackSite({ preparation, cutover, versions, finalization, leases }) {
  if (typeof preparation?.prepare !== 'function') throw new TypeError('preparation.prepare is required');
  if (typeof cutover?.activate !== 'function') throw new TypeError('cutover.activate is required');
  if (typeof versions?.get !== 'function') throw new TypeError('versions.get is required');
  if (typeof finalization?.finalize !== 'function') throw new TypeError('finalization.finalize is required');
  if (typeof leases?.release !== 'function') throw new TypeError('leases.release is required');

  return { execute };

  async function execute(command) {
    const prepared = await preparation.prepare({
      environment: command.environment,
      siteId: command.site.id,
      currentRoute: command.currentRoute,
    });
    if (!prepared.ok) {
      return failed('prepare', prepared.error, command.currentRoute);
    }

    const currentRoute = prepared.route;
    let activation;
    try {
      activation = await cutover.activate({
        environment: command.environment,
        siteId: command.site.id,
        currentRoute,
        version: command.version,
        lease: prepared.lease,
        exposure: command.exposure,
        activation: {
          visibility: currentRoute.visibility,
          expectedRoute: {
            ...currentRoute,
            exposure: command.exposure,
          },
        },
      });
    } catch (cause) {
      await leases.release(prepared.lease);
      return failed('activate', { reason: 'activation_error', cause }, prepared.routeBeforeActivation);
    }

    if (!activation.ok && activation.kind === 'office_net_failed') {
      await leases.release(prepared.lease);
      return failed(
        'activate',
        { reason: 'office_net_failed', officeNetError: activation.error },
        prepared.routeBeforeActivation
      );
    }
    if (!activation.ok) {
      await leases.release(prepared.lease);
      const latestVersion = await versions.get(command.version.id, command.environment);
      if (latestVersion?.artifactAvailability !== 'active') {
        return failed('activate', { reason: 'version_unavailable' }, currentRoute);
      }
      return failed('activate', { reason: 'route_conflict' }, currentRoute);
    }

    const finalized = await finalization.finalize({
      site: command.site,
      deployment: command.deployment,
      previousRoute: currentRoute,
      route: activation.route,
      version: command.version,
      lease: prepared.lease,
      environment: command.environment,
    });
    if (!finalized.ok) {
      return {
        ...failed('finalize', finalized.error, currentRoute),
        route: activation.route,
      };
    }
    return { ok: true, route: activation.route, completed: finalized.completed };
  }
}

function failed(stage, error, previousRoute) {
  return { ok: false, stage, error, previousRoute };
}
