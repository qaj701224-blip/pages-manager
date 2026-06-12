export const SITE_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$';
export const SITE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

export const RESERVED_SITE_NAMES = Object.freeze([
  'api',
  'api-staging',
  'kv-gateway',
  'kv-gateway-staging',
  'manager',
  'manager-staging',
]);

const RESERVED_SITE_NAME_SET = new Set(RESERVED_SITE_NAMES);

export function isReservedSiteName(name) {
  return RESERVED_SITE_NAME_SET.has(name);
}
