export function getSiteCapabilities(site) {
  const permissions = site?.permissions || {};
  const canEditAccess = Boolean(permissions.canManageAccess);
  const canEditVars = Boolean(permissions.canManage || canEditAccess);
  return {
    role: permissions.role || 'viewer',
    canEditVars,
    canEditAccess,
    canEditSecrets: canEditAccess,
  };
}

export function formatSiteActionError(error) {
  const code = String(error?.code || '');
  if (code === 'SITE_PUBLISHER_REQUIRED') return '当前账号没有发布权限，需要站点归属用户或团队 publisher/admin 操作。';
  if (code === 'SITE_ADMIN_REQUIRED') return '当前账号没有管理员权限，需要站点归属用户或团队 admin 操作。';
  if (code === 'SITE_NOT_FOUND') return '当前账号无权访问该站点，或站点已经不存在。';
  if (code === 'SITE_EXPOSURE_AUDIT_FAILED') return '公网访问已经生效，但最终审计记录未确认，请刷新站点状态并核对审计日志。';
  if (error?.message && error?.action) return `${error.message} ${error.action}`;
  return error?.message || code || '操作失败，请稍后重试。';
}

export function siteAccessEffectLabel({ exposure, accessMode, visibility } = {}) {
  const normalizedExposure = exposure === 'public' ? 'public' : 'internal';
  const normalizedAccessMode = accessMode || (visibility === 'internal' ? 'anonymous' : visibility);
  const labels = {
    anonymous: normalizedExposure === 'public' ? '互联网匿名访问' : '公司网络内免登录访问',
    org: normalizedExposure === 'public' ? '公网可达，需企业成员登录' : '公司网络内需企业成员登录',
    acl: normalizedExposure === 'public' ? '公网可达，需通过 ACL' : '公司网络内需通过 ACL',
    owner: normalizedExposure === 'public' ? '公网可达，仅归属方登录' : '公司网络内仅归属方登录',
    disabled: '站点已停用',
  };
  return labels[normalizedAccessMode] || '访问策略无效';
}

const ACL_SUBJECT_TYPES = new Set(['email', 'department']);

export function parseAclEntriesInput(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) throw new Error('ACL_JSON_INVALID');
    return parsed;
  } catch {
    const error = new Error('ACL JSON must be an array.');
    error.code = 'ACL_JSON_INVALID';
    throw error;
  }
}

export function normalizeAclEntriesForForm(entries = []) {
  if (!Array.isArray(entries)) return [];
  const deduped = new Map();
  for (const entry of entries) {
    try {
      const normalized = normalizeAclEntryInput(entry);
      const key = aclEntryKey(normalized);
      if (!deduped.has(key)) deduped.set(key, { ...entry, ...normalized });
    } catch {
      // API-provided entries should already be valid. Ignore malformed local rows
      // so the form can still render and let the user save a clean policy.
    }
  }
  return [...deduped.values()];
}

export function normalizeAclEntryInput(entry = {}) {
  const subjectType = String(entry.subjectType || '')
    .trim()
    .toLowerCase();
  if (!ACL_SUBJECT_TYPES.has(subjectType)) {
    const error = new Error('ACL subject type must be email or department.');
    error.code = 'ACL_SUBJECT_TYPE_UNSUPPORTED';
    throw error;
  }

  const subjectValue =
    subjectType === 'email' ? normalizeEmailSubject(entry.subjectValue) : normalizeDepartmentSubject(entry.subjectValue);
  if (!subjectValue) {
    const error = new Error('ACL subject value is invalid.');
    error.code = 'ACL_SUBJECT_VALUE_INVALID';
    throw error;
  }

  return {
    subjectType,
    subjectValue,
    accessRole: 'viewer',
    effect: 'allow',
  };
}

export function appendAclEntry(entries, draft) {
  const normalizedEntries = normalizeAclEntriesForForm(entries);
  const next = normalizeAclEntryInput(draft);
  const nextKey = aclEntryKey(next);
  if (normalizedEntries.some((entry) => aclEntryKey(entry) === nextKey)) return normalizedEntries;
  return [...normalizedEntries, next];
}

export function removeAclEntryAt(entries, index) {
  return normalizeAclEntriesForForm(entries).filter((_, entryIndex) => entryIndex !== index);
}

export function toAclUpdatePayload(entries) {
  return normalizeAclEntriesForForm(entries).map(({ subjectType, subjectValue, accessRole, effect }) => ({
    subjectType,
    subjectValue,
    accessRole,
    effect,
  }));
}

export function aclSubjectTypeLabel(subjectType) {
  if (subjectType === 'email') return '邮箱';
  if (subjectType === 'department') return '部门';
  return subjectType || '对象';
}

export function aclSubjectPlaceholder(subjectType) {
  if (subjectType === 'department') return '心动/平台支撑部/Web';
  return 'name@xd.com';
}

function normalizeEmailSubject(value) {
  const email = String(value || '')
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : '';
}

function normalizeDepartmentSubject(value) {
  if (hasControlCharacter(value)) return '';
  return String(value || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

function hasControlCharacter(value) {
  return [...String(value || '')].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function aclEntryKey(entry) {
  return `${entry.effect || 'allow'}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole || 'viewer'}`;
}
