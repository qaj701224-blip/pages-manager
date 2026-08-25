export function createRuntimeConfigReads({ repository }) {
  if (!repository || typeof repository !== 'object') throw new TypeError('runtime config repository is required');

  return {
    listVars: (query) => list(repository, 'listVars', query),
    listSecretMetadata: (query) => list(repository, 'listSecretMetadata', query),
  };
}

async function list(repository, method, query) {
  requireMethod(repository, method);
  return repository[method](query.environment, query.siteId);
}

function requireMethod(target, name) {
  if (typeof target[name] === 'function') return;
  throw new Error('RUNTIME_CONFIG_UNSUPPORTED');
}
