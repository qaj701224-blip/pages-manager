import { resolveDeploymentRouteActivation } from '../../domain/deployments/route-activation.js';

export function createDeploymentRouteActivation({ routes, telemetry, clock }) {
  if (typeof routes?.activate !== 'function') throw new TypeError('routes.activate is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { resolve: resolveDeploymentRouteActivation, activate };

  async function activate(command) {
    const stage = telemetry.start();
    try {
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
          ...(command.requiredArtifactAvailability
            ? { requiredArtifactAvailability: command.requiredArtifactAvailability }
            : {}),
          lease: command.lease,
          updatedAt: clock.now(),
        },
        expectedRoute: command.activation.expectedRoute,
      });
      const result = route
        ? { ok: true, route }
        : { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'cas_conflict' } };
      await telemetry.finish(stage, result.ok ? { status: 'succeeded' } : { status: 'failed', reason: 'cas_conflict' });
      return result;
    } catch (cause) {
      await telemetry.finish(stage, { status: 'failed', reason: 'route_error', cause });
      throw cause;
    }
  }
}
