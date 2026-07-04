export function getConsoleEnvironmentBanner(hostname) {
  return hostname === 'staging.workers.xd.team' ? 'Staging · 仅平台管理员 · 与 production 数据和执行资源物理隔离' : '';
}

export function getConsoleEnvironmentShortLabel(hostname) {
  return hostname === 'staging.workers.xd.team' ? 'Staging' : '';
}

export function readTopNavUserState(payload) {
  if (!payload?.authenticated) {
    return {
      authenticated: false,
      label: '登录',
      showAdmin: false,
    };
  }

  const email = payload.user?.email || '';
  const displayName = payload.user?.realname || payload.user?.name || displayNameFromEmail(email) || payload.user?.userId || '用户';
  const state = {
    authenticated: true,
    label: email || payload.user?.userId || '用户',
    displayName,
    showAdmin: Boolean(payload.user?.isPlatformAdmin),
  };
  if (payload.user?.departmentPath) state.departmentPath = payload.user.departmentPath;
  return state;
}

function displayNameFromEmail(email) {
  const localPart = String(email || '').split('@')[0]?.trim();
  if (!localPart) return '';
  return localPart;
}
