export function getConsoleEnvironmentBanner(hostname) {
  return hostname === 'staging.workers.xd.team' ? 'Staging · 仅平台管理员 · 与 production 数据和执行资源物理隔离' : '';
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
  return {
    authenticated: true,
    label: email || payload.user?.userId || '用户',
    showAdmin: Boolean(payload.user?.isPlatformAdmin),
  };
}
