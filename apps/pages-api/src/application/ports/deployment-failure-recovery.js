export function createDeploymentFailureRecoveryPort(store) {
  if (typeof store?.getDeployment !== 'function') {
    throw new TypeError('deployment failure recovery port method is required: getDeployment');
  }
  return { get: store.getDeployment.bind(store) };
}
