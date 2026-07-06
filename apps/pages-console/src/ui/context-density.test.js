import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const siteDetailSource = readFileSync(new URL('./pages/SiteDetail.jsx', import.meta.url), 'utf8');
const teamsSource = readFileSync(new URL('./pages/Teams.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('context sidebars keep only navigation and avoid duplicate summary cards', () => {
  assert.doesNotMatch(siteDetailSource, /className="context-title"/);
  assert.doesNotMatch(teamsSource, /className="context-title"/);
  assert.match(siteDetailSource, /aria-label="站点导航"/);
  assert.match(teamsSource, /aria-label="团队导航"/);
});

test('team settings expose the stable team id', () => {
  assert.match(teamsSource, /\['ID', team\.id \|\| '-'\]/);
});

test('detail rows use comfortable single-line primary and secondary text', () => {
  assert.match(stylesSource, /\.table-row > div,[\s\S]*?gap:\s*5px;[\s\S]*?align-content:\s*center;/);
  assert.match(stylesSource, /\.table-row strong,[\s\S]*?white-space:\s*nowrap;[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(
    stylesSource,
    /\.table-row > div > span:not\(\.tag\),[\s\S]*?white-space:\s*nowrap;[\s\S]*?text-overflow:\s*ellipsis;/
  );
  assert.match(stylesSource, /\.info-list dd\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(stylesSource, /\.runtime-row\s*\{[\s\S]*?min-height:\s*56px;/);
});
