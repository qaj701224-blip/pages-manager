export function buildAccountProfile(session) {
  const user = session?.user || {};
  const email = user.email || '';
  const displayName = user.realname || user.name || displayNameFromEmail(email) || user.userId || '用户';
  return {
    avatarText: displayName.slice(0, 1).toUpperCase(),
    displayName,
    email: email || '-',
    departmentPath: user.departmentPath || '-',
    userId: user.userId || '-',
    ssoSource: '飞书 SSO 同步，不可改',
  };
}

function displayNameFromEmail(email) {
  return String(email || '').split('@')[0]?.trim() || '';
}
