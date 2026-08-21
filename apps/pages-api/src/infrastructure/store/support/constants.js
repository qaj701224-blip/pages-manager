export const RUNTIME_CONFIG_LOCK_LEASE_MS = 60 * 1000;

export const RUNTIME_CONFIG_LOCK_RENEW_MS = 20 * 1000;

export const RUNTIME_CONFIG_PROVIDER_TIMEOUT_MS = 15 * 1000;

export const SITE_COMMIT_LOCK_LEASE_MS = 60 * 1000;

export const SITE_COMMIT_LOCK_RENEW_MS = 20 * 1000;

export const SITE_COMMIT_TIMEOUT_MS = 45 * 1000;

export const ADMIN_EXPOSURE_EVENT_TYPE = 'admin.site.exposure';

export const ADMIN_EXPOSURE_TERMINAL_FAILURE_STAGES = new Set(['failed', 'compensated_failure', 'compensation_failed']);
