const V1_WORKER_PREFIXES = new Map([
  ['production', 'pages-'],
  ['staging', 'pages-staging-'],
]);
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

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}
