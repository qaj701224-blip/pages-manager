import { accessModeFromVisibility } from '@xd/pages-access-policy';

const PROTECTED_ACCESS_MODES = new Set(['org', 'acl', 'owner']);

export function evaluateAccessPolicy(route, identity) {
  const accessMode = Object.hasOwn(route || {}, 'accessMode')
    ? route.accessMode
    : accessModeFromVisibility(route?.visibility);
  if (accessMode === 'disabled') return denied('SITE_DISABLED', 403);
  if (accessMode === 'anonymous') return { ok: true, user: null };
  if (!PROTECTED_ACCESS_MODES.has(accessMode)) return denied('SITE_POLICY_INVALID', 403);

  if (!identity) return denied('SITE_SESSION_REQUIRED', 302);
  if (identity.siteId !== route.siteId) return denied('SITE_SESSION_STALE', 302);
  if (identity.policyVersion !== route.policyVersion) return denied('SITE_SESSION_STALE', 302);
  if (route.requiredSessionVersion && identity.sessionVersion < route.requiredSessionVersion) {
    return denied('SITE_SESSION_STALE', 302);
  }

  if (identity.employeeStatus !== 'active') return denied('SITE_ACCESS_FORBIDDEN', 403);
  if (identity.userId === route.ownerUserId) return { ok: true, user: identity };
  if (accessMode === 'org') return { ok: true, user: identity };
  if (accessMode === 'owner') return denied('SITE_ACCESS_FORBIDDEN', 403);

  return aclAllows(route.acl, identity) ? { ok: true, user: identity } : denied('SITE_ACCESS_FORBIDDEN', 403);
}

function aclAllows(entries = [], identity) {
  return entries.some((entry) => {
    if (!entry || entry.effect !== 'allow') return false;
    if (entry.subjectType === 'email') return emailAclAllows(entry.subjectValue, identity.email);
    if (entry.subjectType === 'department') return departmentAclAllows(entry.subjectValue, identity.departments);
    return false;
  });
}

function emailAclAllows(subjectValue, identityEmail) {
  const aclEmail = normalizeEmail(subjectValue);
  const email = normalizeEmail(identityEmail);
  return Boolean(aclEmail && email && aclEmail === email);
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function departmentAclAllows(subjectValue, identityDepartments = []) {
  const aclPath = normalizeDepartmentPath(subjectValue);
  if (!aclPath) return false;
  return identityDepartments.some((department) => {
    const userPath = normalizeDepartmentPath(department);
    return userPath === aclPath || userPath.startsWith(`${aclPath}/`);
  });
}

function normalizeDepartmentPath(value) {
  return String(value || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

function denied(code, status) {
  return { ok: false, code, status };
}
