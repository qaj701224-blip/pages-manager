const THEME_VALUES = new Set(['system', 'light', 'dark']);
const LOCALE_VALUES = new Set(['zh-CN', 'en']);
export const THEME_STORAGE_KEY = 'xd_cell_theme';
export const LOCALE_STORAGE_KEY = 'xd_cell_locale';

export function normalizeTheme(value) {
  return THEME_VALUES.has(value) ? value : 'system';
}

export function normalizeLocale(value) {
  return LOCALE_VALUES.has(value) ? value : 'zh-CN';
}

export function readStoredPreference(storage, key, fallback) {
  try {
    return storage?.getItem?.(key) || fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredPreference(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch {
    // Preference persistence is best-effort.
  }
}

export function resolveTheme(theme, matchMedia = globalThis.matchMedia) {
  const normalized = normalizeTheme(theme);
  if (normalized !== 'system') return normalized;
  try {
    return matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
