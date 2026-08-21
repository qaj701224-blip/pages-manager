import { isValidAccessMode, normalizeExposure } from '@xd/pages-access-policy';
import { randomStoreId } from './common.js';
import { SITE_COMMIT_LOCK_LEASE_MS } from './constants.js';

export function siteAclEntryKey(entry) {
  return `${entry.effect}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole}`;
}

export function resolveNextExposure(currentExposure, input) {
  if (!Object.hasOwn(input, 'exposure')) return normalizeExposure(currentExposure);
  if (input.exposure !== 'internal' && input.exposure !== 'public') {
    throw sitePolicyError('SITE_EXPOSURE_INVALID');
  }
  return input.exposure;
}

export function resolveNextAccessMode(currentAccessMode, input) {
  const value = Object.hasOwn(input, 'accessMode') ? input.accessMode : currentAccessMode;
  if (!isValidAccessMode(value)) throw sitePolicyError('SITE_POLICY_INVALID');
  return value;
}

export function normalizeSitePolicyExpected(expected) {
  if (!expected || !Number.isInteger(expected.policyVersion) || !Number.isInteger(expected.routeGeneration)) {
    throw sitePolicyError('SITE_POLICY_CONFLICT');
  }
  return {
    policyVersion: expected.policyVersion,
    routeGeneration: expected.routeGeneration,
    activeVersionId: expected.activeVersionId || null,
    runtimeConfigGeneration: Number(expected.runtimeConfigGeneration || 0),
  };
}

export function assertSitePolicyExpected(route, expectedInput) {
  const expected = normalizeSitePolicyExpected(expectedInput);
  if (
    route.policyVersion !== expected.policyVersion ||
    route.routeGeneration !== expected.routeGeneration ||
    (route.activeVersionId || null) !== expected.activeVersionId ||
    Number(route.runtimeConfigGeneration || 0) !== expected.runtimeConfigGeneration
  ) {
    throw sitePolicyError('SITE_POLICY_CONFLICT');
  }
  return expected;
}

export function normalizeSitePolicyLease(lease) {
  if (!lease?.lockId || !Number.isInteger(lease.fencingToken) || lease.fencingToken < 1) {
    throw sitePolicyError('SITE_POLICY_CONFLICT');
  }
  return { lockId: lease.lockId, fencingToken: lease.fencingToken };
}

export function normalizeSitePolicyAclEntries(entries, siteId, actorUserId, createdAt) {
  if (!Array.isArray(entries)) throw sitePolicyError('SITE_POLICY_INVALID');
  const byKey = new Map();
  for (const entry of entries) {
    if (!entry?.subjectType || !entry?.subjectValue || !entry?.accessRole || !entry?.effect) {
      throw sitePolicyError('SITE_POLICY_INVALID');
    }
    const normalized = {
      id: entry.id || randomStoreId('acl'),
      siteId,
      subjectType: entry.subjectType,
      subjectValue: entry.subjectValue,
      accessRole: entry.accessRole,
      effect: entry.effect,
      createdBy: entry.createdBy || actorUserId,
      createdAt: entry.createdAt || createdAt,
    };
    byKey.set(siteAclEntryKey(normalized), normalized);
  }
  return [...byKey.values()];
}

export function sitePolicyAclEntriesEqual(left, right) {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(siteAclEntryKey).sort();
  const rightKeys = right.map(siteAclEntryKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

export function sitePolicyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function siteCommitLockExpiry(updatedAt, leaseMs = SITE_COMMIT_LOCK_LEASE_MS) {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) throw sitePolicyError('SITE_POLICY_LOCK_TIME_INVALID');
  const duration = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : SITE_COMMIT_LOCK_LEASE_MS;
  return new Date(timestamp + duration).toISOString();
}
