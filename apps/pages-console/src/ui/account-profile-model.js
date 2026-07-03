export function buildAccountProfile(session) {
  const user = session?.user || {};
  const email = user.email || '';
  const displayName = user.realname || user.name || displayNameFromEmail(email) || '用户';
  return {
    displayName,
    email: email || '-',
    departmentPath: user.departmentPath || '-',
    ssoSource: '企业 SSO 同步，不可改',
  };
}

function displayNameFromEmail(email) {
  return String(email || '').split('@')[0]?.trim() || '';
}
