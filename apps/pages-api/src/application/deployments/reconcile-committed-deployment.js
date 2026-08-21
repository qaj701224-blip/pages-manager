import { synthesizeSucceededDeployment } from './complete-deployment.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export function createCommittedDeploymentReconciliation({ state, traces, telemetry, clock }) {
  if (typeof state?.getVersion !== 'function') throw new TypeError('state.getVersion is required');
  if (typeof state?.getRoute !== 'function') throw new TypeError('state.getRoute is required');
  if (typeof state?.updateDeployment !== 'function') throw new TypeError('state.updateDeployment is required');
  if (typeof traces?.forDeployment !== 'function') throw new TypeError('traces.forDeployment is required');
  if (typeof telemetry?.reconciled !== 'function') throw new TypeError('telemetry.reconciled is required');
  if (typeof telemetry?.persistFailed !== 'function') throw new TypeError('telemetry.persistFailed is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { reconcile };

  async function reconcile(command) {
    const { deployment, environment } = command;
    if (!deployment || TERMINAL_STATUSES.has(deployment.status)) return deployment;
    if (!deployment.siteId || !deployment.versionId) return deployment;

    const version = await state.getVersion(deployment.versionId, environment);
    const route = await state.getRoute(deployment.siteId, environment);
    const routeCommitted = route?.activeVersionId === deployment.versionId;
    const deploymentOwnsVersion = version?.deploymentId === deployment.id;
    const rollbackCommitted = deployment.operation === 'rollback' && Boolean(version) && routeCommitted;
    if (!routeCommitted || (!deploymentOwnsVersion && !rollbackCommitted)) return deployment;

    const patch = {
      status: 'succeeded',
      versionId: deployment.versionId,
      completedAt: deployment.completedAt || clock.now(),
    };
    const trace = command.trace || (await traces.forDeployment(deployment, environment));
    try {
      const reconciled =
        (await state.updateDeployment(deployment.id, patch)) || synthesizeSucceededDeployment(deployment, patch);
      if (trace) await telemetry.reconciled(trace);
      return reconciled;
    } catch (cause) {
      await telemetry.persistFailed({
        trace,
        deploymentId: deployment.id,
        operation: 'reconcile_committed_deployment',
        cause,
      });
      return synthesizeSucceededDeployment(deployment, patch);
    }
  }
}
