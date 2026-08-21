export function createDeploymentCompletionPort(store) {
  if (typeof store?.updateDeployment !== 'function') {
    throw new TypeError('deployment completion port method is required: updateDeployment');
  }
  return { update: store.updateDeployment.bind(store) };
}
