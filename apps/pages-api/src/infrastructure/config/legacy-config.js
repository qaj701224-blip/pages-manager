export function readLegacyCloudflareConfig(env = {}) {
  const apiToken = String(env.CF_API_TOKEN || '').trim();
  const accountId = String(env.CF_ACCOUNT_ID || '').trim();
  const zoneId = String(env.CF_ZONE_ID_NEW || '').trim();
  const fetchImpl = env.fetch || globalThis.fetch;
  if (!apiToken || !accountId || !zoneId || typeof fetchImpl !== 'function') return null;
  return { apiToken, accountId, zoneId, fetchImpl };
}
