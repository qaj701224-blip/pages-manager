const DEFAULT_CLI_ACCESS_KEY_TTL_SECONDS = 31_536_000;

export function readConnectionAuthConfig(env = {}) {
  const audience = typeof env.CINDY_CONNECTION_AUDIENCE === 'string' ? env.CINDY_CONNECTION_AUDIENCE.trim() : '';
  const audienceMatch = audience.match(/^([a-z0-9][a-z0-9-]{0,30}):([a-z0-9][a-z0-9-]{0,30})$/);
  if (!audienceMatch || audience.length > 64) return null;

  const issuers = String(env.CINDY_CONNECTION_ISSUERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (issuers.length === 0) return null;
  for (const issuer of issuers) {
    let url;
    try {
      url = new URL(issuer);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.origin !== issuer) return null;
  }

  return { audience, orgSlug: audienceMatch[1], issuers };
}

export function readCliAccessKeyTtlSeconds(env = {}) {
  const configured = env.CLI_ACCESS_KEY_TTL_SECONDS;
  const raw = typeof configured === 'string' ? configured.trim() : configured;
  if (raw === undefined || raw === '') return DEFAULT_CLI_ACCESS_KEY_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_CLI_ACCESS_KEY_TTL_SECONDS;
  return parsed;
}

export function readAccessKeyPepper(env = {}, pepperId) {
  const registry = String(env.ACCESS_KEY_PEPPERS || '').trim();
  if (!registry) throw new Error('Access key pepper registry is required');

  for (const entry of registry.split(',')) {
    const [entryPepperId, secretEnvName] = entry.split(':').map((part) => part.trim());
    if (entryPepperId === pepperId) return readPepperSecret(env, secretEnvName);
  }
  throw new Error('Access key pepper is unknown');
}

export function readActiveAccessKeyPepper(env = {}) {
  const activePepperId = String(env.ACCESS_KEY_ACTIVE_PEPPER_ID || '').trim();
  if (!activePepperId) throw new Error('ACCESS_KEY_ACTIVE_PEPPER_ID is required');

  const registry = String(env.ACCESS_KEY_PEPPERS || '').trim();
  for (const entry of registry.split(',')) {
    const [pepperId, secretEnvName] = entry.split(':').map((part) => part.trim());
    if (pepperId === activePepperId) return { id: pepperId, secret: readPepperSecret(env, secretEnvName) };
  }
  throw new Error('Active access key pepper is not present in registry');
}

function readPepperSecret(env, secretEnvName) {
  const secret = env[secretEnvName];
  if (typeof secret !== 'string' || secret === '') throw new Error('Access key pepper secret is invalid');
  return secret;
}
