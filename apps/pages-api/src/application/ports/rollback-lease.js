export function createRollbackLeasePort({ store, acquireRenewable, ids, options = {} }) {
  if (typeof acquireRenewable !== 'function') throw new TypeError('acquireRenewable is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  return { acquire };

  function acquire(command) {
    if (typeof store?.acquireSiteCommitLock !== 'function') return null;
    return acquireRenewable(store, command.environment, command.siteId, {
      lockId: ids.next('rollbacklock'),
      ...options,
    });
  }
}
