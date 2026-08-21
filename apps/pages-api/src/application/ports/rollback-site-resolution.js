export function createRollbackSiteResolutionPort(store) {
  const port = {
    getVersion: bindRequired(store, 'getSiteVersion'),
    getForActor: bindRequired(store, 'getSiteForUser'),
  };
  if (typeof store?.findSiteBySlug === 'function') port.findBySlug = store.findSiteBySlug.bind(store);
  return port;
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') {
    throw new TypeError(`rollback site resolution port method is required: ${name}`);
  }
  return target[name].bind(target);
}
