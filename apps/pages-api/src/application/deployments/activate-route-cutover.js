export function createDeploymentRouteCutover({ leases, officeNet, routes }) {
  if (typeof leases?.assertHealthy !== 'function') throw new TypeError('leases.assertHealthy is required');
  if (typeof officeNet?.ensure !== 'function') throw new TypeError('officeNet.ensure is required');
  if (typeof routes?.activate !== 'function') throw new TypeError('routes.activate is required');

  return { activate };

  async function activate(command) {
    leases.assertHealthy(command.lease);
    const officeNetResult = await officeNet.ensure({
      environment: command.environment,
      siteId: command.siteId,
      workerName: command.version.workerName,
      executionProvider: command.version.executionProvider,
      deploymentShape: command.deploymentShape,
      exposure: command.activation.exposure,
      signal: command.lease?.signal,
    });
    if (!officeNetResult.ok) {
      return { ok: false, kind: 'office_net_failed', error: officeNetResult.error };
    }

    leases.assertHealthy(command.lease);
    return routes.activate({
      siteId: command.siteId,
      environment: command.environment,
      version: command.version,
      lease: command.lease,
      activation: command.activation,
      ...(command.commit ? { commit: command.commit } : {}),
    });
  }
}
