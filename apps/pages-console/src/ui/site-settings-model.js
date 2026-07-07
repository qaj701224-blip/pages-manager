export function buildSiteOwnerSettingsForm(site = {}) {
  const owner = site.owner || {};
  return {
    ownerType: owner.type === 'team' ? 'team' : 'user',
    ownerId: owner.id || '',
    query: '',
  };
}

export function normalizeSiteOwnerSettingsPayload(form = {}) {
  const ownerType = form.ownerType === 'team' ? 'team' : 'user';
  const ownerId = String(form.ownerId || '').trim();
  if (!ownerId) {
    const error = new Error(ownerType === 'team' ? '请选择团队。' : '请选择用户。');
    error.code = ownerType === 'team' ? 'TEAM_REQUIRED' : 'USER_REQUIRED';
    throw error;
  }
  if (ownerType === 'team') return { ownerType, teamId: ownerId };
  return { ownerType, ownerId };
}

export function filterSiteOwnerCandidates(candidates = [], query = '', ownerType = 'user') {
  const normalizedQuery = String(query || '')
    .trim()
    .toLowerCase();
  return candidates.filter((candidate) => {
    if (ownerType === 'team' && candidate.currentUserRole && !['publisher', 'admin'].includes(candidate.currentUserRole))
      return false;
    if (ownerType !== 'team' && candidate.employeeStatus === 'inactive') return false;
    if (!normalizedQuery) return true;
    return siteOwnerCandidateSearchText(candidate, ownerType).includes(normalizedQuery);
  });
}

export function siteOwnerCandidateLabel(candidate = {}, ownerType = 'user') {
  if (ownerType === 'team') return candidate.name || candidate.departmentPath || candidate.id || '团队';
  return candidate.realname || candidate.email || candidate.account || candidate.id || '用户';
}

export function siteOwnerCandidateMeta(candidate = {}, ownerType = 'user') {
  if (ownerType === 'team') return candidate.departmentPath || candidate.id || '';
  return candidate.email || candidate.departmentPath || '';
}

export function getSiteSettingsErrorMessage(error) {
  if (!error) return '';
  if (error.code === 'USER_REQUIRED') return '请选择用户。';
  if (error.code === 'TEAM_REQUIRED') return '请选择团队。';
  if (error.code === 'SITE_PUBLISHER_REQUIRED') return '需要站点 publisher 或 admin 权限。';
  if (error.code === 'SITE_TRANSFER_FORBIDDEN') return error.action || '当前账号不能转移到该归属对象。';
  if (error.code === 'TEAM_NOT_FOUND') return '团队不存在或不可用。';
  if (error.code === 'SITE_TRANSFER_INVALID') return '站点归属设置无效。';
  return error.code || error.message || '保存失败';
}

function siteOwnerCandidateSearchText(candidate, ownerType) {
  const values =
    ownerType === 'team'
      ? [candidate.name, candidate.departmentPath, candidate.id]
      : [candidate.realname, candidate.email, candidate.account, candidate.departmentPath, candidate.id];
  return values.filter(Boolean).join(' ').toLowerCase();
}
