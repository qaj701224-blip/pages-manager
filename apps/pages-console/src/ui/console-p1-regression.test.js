import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const accessKeysSource = readFileSync(new URL('./pages/AccessKeys.jsx', import.meta.url), 'utf8');
const adminTeamsSource = readFileSync(new URL('./pages/AdminTeams.jsx', import.meta.url), 'utf8');
const siteDetailSource = readFileSync(new URL('./pages/SiteDetail.jsx', import.meta.url), 'utf8');
const teamsSource = readFileSync(new URL('./pages/Teams.jsx', import.meta.url), 'utf8');
const topNavSource = readFileSync(new URL('./components/TopNav.jsx', import.meta.url), 'utf8');
const media900Source = stylesSource.slice(
  stylesSource.indexOf('@media (max-width: 900px)'),
  stylesSource.indexOf('@media (max-width: 700px)')
);

test('responsive console layout collapses admin tables before tablet width', () => {
  assert.match(media900Source, /\.admin-table\s*\{[\s\S]*?display:\s*block;[\s\S]*?min-width:\s*0;/);
  assert.match(media900Source, /\.admin-table thead\s*\{[\s\S]*?display:\s*none;/);
  assert.match(stylesSource, /\.table-shell\s*\{[\s\S]*?max-width:\s*100%;/);
  assert.match(media900Source, /\.environment-badge\s*\{[\s\S]*?display:\s*none;/);
  assert.match(media900Source, /\.sidebar\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(150px, 1fr\)\);/);
  assert.doesNotMatch(media900Source, /\.sidebar\s*\{[\s\S]*?overflow-x:\s*auto;/);
});

test('high-risk console actions use contextual in-page confirmation', () => {
  assert.match(accessKeysSource, /function RevokeAccessKeyDialog/);
  assert.match(accessKeysSource, /撤销 Token/);
  assert.match(teamsSource, /title="移除成员"/);
  assert.match(teamsSource, /移除后，该用户将失去此团队及团队站点的相关权限。/);
  assert.doesNotMatch(teamsSource, /globalThis\.confirm\?\(`确认从团队中移除/);
});

test('disabled form actions are guarded in submit handlers too', () => {
  assert.match(adminTeamsSource, /if \(mergeDisabled\) return;/);
  assert.match(siteDetailSource, /if \(saving \|\| !isDirty\) return;/);
  assert.match(accessKeysSource, /disabled=\{saving \|\| !form\.name\.trim\(\) \|\| form\.permissions\.length === 0\}/);
});

test('notifications expose an empty state popover', () => {
  assert.match(topNavSource, /className="notification-menu"/);
  assert.match(topNavSource, /暂无通知/);
});
