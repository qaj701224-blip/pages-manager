export function createRollbackRouteCutover({ routeSnapshots, leases, officeNet, routes }) {
  if (typeof routeSnapshots?.assertConverged !== 'function') {
    throw new TypeError('routeSnapshots.assertConverged is required');
  }
  if (typeof leases?.assertHealthy !== 'function') throw new TypeError('leases.assertHealthy is required');
  if (typeof officeNet?.verify !== 'function') throw new TypeError('officeNet.verify is required');
  if (typeof routes?.activate !== 'function') throw new TypeError('routes.activate is required');

  return { activate };

  async function activate(command) {
    await routeSnapshots.assertConverged({
      route: command.currentRoute,
      environment: command.environment,
    });
    leases.assertHealthy(command.lease);
    const officeNetResult = await officeNet.verify({
      environment: command.environment,
      siteId: command.siteId,
      version: command.version,
      currentVersionId: command.currentRoute.activeVersionId,
      exposure: command.exposure,
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
      requiredArtifactAvailability: 'active',
    });
  }
}
