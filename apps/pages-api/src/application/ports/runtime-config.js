export function createRuntimeConfigMutationPort(store) {
  return {
    mutateSiteVar: bindOptional(store, 'mutateSiteVar'),
    putSiteSecretWithAudit: bindOptional(store, 'putSiteSecretWithAudit'),
    deleteSiteSecretWithAudit: bindOptional(store, 'deleteSiteSecretWithAudit'),
  };
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}
