export function createSiteOwnershipPort(store) {
  return {
    transferSiteOwner: bindOptional(store, 'transferSiteOwner'),
    getRouteBySiteId: bindRequired(store, 'getRouteBySiteId'),
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') throw portError('SITE_TRANSFER_UNSUPPORTED');
  return target[name].bind(target);
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}

function portError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
