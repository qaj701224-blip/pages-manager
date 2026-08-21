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

export function createRollbackRecoveryPort(store) {
  return {
    ...createDeploymentRecoveryPort(store),
    getVersion: bindRequired(store, 'getSiteVersion'),
    updateAccessPolicy: bindRequired(store, 'updateSiteAccessPolicy'),
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') throw new TypeError(`deployment recovery port method is required: ${name}`);
  return target[name].bind(target);
}
