export function sitePublicUrl(hostname) {
  const value = String(hostname || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

export function siteCardOwnerLabel(owner) {
  if (!owner) return '';
  if (owner.type === 'team') return normalizeOwnerLabel(owner.displayName || owner.name || owner.departmentPath);
  return normalizeOwnerLabel(owner.displayName || owner.realname || owner.name);
}

export function siteVisibilityLabel(visibility) {
  const value = String(visibility || '').trim();
  const labels = {
    internal: '内网可见',
    org: '企业成员可见',
    acl: '指定成员可见',
    owner: '仅归属方可见',
    disabled: '已停用',
  };
  return labels[value] || value;
}

export function siteDeploymentShapeLabel(deploymentShape) {
  const value = String(deploymentShape || '').trim();
  if (!value) return '未部署';
  const labels = {
    'assets-only': '静态资源',
    'worker-only': 'Worker',
    'worker-with-assets': 'Worker + 静态资源',
  };
  return labels[value] || '未知类型';
}

export function filterAdminSites(
  sites,
  { query = '', ownerType = 'all', status = 'all', deploymentShape = 'all' } = {}
) {
  const normalizedQuery = query.trim().toLowerCase();
  const knownDeploymentShapes = new Set(['assets-only', 'worker-only', 'worker-with-assets']);
  return sites.filter((site) => {
    const owner = adminSiteOwnerView(site.owner);
    if (ownerType !== 'all' && owner.type !== ownerType) return false;
    if (status !== 'all' && site.status !== status) return false;
    if (deploymentShape === 'un-deployed') {
      if (site.deploymentShape) return false;
    } else if (deploymentShape !== 'all') {
      if (!knownDeploymentShapes.has(deploymentShape) || site.deploymentShape !== deploymentShape) return false;
    }
    if (!normalizedQuery) return true;
    return [
      site.slug,
      site.hostname,
      sitePublicUrl(site.hostname),
      site.visibility,
      site.status,
      owner.primary,
      owner.secondary,
      owner.type,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

export function adminSiteOwnerView(owner = {}) {
  const type = owner.type === 'team' ? 'team' : 'user';
  if (type === 'team') {
    return {
      type,
      tag: 'team',
      primary: owner.departmentPath || owner.displayName || owner.id || '团队',
      secondary: owner.departmentPath && owner.displayName ? owner.displayName : owner.id || '',
    };
  }

  return {
    type,
    tag: 'user',
    primary: owner.email || owner.displayName || owner.id || '用户',
    secondary: owner.email && owner.id ? owner.id : '',
  };
}

function normalizeOwnerLabel(value) {
  return String(value || '').trim();
}
