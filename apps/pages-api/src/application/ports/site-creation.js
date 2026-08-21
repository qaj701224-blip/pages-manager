export function createSiteCreationPort(store) {
  return {
    createSite: bindRequired(store, 'createSite'),
    getRouteBySiteId: bindRequired(store, 'getRouteBySiteId'),
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') throw new TypeError(`site creation port method is required: ${name}`);
  return target[name].bind(target);
}
