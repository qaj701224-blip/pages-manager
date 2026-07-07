import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebarSource = readFileSync(new URL('./components/Sidebar.jsx', import.meta.url), 'utf8');
const i18nSource = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');

test('workspace sidebar uses globe icons for personal and team site entries', () => {
  assert.match(sidebarSource, /import \{ Globe2, KeyRound, Settings, UsersRound \} from 'lucide-react';/);
  assert.doesNotMatch(sidebarSource, /Workflow/);
  assert.match(
    sidebarSource,
    /to="\/workspace\/published"[\s\S]*?<Globe2 size=\{17\} \/>[\s\S]*?<span>\{t\('personalSites'\)\}<\/span>/
  );
  assert.match(
    sidebarSource,
    /to="\/workspace\/team-sites"[\s\S]*?<Globe2 size=\{17\} \/>[\s\S]*?<span>\{t\('teamSites'\)\}<\/span>/
  );
});

test('workspace sidebar site labels include the site noun in supported locales', () => {
  assert.match(i18nSource, /personalSites:\s*'个人站点'/);
  assert.match(i18nSource, /teamSites:\s*'团队站点'/);
  assert.match(i18nSource, /personalSites:\s*'Personal Sites'/);
  assert.match(i18nSource, /teamSites:\s*'Team Sites'/);
});
