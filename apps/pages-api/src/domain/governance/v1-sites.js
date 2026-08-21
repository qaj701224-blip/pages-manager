const V1_WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function expectedV1WorkerName(siteName, environment) {
  return environment === 'staging' ? `pages-staging-${siteName}` : `pages-${siteName}`;
}

export function isManagedV1WorkerName(workerName, environment) {
  if (typeof workerName !== 'string' || workerName.startsWith('pages-v2-')) return false;
  if (environment === 'staging') return workerName.startsWith('pages-staging-');
  return workerName.startsWith('pages-') && !workerName.startsWith('pages-staging-');
}

export function isValidV1SiteScriptName(siteName, scriptName, environment) {
  return V1_WORKER_NAME_RE.test(scriptName || '') && scriptName === expectedV1WorkerName(siteName, environment);
}

export function readV1SiteRecord(site) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) return null;
  const metadata = isPlainObject(site.metadata) ? site.metadata : {};
  const name = nullableString(site.name);
  const scriptName = nullableString(metadata.scriptName);
  const url = nullableString(metadata.url);
  if (!name) return null;
  return { name, metadata, scriptName, url };
}

export function readV1Hostname(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith('.workers.xd.team')) return null;
    const label = hostname.slice(0, -'.workers.xd.team'.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
    return hostname;
  } catch {
    return null;
  }
}

export function v1HostnameClaimMatches(claim, { environment, siteName, workerName }) {
  return (
    claim.environment === environment &&
    claim.ownerSystem === 'v1' &&
    claim.ownerId === `v1:${environment}:${siteName}` &&
    (!claim.ownerRef || claim.ownerRef === workerName)
  );
}

function nullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
