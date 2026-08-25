export function createSiteLifecyclePort(store) {
  return {
    withSiteCommitLock: bindRequired(store, 'withSiteCommitLock'),
    getSite: bindRequired(store, 'getSite'),
    getSiteForUser: bindRequired(store, 'getSiteForUser'),
    getAccessKeyById: bindRequired(store, 'getAccessKeyById'),
    getUser: bindRequired(store, 'getUser'),
    getTeam: bindRequired(store, 'getTeam'),
    isPlatformAdmin: bindRequired(store, 'isPlatformAdmin'),
    getRouteBySiteId: bindRequired(store, 'getRouteBySiteId'),
    getHostnameClaim: bindOptional(store, 'getHostnameClaim'),
    listSiteHostnameClaims: bindOptional(store, 'listSiteHostnameClaims'),
    listSiteRetiringHostnameClaims: bindOptional(store, 'listSiteRetiringHostnameClaims'),
    deleteSite: bindRequired(store, 'deleteSite'),
    restoreSiteDeleteIfCurrent: bindOptional(store, 'restoreSiteDeleteIfCurrent'),
    restoreSiteRouteIfCurrent: bindOptional(store, 'restoreSiteRouteIfCurrent'),
    restoreSiteRoute: bindOptional(store, 'restoreSiteRoute'),
  };
}

export function createDeletedResourceCleanupPort(store) {
  return {
    listSiteWfpCleanupReferences: bindOptional(store, 'listSiteWfpCleanupReferences'),
    createDeploymentResourceCleanupTask: bindOptional(store, 'createDeploymentResourceCleanupTask'),
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') throw new TypeError(`site lifecycle port method is required: ${name}`);
  return target[name].bind(target);
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}
