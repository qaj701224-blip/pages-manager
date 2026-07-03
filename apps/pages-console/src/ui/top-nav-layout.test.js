import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const topNavSource = readFileSync(new URL('./components/TopNav.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('top nav uses text language selector and reserves globe icon for sites', () => {
  assert.match(topNavSource, /<Globe2 size=\{15\} \/>\s*<span>\{t\('sites'\)\}<\/span>/);
  assert.match(topNavSource, /className="language-menu__button"/);
  assert.doesNotMatch(topNavSource, /<IconDropdown label=\{t\('language'\)\} icon=\{<Globe2/);
  assert.match(stylesSource, /\.language-menu__button\s*\{[\s\S]*?border:\s*1px solid rgba\(243, 112, 34, 0\.5\);/);
});
