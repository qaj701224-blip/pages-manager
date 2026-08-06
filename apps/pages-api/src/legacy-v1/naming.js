const V1_WORKER_PREFIXES = new Map([
  ['production', 'pages-'],
  ['staging', 'pages-staging-'],
]);
const PROTECTED_SCRIPT_NAMES = new Set([
  'pages-api',
  'pages-api-staging',
  'pages-auth',
  'pages-auth-staging',
  'pages-manager',
  'pages-manager-staging',
  'pages-kv-gateway',
  'pages-kv-gateway-staging',
  'pages-router',
  'pages-router-staging',
]);
const PROTECTED_SCRIPT_PREFIXES = ['pages-v2-production-slot-', 'pages-v2-staging-slot-'];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function legacyHostnameForSlug(environment, slug) {
  if (!V1_WORKER_PREFIXES.has(environment) || !isValidSlug(slug)) return null;
  const label = environment === 'staging' ? `${slug}-staging` : slug;
  return `${label}.workers.xd.team`;
}

export function legacyScriptNameForSlug(environment, slug) {
  const prefix = V1_WORKER_PREFIXES.get(environment);
  return prefix && isValidSlug(slug) ? `${prefix}${slug}` : null;
}

export function isSafeLegacyV1SiteScriptName(environment, slug, scriptName) {
  const expectedScriptName = legacyScriptNameForSlug(environment, slug);
  return (
    typeof scriptName === 'string' &&
    scriptName === expectedScriptName &&
    !scriptName.includes('/') &&
    !PROTECTED_SCRIPT_NAMES.has(scriptName) &&
    !PROTECTED_SCRIPT_PREFIXES.some((protectedPrefix) => scriptName.startsWith(protectedPrefix))
  );
}

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}
