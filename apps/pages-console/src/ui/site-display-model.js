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
