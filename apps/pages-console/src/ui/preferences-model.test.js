import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeLocale, normalizeTheme, readStoredPreference, writeStoredPreference } from './preferences-model.js';

test('preferences model normalizes supported theme and locale values', () => {
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('system'), 'system');
  assert.equal(normalizeTheme('unknown'), 'system');
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('ja'), 'zh-CN');
});

test('preferences model reads and writes local storage safely', () => {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };

  writeStoredPreference(localStorage, 'xd_cell_theme', 'dark');
  assert.equal(readStoredPreference(localStorage, 'xd_cell_theme', 'system'), 'dark');
  assert.equal(readStoredPreference(localStorage, 'xd_cell_locale', 'zh-CN'), 'zh-CN');
});
