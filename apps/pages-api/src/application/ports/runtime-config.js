export function createRuntimeConfigMutationPort(store) {
  return {
    mutateSiteVar: bindOptional(store, 'mutateSiteVar'),
    putSiteSecretWithAudit: bindOptional(store, 'putSiteSecretWithAudit'),
    deleteSiteSecretWithAudit: bindOptional(store, 'deleteSiteSecretWithAudit'),
  };
}

export function createRuntimeConfigReadPort(store) {
  return {
    listVars: bindOptional(store, 'listEnabledSiteVars'),
    listSecretMetadata: bindOptional(store, 'listEnabledSiteSecretMetadata'),
  };
}

export function createDeploymentRuntimeConfigResolutionPort(store, { hashInput } = {}) {
  if (typeof hashInput !== 'function') throw new TypeError('runtime config hashInput is required');
  return {
    ...createDeploymentRuntimeConfigSnapshotPort(store),
    hashInput,
  };
}

export function createDeploymentRuntimeConfigSnapshotPort(store) {
  return {
    listVars: bindOptional(store, 'listEnabledSiteVars'),
    listSecrets: bindOptional(store, 'listEnabledSiteSecrets'),
  };
}

export function createDeploymentRuntimeConfigMutationPort(store) {
  return {
    ...createDeploymentRuntimeConfigSnapshotPort(store),
    replaceVars: bindOptional(store, 'replaceSiteVars'),
  };
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}
