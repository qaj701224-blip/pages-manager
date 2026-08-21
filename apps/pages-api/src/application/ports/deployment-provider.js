export function createDeploymentProviderPort(createProvider) {
  if (typeof createProvider !== 'function') throw new TypeError('createProvider is required');
  return {
    create(site) {
      return narrowProvider(createProvider(site));
    },
  };
}

function narrowProvider(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  return {
    executionProvider: provider.executionProvider,
    upload: bindOptional(provider, 'upload'),
    verify: bindOptional(provider, 'verify'),
    delete: bindOptional(provider, 'delete'),
    cleanupRetainedSlot: bindOptional(provider, 'cleanupRetainedSlot'),
    removeOfficeNetBinding: bindOptional(provider, 'removeOfficeNetBinding'),
    verifyOfficeNetAbsent: bindOptional(provider, 'verifyOfficeNetAbsent'),
  };
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}
