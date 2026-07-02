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
