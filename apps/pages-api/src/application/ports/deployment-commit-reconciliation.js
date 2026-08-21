export function createDeploymentCommitReconciliationPort(store) {
  for (const method of ['getSiteVersion', 'getRouteBySiteId', 'updateDeployment']) {
    if (typeof store?.[method] !== 'function') {
      throw new TypeError(`deployment commit reconciliation port method is required: ${method}`);
    }
  }
  return {
    getVersion: store.getSiteVersion.bind(store),
    getRoute: store.getRouteBySiteId.bind(store),
    updateDeployment: store.updateDeployment.bind(store),
  };
}
