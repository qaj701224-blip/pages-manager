export function createDeploymentRecoveryPort(store) {
  return {
    restore(command) {
      if (typeof store?.restoreSiteRouteIfCurrent === 'function') {
        return store.restoreSiteRouteIfCurrent(
          command.siteId,
          command.previousRoute,
          command.expectedRoute,
          command.environment
        );
      }
      return store.restoreSiteRoute(command.siteId, command.previousRoute, command.environment);
    },
    restoreOwner:
      typeof store?.transferSiteOwner === 'function' ? store.transferSiteOwner.bind(store) : null,
  };
}
