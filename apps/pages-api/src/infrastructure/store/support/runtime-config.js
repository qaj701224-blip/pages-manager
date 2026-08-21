import { RUNTIME_CONFIG_LOCK_LEASE_MS } from './constants.js';

export function runtimeConfigLockExpiry(updatedAt) {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) throw new Error('RUNTIME_CONFIG_LOCK_TIME_INVALID');
  return new Date(timestamp + RUNTIME_CONFIG_LOCK_LEASE_MS).toISOString();
}
