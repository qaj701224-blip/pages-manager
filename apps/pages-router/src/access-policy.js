const PROTECTED_VISIBILITIES = new Set(['org', 'acl', 'owner']);

export function evaluateAccessPolicy(route, identity) {
  const visibility = route?.visibility;
  if (visibility === 'disabled') return denied('SITE_DISABLED', 403);
  if (visibility === 'public') return { ok: true, user: identity || null };
  if (!PROTECTED_VISIBILITIES.has(visibility)) return denied('SITE_POLICY_INVALID', 403);

  if (!identity) return denied('SITE_SESSION_REQUIRED', 302);
  if (identity.siteId !== route.siteId) return denied('SITE_SESSION_STALE', 302);
  if (identity.policyVersion !== route.policyVersion) return denied('SITE_SESSION_STALE', 302);
  if (route.requiredSessionVersion && identity.sessionVersion < route.requiredSessionVersion) {
    return denied('SITE_SESSION_STALE', 302);
  }

  if (identity.employeeStatus !== 'active') return denied('SITE_ACCESS_FORBIDDEN', 403);
  if (visibility === 'org') return { ok: true, user: identity };
  if (visibility === 'owner') {
    return identity.userId === route.ownerUserId ? { ok: true, user: identity } : denied('SITE_ACCESS_FORBIDDEN', 403);
  }

  return aclAllows(route.acl, identity) ? { ok: true, user: identity } : denied('SITE_ACCESS_FORBIDDEN', 403);
}

function aclAllows(entries = [], identity) {
  return entries.some((entry) => {
    if (!entry || entry.effect !== 'allow') return false;
    if (entry.subjectType === 'user') return entry.subjectValue === identity.userId;
    if (entry.subjectType === 'email') return normalizeEmail(entry.subjectValue) === normalizeEmail(identity.email);
    if (entry.subjectType === 'department') return identity.departments?.includes(entry.subjectValue);
    return false;
  });
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function denied(code, status) {
  return { ok: false, code, status };
}
