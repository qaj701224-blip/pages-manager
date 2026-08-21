export function createSiteLifecyclePort(store) {
  return {
    getRouteBySiteId: bindRequired(store, 'getRouteBySiteId'),
    getHostnameClaim: bindOptional(store, 'getHostnameClaim'),
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
