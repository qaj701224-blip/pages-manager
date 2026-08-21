export function createDeploymentRoutesPort(store) {
  return {
    activate(command) {
      return store.activateSiteVersion(command.siteId, command.route, command.environment, command.expectedRoute);
    },
  };
}
