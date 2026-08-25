import { resolveDeploymentRouteActivation } from '../../domain/deployments/route-activation.js';

export function createDeploymentRouteActivationPreparation({ routes, deploymentState, routeSnapshots }) {
  if (typeof routes?.getBySiteId !== 'function') throw new TypeError('routes.getBySiteId is required');
  if (typeof deploymentState?.update !== 'function') throw new TypeError('deploymentState.update is required');
  if (typeof routeSnapshots?.assertConverged !== 'function') {
    throw new TypeError('routeSnapshots.assertConverged is required');
  }

  return { prepare };

  async function prepare(command) {
    const latestRoute = await routes.getBySiteId(command.siteId, command.environment);
    if (!latestRoute) {
      return failed('ROUTE_ACTIVATION_CONFLICT', 'route_missing');
    }

    try {
      await deploymentState.update(command.deploymentId, {
        previousVersionId: latestRoute.activeVersionId || null,
      });
    } catch (cause) {
      const error = new Error('Deployment state could not be persisted.', { cause });
      error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
      error.deploymentStateOperation = 'persist_previous_version_deployment';
      throw error;
    }

    await routeSnapshots.assertConverged({
      route: latestRoute,
      environment: command.environment,
    });
    const resolution = resolveDeploymentRouteActivation({
      site: command.site,
      routeBeforeActivation: command.routeBeforeActivation,
      latestRoute,
      uploadExposure: command.uploadExposure,
      ownerTransferApplied: command.ownerTransferApplied,
      ownerTransferVisibility: command.ownerTransferVisibility,
    });
    return { ...resolution, latestRoute };
  }
}

function failed(code, reason) {
  return { ok: false, error: { code, reason } };
}
