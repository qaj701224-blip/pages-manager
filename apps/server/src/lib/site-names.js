export const SITE_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$';
export const SITE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

export const RESERVED_SITE_NAMES = Object.freeze([
  'api',
  'api-staging',
  'auth',
  'auth-staging',
  'kv-gateway',
  'kv-gateway-staging',
  'manager',
  'manager-staging',
  'router',
  'router-staging',
  'v2-production-slot-*',
  'v2-staging-slot-*',
]);

const RESERVED_SITE_NAME_SET = new Set(RESERVED_SITE_NAMES);
const RESERVED_SITE_NAME_PREFIXES = Object.freeze(['v2-production-slot-', 'v2-staging-slot-']);

export function isReservedSiteName(name) {
  return RESERVED_SITE_NAME_SET.has(name) || RESERVED_SITE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}
