export function readRuntimeConfigHashPepper(env = {}) {
  const explicit = env.RUNTIME_CONFIG_HASH_PEPPER;
  if (typeof explicit === 'string' && explicit) return explicit;

  const activePepperId = String(env.ACCESS_KEY_ACTIVE_PEPPER_ID || '').trim();
  if (activePepperId) {
    const activePepper = findPepperSecret(env, activePepperId);
    if (activePepper) return activePepper;
  }

  const requestHashPepper = env.REQUEST_HASH_PEPPER;
  if (typeof requestHashPepper === 'string' && requestHashPepper) return requestHashPepper;

  if (!activePepperId) {
    const firstPepper = findPepperSecret(env);
    if (firstPepper) return firstPepper;
  }
  throw new Error('RUNTIME_CONFIG_HASH_PEPPER_REQUIRED');
}

export function readSiteSecretStoreConfig(env = {}) {
  return {
    secretEncryptionKey: env.SITE_SECRET_ENCRYPTION_KEY || env.PAGES_SECRET_ENCRYPTION_KEY,
  };
}

function findPepperSecret(env, expectedPepperId) {
  const registry = String(env.ACCESS_KEY_PEPPERS || '').trim();
  for (const entry of registry.split(',')) {
    const [pepperId, secretEnvName] = entry.split(':').map((part) => part.trim());
    if ((expectedPepperId && pepperId !== expectedPepperId) || !secretEnvName) continue;
    const value = env[secretEnvName];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}
