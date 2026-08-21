export function createDeploymentVersionsPort(store) {
  return {
    create: bindOptional(store, 'createSiteVersion'),
  };
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}
