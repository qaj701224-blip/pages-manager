export const PLATFORM_PATH_PREFIX = '/.xd-pages/';

export function isPlatformPath(pathname) {
  return pathname === '/.xd-pages' || String(pathname || '').startsWith(PLATFORM_PATH_PREFIX);
}
