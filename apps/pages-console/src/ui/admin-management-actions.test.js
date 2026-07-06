import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminDashboardSource = readFileSync(new URL('./pages/AdminDashboard.jsx', import.meta.url), 'utf8');
const adminSitesSource = readFileSync(new URL('./pages/AdminSites.jsx', import.meta.url), 'utf8');
const adminTeamsSource = readFileSync(new URL('./pages/AdminTeams.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('admin failed deployments show owner context', () => {
  assert.match(adminDashboardSource, /adminSiteOwnerView\(deployment\.owner\)/);
  assert.match(adminDashboardSource, /<th>归属<\/th>/);
  assert.match(adminDashboardSource, /data-label="归属"/);
});

test('admin site management exposes a safe detail action', () => {
  assert.match(adminSitesSource, /<th>操作<\/th>/);
  assert.match(adminSitesSource, /to=\{`\/admin\/sites\/\$\{encodeURIComponent\(site\.id\)\}`\}/);
  assert.doesNotMatch(adminSitesSource, /\/workspace\/sites/);
  assert.match(adminSitesSource, />\s*查看详情\s*<\/Link>/);
});

test('admin team management exposes a safe team detail action', () => {
  assert.match(adminTeamsSource, /<th>操作<\/th>/);
  assert.match(adminTeamsSource, /to=\{`\/admin\/teams\/\$\{encodeURIComponent\(team\.id\)\}\/settings`\}/);
  assert.doesNotMatch(adminTeamsSource, /\/workspace\/teams/);
  assert.match(adminTeamsSource, />\s*团队设置\s*<\/Link>/);
});

test('admin team detail exposes member management with admin-scoped helpers', () => {
  assert.match(adminTeamsSource, /ADMIN_TEAM_TABS = new Set\(\['members', 'settings'\]\)/);
  assert.match(adminTeamsSource, /listAdminTeamMembers\(teamId\)/);
  assert.match(adminTeamsSource, /updateMember: updateAdminTeamMember/);
  assert.match(adminTeamsSource, /removeMember: removeAdminTeamMember/);
  assert.match(adminTeamsSource, /<TeamMembers/);
});

test('admin deep routes stay under the admin guard', () => {
  assert.match(appSource, /path="\/admin\/:page\/:resourceId"/);
  assert.match(appSource, /path="\/admin\/:page\/:resourceId\/:subpage"/);
  assert.match(appSource, /resourceId=\{resourceId\}/);
  assert.match(appSource, /subpage=\{subpage\}/);
});

test('admin detail tabs expose a clear active state', () => {
  assert.match(stylesSource, /\.detail-tabs a\s*\{[\s\S]*?border:\s*1px solid transparent;/);
  assert.match(stylesSource, /\.detail-tabs a:hover,[\s\S]*?\.detail-tabs a.active\s*\{[\s\S]*?border-color:\s*rgba\(243, 112, 34, 0\.28\);/);
  assert.match(stylesSource, /\.detail-tabs a.active\s*\{[\s\S]*?box-shadow:\s*inset 0 -2px 0 var\(--xd-orange\);/);
});
