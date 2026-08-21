export function createDeploymentCleanupTasksPort(store) {
  return {
    create:
      typeof store?.createDeploymentResourceCleanupTask === 'function'
        ? store.createDeploymentResourceCleanupTask.bind(store)
        : null,
  };
}
