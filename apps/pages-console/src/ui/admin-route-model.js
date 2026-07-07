export function getAdminRouteAccess(sessionPayload) {
  if (!sessionPayload?.authenticated) return 'login';
  if (!sessionPayload.user?.isPlatformAdmin) return 'forbidden';
  return 'allowed';
}

export function buildAdminLoginPath(currentPath) {
  const returnTo = normalizeAdminReturnTo(currentPath);
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function normalizeAdminReturnTo(value) {
  const fallback = '/admin';
  const raw = String(value || '').trim() || fallback;
  if (raw.startsWith('//')) return fallback;

  let url;
  try {
    url = new URL(raw, globalThis.location?.origin || 'https://workers.xd.team');
  } catch {
    return fallback;
  }

  if (globalThis.location?.origin && url.origin !== globalThis.location.origin) return fallback;
  if (url.username || url.password || url.hash) return fallback;
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    return `${url.pathname}${url.search}`;
  }
  return fallback;
}
