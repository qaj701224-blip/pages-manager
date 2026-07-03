import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const siteDetailSource = readFileSync(new URL('./pages/SiteDetail.jsx', import.meta.url), 'utf8');
const teamsSource = readFileSync(new URL('./pages/Teams.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('context sidebars keep titles and metadata compact with full-value tooltips', () => {
  assert.match(siteDetailSource, /<h2 title=\{slug\}>\{slug\}<\/h2>/);
  assert.match(siteDetailSource, /<p title=\{site\.hostname\}>\{site\.hostname\}<\/p>/);
  assert.match(teamsSource, /<h2 title=\{team\?\.name \|\| teamId\}>\{team\?\.name \|\| teamId\}<\/h2>/);
  assert.match(teamsSource, /<p title=\{team\.description\}>\{team\.description\}<\/p>/);
  assert.match(stylesSource, /\.context-title h2,[\s\S]*?white-space:\s*nowrap;[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(stylesSource, /\.context-title \.compact-tags\s*\{[\s\S]*?flex-wrap:\s*nowrap;/);
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
