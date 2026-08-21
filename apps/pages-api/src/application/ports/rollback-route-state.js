export function createRollbackRouteStatePort(store) {
  if (typeof store?.getRouteBySiteId !== 'function') {
    throw new TypeError('rollback route state port method is required: getRouteBySiteId');
  }
  return { getBySiteId: store.getRouteBySiteId.bind(store) };
}
