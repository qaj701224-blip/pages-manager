export function createDeploymentRoutesPort(store) {
  return {
    getBySiteId(siteId, environment) {
      return store.getRouteBySiteId(siteId, environment);
    },
    activate(command) {
      return store.activateSiteVersion(command.siteId, command.route, command.environment, command.expectedRoute);
    },
  };
}
