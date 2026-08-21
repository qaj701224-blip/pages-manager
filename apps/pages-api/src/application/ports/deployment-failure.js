export function createDeploymentFailurePort(store) {
  if (typeof store?.getDeployment !== 'function') {
    throw new TypeError('deployment failure port method is required: getDeployment');
  }
  if (typeof store?.updateDeployment !== 'function') {
    throw new TypeError('deployment failure port method is required: updateDeployment');
  }
  return {
    get: store.getDeployment.bind(store),
    update: store.updateDeployment.bind(store),
  };
}
