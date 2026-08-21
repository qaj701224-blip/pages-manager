export function createUnexpectedDeploymentRecoveryPort(store) {
  if (typeof store?.getDeployment !== 'function') {
    throw new TypeError('unexpected deployment recovery port method is required: getDeployment');
  }
  return {
    getDeployment: store.getDeployment.bind(store),
    async loadSite(siteId, environment) {
      if (typeof store.getSite !== 'function') return null;
      const site = await store.getSite(siteId, environment);
      if (!site || typeof store.getRouteBySiteId !== 'function') return site;
      const route = await store.getRouteBySiteId(siteId, environment);
      return route ? { ...site, route } : site;
    },
  };
}
