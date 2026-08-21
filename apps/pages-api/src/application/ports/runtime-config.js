export function createRuntimeConfigMutationPort(store) {
  return {
    mutateSiteVar: bindOptional(store, 'mutateSiteVar'),
    putSiteSecretWithAudit: bindOptional(store, 'putSiteSecretWithAudit'),
    deleteSiteSecretWithAudit: bindOptional(store, 'deleteSiteSecretWithAudit'),
  };
}

export function createDeploymentRuntimeConfigResolutionPort(store, { hashInput } = {}) {
  if (typeof hashInput !== 'function') throw new TypeError('runtime config hashInput is required');
  return {
    listVars: bindOptional(store, 'listEnabledSiteVars'),
    listSecrets: bindOptional(store, 'listEnabledSiteSecrets'),
    hashInput,
  };
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}
