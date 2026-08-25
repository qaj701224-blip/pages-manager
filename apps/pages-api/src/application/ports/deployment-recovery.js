export function createDeploymentRecoveryPort(store) {
  return {
    ...(typeof store?.restoreDeploymentActivationIfCurrent === 'function'
      ? { restoreWithOwner: store.restoreDeploymentActivationIfCurrent.bind(store) }
      : {}),
    restore(command) {
      if (typeof store?.restoreSiteRouteIfCurrent === 'function') {
        return store.restoreSiteRouteIfCurrent(command.siteId, command.previousRoute, command.expectedRoute, command.environment);
      }
      return store.restoreSiteRoute(command.siteId, command.previousRoute, command.environment);
    },
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
