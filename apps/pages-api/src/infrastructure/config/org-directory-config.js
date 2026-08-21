export function readOrgDirectoryConfig(env = {}) {
  const token = typeof env.XDS_OPENAI_TOKEN === 'string' ? env.XDS_OPENAI_TOKEN.trim() : '';
  if (!token) return null;

  const fetchImpl = resolveOrgDirectoryFetch(env);
  if (!fetchImpl) return null;
  return { token, fetchImpl };
}

function resolveOrgDirectoryFetch(env) {
  if (typeof env.XDS_FETCH === 'function') return env.XDS_FETCH;
  if (env.XD_OFFICE_NET && typeof env.XD_OFFICE_NET.fetch === 'function') {
    return env.XD_OFFICE_NET.fetch.bind(env.XD_OFFICE_NET);
  }
  return null;
}
