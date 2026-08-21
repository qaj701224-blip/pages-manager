import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { BRAND_NAME } from './brand.js';

test('console exposes one semantic brand name for user-visible branding', async () => {
  assert.equal(BRAND_NAME, 'Sites');

  const [app, api, i18n, login, main, sitesDirectory, topNav, html] = await Promise.all([
    readFile(new URL('./App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./api.js', import.meta.url), 'utf8'),
    readFile(new URL('./i18n.js', import.meta.url), 'utf8'),
    readFile(new URL('./pages/Login.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./main.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./pages/SitesDirectory.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./components/TopNav.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../index.html', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /eyebrow=\{BRAND_NAME\}/);
  assert.match(app, /label: `返回 \$\{BRAND_NAME\}`/);
  assert.match(api, /`\$\{BRAND_NAME\} API request failed`/);
  assert.equal(i18n.match(/sites:\s*BRAND_NAME/g)?.length, 2);
  assert.match(login, /auth-panel__eyebrow">\{BRAND_NAME\}/);
  assert.match(topNav, /<strong>\{BRAND_NAME\}<\/strong>/);
  assert.match(sitesDirectory, /meta=\{BRAND_NAME\}/);
  assert.match(main, /document\.title = BRAND_NAME/);
  assert.ok(main.indexOf('document.title = BRAND_NAME') < main.indexOf('createRoot('));
  assert.doesNotMatch(html, /<title>\s*XD Cell\s*<\/title>/);
});
