export const INTERNAL_GATEWAY_ORIGIN = 'https://pages-kv-gateway.local';

export const KV_CAPABILITY_HEADER = 'CF-Platform-KV-Capability';
export const DATA_SITE_CAPABILITY_HEADER = 'CF-Platform-Data-Site-Capability';
export const PLATFORM_AUTH_HEADER = 'CF-Platform-Auth';
export const PLATFORM_USER_HEADER = 'CF-Platform-User';
export const PLATFORM_SITE_ID_HEADER = 'CF-Platform-Site-Id';
export const PLATFORM_SITE_SLUG_HEADER = 'CF-Platform-Site-Slug';
export const PLATFORM_VERSION_HEADER = 'CF-Platform-Version';
export const PLATFORM_TRACE_ID_HEADER = 'CF-Platform-Trace-Id';

export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
export const SITE_UUID_RE = /^[0-9a-f]{32}$/;
