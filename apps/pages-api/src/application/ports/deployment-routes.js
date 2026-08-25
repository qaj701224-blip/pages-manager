export function createDeploymentRoutesPort(store) {
  return {
    getBySiteId(siteId, environment) {
      return store.getRouteBySiteId(siteId, environment);
    },
    activate(command) {
      if (command.commit) {
        if (typeof store.commitDeploymentActivation !== 'function') {
          const error = new Error('SITE_POLICY_CONFLICT');
          error.code = 'SITE_POLICY_CONFLICT';
          throw error;
        }
        return store.commitDeploymentActivation({
          siteId: command.siteId,
          route: command.route,
          environment: command.environment,
          expectedRoute: command.expectedRoute,
          ...command.commit,
        });
      }
      return store.activateSiteVersion(command.siteId, command.route, command.environment, command.expectedRoute);
    },
  };
}
