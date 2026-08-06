const LEGACY_TOKEN_PREFIX = 'pages_';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const V1_WORKER_PREFIXES = new Map([
  ['production', 'pages-'],
  ['staging', 'pages-staging-'],
]);

export async function resolveLegacyV1SiteTarget({ sites, actor, claim, environment, slug, hostname }) {
  if (!isActiveV1Claim(claim, { environment, slug, hostname })) {
    throw takeoverConflictError();
  }

  const actorEmail = normalizeEmail(actor?.email);
  if (!actorEmail) throw takeoverConflictError();

  const site = await sites?.get?.(slug, 'json');
  if (!site || typeof site !== 'object' || Array.isArray(site)) throw takeoverConflictError();
  if (site.name !== undefined && site.name !== slug) throw takeoverConflictError();

  const siteHostname = hostnameFromSite(site);
  if (site.url !== undefined && siteHostname !== hostname) throw takeoverConflictError();
  if (legacyHostnameForSlug(environment, slug) !== hostname) throw takeoverConflictError();

  const scriptName = normalizeScriptName(site.scriptName);
  if (!isLegacyV1ScriptName(scriptName, environment)) throw takeoverConflictError();
  if (claim.ownerRef && claim.ownerRef !== scriptName) throw takeoverConflictError();

  const tokenEmail = legacyTokenEmail(site.token);
  if (!tokenEmail || tokenEmail !== actorEmail) throw takeoverConflictError();

  return {
    environment,
    slug,
    hostname,
    routePattern: `${hostname}/*`,
    scriptName,
    claimOwnerId: claim.ownerId,
    claimOwnerRef: claim.ownerRef || null,
  };
}

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EMAIL_RE.test(email) ? email : null;
}

export function legacyTokenEmail(value) {
  if (typeof value !== 'string' || !value.startsWith(LEGACY_TOKEN_PREFIX)) return null;
  return normalizeEmail(value.slice(LEGACY_TOKEN_PREFIX.length));
}

export function isActiveV1Claim(claim, { environment, slug, hostname }) {
  return Boolean(
    claim &&
      claim.ownerSystem === 'v1' &&
      claim.status === 'active' &&
      claim.environment === environment &&
      claim.normalizedSlug === slug &&
      claim.hostname === hostname &&
      claim.hostnameFamily === 'workers' &&
      claim.ownerId
  );
}

function normalizeScriptName(value) {
  if (typeof value !== 'string') return null;
  const scriptName = value.trim();
  if (!scriptName || scriptName.includes('/') || scriptName.includes('\\')) return null;
  return scriptName;
}

function isLegacyV1ScriptName(scriptName, environment) {
  const workerPrefix = V1_WORKER_PREFIXES.get(environment);
  if (!workerPrefix || !scriptName || !scriptName.startsWith(workerPrefix)) return false;
  return environment !== 'production' || !scriptName.startsWith('pages-staging-');
}

function legacyHostnameForSlug(environment, slug) {
  if (!V1_WORKER_PREFIXES.has(environment) || typeof slug !== 'string' || !slug) return null;
  const label = environment === 'staging' ? `${slug}-staging` : slug;
  return `${label}.workers.xd.team`;
}

function hostnameFromSite(site) {
  if (typeof site.url !== 'string' || !site.url) return null;
  try {
    const url = new URL(site.url);
    return url.hostname.endsWith('.workers.xd.team') ? url.hostname : null;
  } catch {
    return null;
  }
}

function takeoverConflictError() {
  const error = new Error('HOSTNAME_CLAIM_CONFLICT');
  error.code = 'HOSTNAME_CLAIM_CONFLICT';
  return error;
}
