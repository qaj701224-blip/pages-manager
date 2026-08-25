const MANAGEABLE_TEAM_ROLES = new Set(['publisher', 'admin']);

export function buildSiteOwnershipTransferForm(site = {}) {
  const owner = site.owner || {};
  return {
    ownerType: owner.type === 'team' ? 'team' : 'user',
    ownerId: owner.id || '',
    query: '',
  };
}

export function normalizeSiteTitleMetadataPayload(value) {
  const title = String(value ?? '')
    .normalize('NFC')
    .trim();
  return { title: title || null };
}

export function normalizeSiteSlugMetadataPayload(value) {
  return {
    slug: String(value ?? '')
      .trim()
      .toLowerCase(),
  };
}

export function siteHostnameForSlug(site = {}, value = '') {
  const slug = normalizeSiteSlugMetadataPayload(value).slug;
  const currentSlug = String(site.slug || '');
  const currentHostname = String(site.hostname || '');
  if (!slug) return currentHostname;
  if (currentSlug && hostnameStartsWithSlug(currentHostname, currentSlug)) {
    return `${slug}${currentHostname.slice(currentSlug.length)}`;
  }
  return slug;
}

function hostnameStartsWithSlug(hostname, slug) {
  return hostname.startsWith(`${slug}.`) || hostname.startsWith(`${slug}-staging.`);
}

export function normalizeSiteOwnershipTransferPayload(form = {}) {
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

export function filterSiteOwnerCandidates(candidates = [], query = '', ownerType = 'user', scope = 'workspace') {
  const normalizedQuery = String(query || '')
    .trim()
    .toLowerCase();
  return candidates.filter((candidate) => {
    if (ownerType === 'team') {
      if (candidate.status !== 'active') return false;
      if (scope !== 'admin' && !MANAGEABLE_TEAM_ROLES.has(candidate.currentUserRole)) return false;
    } else if (candidate.employeeStatus !== 'active') {
      return false;
    }
    if (!normalizedQuery) return true;
    return siteOwnerCandidateSearchText(candidate, ownerType).includes(normalizedQuery);
  });
}

export function isCurrentSiteOwner(site = {}, form = {}) {
  const owner = site.owner || {};
  return owner.type === form.ownerType && String(owner.id || '') === String(form.ownerId || '');
}

export function siteOwnershipTransferLosesAccess(scope, target = {}, currentUserId = null) {
  if (scope === 'admin') return false;
  if (target.ownerType !== 'team') return !currentUserId || target.ownerId !== currentUserId;
  return !MANAGEABLE_TEAM_ROLES.has(target.currentUserRole);
}

export function shouldLeaveSiteAfterOwnershipTransfer(scope, site = {}) {
  return scope !== 'admin' && site.permissions?.canManage !== true;
}

export function buildSiteOwnershipReauthHref(siteId, scope = 'workspace') {
  const encodedSiteId = encodeURIComponent(String(siteId || ''));
  const returnTo = scope === 'admin' ? `/admin/sites/${encodedSiteId}/settings` : `/workspace/sites/${encodedSiteId}/settings`;
  const search = new URLSearchParams({ reauth: '1', returnTo });
  return `/api/console/auth/login?${search.toString()}`;
}

export function siteOwnerView(owner = {}) {
  const ownerType = owner.type === 'team' ? 'team' : 'user';
  const typeLabel = ownerType === 'team' ? '团队' : '个人';
  const label =
    owner.displayName ||
    owner.realname ||
    owner.name ||
    (ownerType === 'team' ? owner.departmentPath : owner.email) ||
    owner.id ||
    typeLabel;
  const metadata = ownerType === 'team' ? [owner.departmentPath, owner.id] : [owner.email, owner.departmentPath, owner.id];
  const meta = metadata.find((value) => value && value !== label) || '';
  return { typeLabel, label, meta };
}

export function siteOwnerCandidateLabel(candidate = {}, ownerType = 'user') {
  if (ownerType === 'team') return candidate.name || candidate.departmentPath || candidate.id || '团队';
  return candidate.realname || candidate.email || candidate.account || candidate.id || '用户';
}

export function siteOwnerCandidateMeta(candidate = {}, ownerType = 'user') {
  if (ownerType === 'team') return candidate.departmentPath || candidate.id || '';
  return candidate.email || candidate.departmentPath || '';
}

export function getSiteOwnershipTransferErrorMessage(error) {
  if (!error) return '';
  if (error.code === 'USER_REQUIRED') return '请选择用户。';
  if (error.code === 'TEAM_REQUIRED') return '请选择团队。';
  if (error.code === 'CONSOLE_RECENT_LOGIN_REQUIRED') return '请重新验证身份后再转移站点归属。';
  if (error.code === 'SITE_ADMIN_REQUIRED') return '仅当前个人 Owner 或源团队 admin 可转移站点归属。';
  if (error.code === 'PLATFORM_ADMIN_REQUIRED') return '需要平台管理员权限才能转移站点归属。';
  if (error.code === 'SITE_TRANSFER_FORBIDDEN') return '目标用户或团队不可用，或你没有目标团队的 publisher/admin 权限。';
  if (error.code === 'TEAM_NOT_FOUND') return '团队不存在或不可用。';
  if (error.code === 'SITE_TRANSFER_INVALID') return '目标归属无效，或与当前归属相同。';
  if (error.code === 'SITE_VISIBILITY_INVALID') return '请先将访问模式改为团队支持的模式，再转移归属。';
  if (error.code === 'SITE_POLICY_CONFLICT') return '站点归属或权限已变化，请刷新后重试。';
  if (error.code === 'ROUTE_POLICY_REPAIR_REQUIRED') return '归属未能安全生效，请刷新确认当前归属后重试。';
  if (error.code === 'SITE_NOT_FOUND') return '站点不存在或当前账号已无权访问。';
  return error.message || error.code || '转移失败';
}

export function getSiteMetadataErrorMessage(error) {
  if (!error) return '';
  if (error.code === 'SITE_TITLE_INVALID') return '名称需为 1–80 个字符，且不能包含换行或控制字符。';
  if (error.code === 'SITE_SLUG_INVALID') return '站点 URL 需为 2–50 位小写字母、数字或连字符。';
  if (error.code === 'SITE_SLUG_RESERVED') return '该站点 URL 为平台保留地址，请更换。';
  if (error.code === 'SITE_SLUG_CONFLICT') return '该站点 URL 已被占用，请更换。';
  if (error.code === 'SITE_METADATA_CONFLICT') return '站点设置已发生变化，请刷新后重试。';
  if (error.code === 'SITE_METADATA_MUTATIONS_DISABLED') return '站点名称与 URL 修改暂未开放。';
  if (error.code === 'SITE_PUBLISHER_REQUIRED') return '需要站点 publisher 或 admin 权限。';
  if (error.code === 'SITE_NOT_FOUND') return '站点不存在或当前账号无权修改。';
  return error.code || error.message || '保存失败';
}

function siteOwnerCandidateSearchText(candidate, ownerType) {
  const values =
    ownerType === 'team'
      ? [candidate.name, candidate.departmentPath, candidate.id]
      : [candidate.realname, candidate.email, candidate.account, candidate.departmentPath, candidate.id];
  return values.filter(Boolean).join(' ').toLowerCase();
}
