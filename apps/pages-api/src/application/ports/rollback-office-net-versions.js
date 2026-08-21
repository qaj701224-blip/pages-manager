export function createRollbackOfficeNetVersionsPort(store) {
  if (typeof store?.getSiteVersion !== 'function') {
    throw new TypeError('rollback OfficeNet versions port method is required: getSiteVersion');
  }
  return { getById: store.getSiteVersion.bind(store) };
}
