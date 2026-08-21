export function createSitePolicyPort(store) {
  return {
    withSiteCommitLock: bindRequired(store, 'withSiteCommitLock'),
    getSite: bindRequired(store, 'getSite'),
    getRouteBySiteId: bindRequired(store, 'getRouteBySiteId'),
    listSiteAclEntries: bindRequired(store, 'listSiteAclEntries'),
    updateSiteAccessPolicy: bindRequired(store, 'updateSiteAccessPolicy'),
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') {
    const error = new Error(`site policy port method is required: ${name}`);
    error.code = 'SITE_POLICY_UPDATE_FAILED';
    throw error;
  }
  return target[name].bind(target);
}
