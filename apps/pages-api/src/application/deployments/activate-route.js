import { resolveDeploymentRouteActivation } from '../../domain/deployments/route-activation.js';

export function createDeploymentRouteActivation({ routes, clock }) {
  if (typeof routes?.activate !== 'function') throw new TypeError('routes.activate is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { resolve: resolveDeploymentRouteActivation, activate };

  async function activate(command) {
    const route = await routes.activate({
      siteId: command.siteId,
      environment: command.environment,
      route: {
        activeVersionId: command.version.id,
        workerName: command.version.workerName,
        runtime: command.version.runtime,
        executionProvider: command.version.executionProvider,
        dispatchType: command.version.dispatchType,
        dispatchBindingName: command.version.dispatchBindingName,
        slotId: command.version.slotId,
        visibility: command.activation.visibility,
        lease: command.lease,
        updatedAt: clock.now(),
      },
      expectedRoute: command.activation.expectedRoute,
    });
    return route
      ? { ok: true, route }
      : { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'cas_conflict' } };
  }
}
