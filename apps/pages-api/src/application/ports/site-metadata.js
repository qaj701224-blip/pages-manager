export function createSiteMetadataPort(store) {
  return {
    withSiteCommitLock: bindRequired(store, 'withSiteCommitLock'),
    getSite: bindRequired(store, 'getSite'),
    getSiteForUser: bindRequired(store, 'getSiteForUser'),
    getAccessKeyById: bindRequired(store, 'getAccessKeyById'),
    getUser: bindRequired(store, 'getUser'),
    getTeam: bindRequired(store, 'getTeam'),
    isPlatformAdmin: bindRequired(store, 'isPlatformAdmin'),
    getRouteBySiteId: bindRequired(store, 'getRouteBySiteId'),
    listSiteRetiringHostnameClaims: bindRequired(store, 'listSiteRetiringHostnameClaims'),
    listSitesPendingSlugRouting: bindRequired(store, 'listSitesPendingSlugRouting'),
    markSiteSlugRoutingReconcileAttempted: bindRequired(store, 'markSiteSlugRoutingReconcileAttempted'),
    commitSiteMetadata: bindRequired(store, 'commitSiteMetadata'),
    completeSiteSlugRelease: bindRequired(store, 'completeSiteSlugRelease'),
    markSiteSlugRoutingSynced: bindRequired(store, 'markSiteSlugRoutingSynced'),
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') {
    const error = new Error(`site metadata port method is required: ${name}`);
    error.code = 'SITE_METADATA_UPDATE_FAILED';
    throw error;
  }
  return target[name].bind(target);
}
