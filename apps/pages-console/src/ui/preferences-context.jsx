import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { LOCALE_STORAGE_KEY, THEME_STORAGE_KEY, normalizeLocale, normalizeTheme, readStoredPreference, resolveTheme, writeStoredPreference } from './preferences-model.js';
import { translate } from './i18n.js';

const PreferencesContext = createContext(null);

export function PreferencesProvider({ children }) {
  const [theme, setThemeState] = useState(() =>
    normalizeTheme(readStoredPreference(globalThis.localStorage, THEME_STORAGE_KEY, 'system'))
  );
  const [locale, setLocaleState] = useState(() =>
    normalizeLocale(readStoredPreference(globalThis.localStorage, LOCALE_STORAGE_KEY, 'zh-CN'))
  );

  useEffect(() => {
    const resolved = resolveTheme(theme);
    globalThis.document?.documentElement?.setAttribute('data-theme', resolved);
    globalThis.document?.documentElement?.setAttribute('data-theme-preference', theme);
    writeStoredPreference(globalThis.localStorage, THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    globalThis.document?.documentElement?.setAttribute('lang', locale === 'en' ? 'en' : 'zh-CN');
    globalThis.document?.documentElement?.setAttribute('data-locale', locale);
    writeStoredPreference(globalThis.localStorage, LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const value = useMemo(
    () => ({
      theme,
      locale,
      setTheme: (value) => setThemeState(normalizeTheme(value)),
      setLocale: (value) => setLocaleState(normalizeLocale(value)),
      t: (key) => translate(locale, key),
    }),
    [locale, theme]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('usePreferences must be used inside PreferencesProvider');
  return value;
}
