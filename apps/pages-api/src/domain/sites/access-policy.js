export const SITE_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
export const MAX_SITE_ACL_ENTRIES = 200;

const ACL_SUBJECT_TYPES = new Set(['email', 'department']);
const ACL_ACCESS_ROLES = new Set(['viewer']);

export function isSiteVisibility(value) {
  return SITE_VISIBILITIES.has(value);
}

export function teamOwnerSupportsVisibility(site, visibility) {
  return site?.ownerType !== 'team' || visibility !== 'owner';
}

export function normalizeSiteAclEntries(value, { createId }) {
  if (!Array.isArray(value) || value.length > MAX_SITE_ACL_ENTRIES) {
    throw domainError('ACL_ENTRIES_INVALID', 'input_limit');
  }
  if (typeof createId !== 'function') throw new TypeError('createId is required');

  const deduped = new Map();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw domainError('ACL_ENTRY_INVALID');
    }

    const effect = entry.effect || 'allow';
    if (effect !== 'allow') throw domainError('ACL_EFFECT_UNSUPPORTED');

    const accessRole = entry.accessRole || 'viewer';
    if (!ACL_ACCESS_ROLES.has(accessRole)) throw domainError('ACL_ROLE_UNSUPPORTED');

    const subjectType = String(entry.subjectType || '')
      .trim()
      .toLowerCase();
    if (!ACL_SUBJECT_TYPES.has(subjectType)) throw domainError('ACL_SUBJECT_TYPE_UNSUPPORTED');

    const subjectValue = normalizeAclSubjectValue(subjectType, entry.subjectValue);
    if (!subjectValue) throw domainError('ACL_SUBJECT_VALUE_INVALID');

    const key = siteAclEntryKey({ effect, subjectType, subjectValue, accessRole });
    if (!deduped.has(key)) {
      deduped.set(key, {
        id: createId(),
        subjectType,
        subjectValue,
        accessRole,
        effect,
      });
    }
  }

  return [...deduped.values()];
}

export function mergeSiteAclEntries(existing, incoming) {
  const entries = new Map(existing.map((entry) => [siteAclEntryKey(entry), entry]));
  for (const entry of incoming) {
    const key = siteAclEntryKey(entry);
    if (!entries.has(key)) entries.set(key, entry);
  }
  if (entries.size > MAX_SITE_ACL_ENTRIES) throw domainError('ACL_ENTRIES_INVALID', 'merged_limit');
  return [...entries.values()];
}

export function removeSiteAclEntries(existing, removed) {
  const removedKeys = new Set(removed.map(siteAclEntryKey));
  return existing.filter((entry) => !removedKeys.has(siteAclEntryKey(entry)));
}

export function siteAclEntryKey(entry) {
  return `${entry.effect || 'allow'}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole || 'viewer'}`;
}

export function sitePolicyExpected(route) {
  return {
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    activeVersionId: route.activeVersionId,
    runtimeConfigGeneration: route.runtimeConfigGeneration,
  };
}

export function previousRouteExposure(route) {
  return route?.exposure === 'public' ? 'public' : 'internal';
}

export function sitePolicyRouteCanBeCompensated(current, committed) {
  if (!current || !committed) return false;
  return (
    current.id === committed.id &&
    current.environment === committed.environment &&
    current.siteId === committed.siteId &&
    current.exposure === committed.exposure &&
    current.accessMode === committed.accessMode &&
    current.visibility === committed.visibility &&
    current.policyVersion === committed.policyVersion &&
    current.routeGeneration === committed.routeGeneration &&
    current.activeVersionId === committed.activeVersionId &&
    current.routeStatus === committed.routeStatus
  );
}

function normalizeAclSubjectValue(subjectType, value) {
  const normalized = String(value || '').trim();
  if (subjectType === 'email') {
    const email = normalized.toLowerCase();
    return isValidEmailAclSubject(email) ? email : '';
  }
  if (subjectType === 'department') return normalizeDepartmentPath(normalized);
  return '';
}

function isValidEmailAclSubject(value) {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

function normalizeDepartmentPath(value) {
  if (!value || hasControlCharacter(value)) return '';
  const parts = value
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const path = parts.join('/');
  if (path.length > 256 || parts.some((part) => part.length > 80)) return '';
  return path;
}

function hasControlCharacter(value) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function domainError(code, reason) {
  const error = new Error(code);
  error.code = code;
  if (reason) error.reason = reason;
  return error;
}
