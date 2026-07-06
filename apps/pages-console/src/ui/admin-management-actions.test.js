import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminDashboardSource = readFileSync(new URL('./pages/AdminDashboard.jsx', import.meta.url), 'utf8');
const adminSitesSource = readFileSync(new URL('./pages/AdminSites.jsx', import.meta.url), 'utf8');
const adminTeamsSource = readFileSync(new URL('./pages/AdminTeams.jsx', import.meta.url), 'utf8');

test('admin failed deployments show owner context', () => {
  assert.match(adminDashboardSource, /adminSiteOwnerView\(deployment\.owner\)/);
  assert.match(adminDashboardSource, /<th>归属<\/th>/);
  assert.match(adminDashboardSource, /data-label="归属"/);
});

test('admin site management exposes a safe detail action', () => {
  assert.match(adminSitesSource, /<th>操作<\/th>/);
  assert.match(adminSitesSource, /to=\{`\/workspace\/sites\/\$\{encodeURIComponent\(site\.id\)\}`\}/);
  assert.match(adminSitesSource, />\s*查看详情\s*<\/Link>/);
});

test('admin team management exposes a safe team detail action', () => {
  assert.match(adminTeamsSource, /<th>操作<\/th>/);
  assert.match(adminTeamsSource, /to=\{`\/workspace\/teams\/\$\{encodeURIComponent\(team\.id\)\}\/settings`\}/);
  assert.match(adminTeamsSource, />\s*团队设置\s*<\/Link>/);
});
