export function createDeploymentCommitLeasePort({ store, ids }) {
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  return { run };

  function run(command, work) {
    if (typeof store?.withSiteCommitLock !== 'function') return null;
    return store.withSiteCommitLock(command.environment, command.siteId, work, {
      lockId: ids.next('deploylock'),
      bestEffortRelease: true,
    });
  }
}
