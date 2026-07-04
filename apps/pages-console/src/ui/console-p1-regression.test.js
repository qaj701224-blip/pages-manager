import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const accessKeysSource = readFileSync(new URL('./pages/AccessKeys.jsx', import.meta.url), 'utf8');
const adminTeamsSource = readFileSync(new URL('./pages/AdminTeams.jsx', import.meta.url), 'utf8');
const siteDetailSource = readFileSync(new URL('./pages/SiteDetail.jsx', import.meta.url), 'utf8');
const sitesDirectorySource = readFileSync(new URL('./pages/SitesDirectory.jsx', import.meta.url), 'utf8');
const teamsSource = readFileSync(new URL('./pages/Teams.jsx', import.meta.url), 'utf8');
const topNavSource = readFileSync(new URL('./components/TopNav.jsx', import.meta.url), 'utf8');
const media900Source = stylesSource.slice(
  stylesSource.indexOf('@media (max-width: 900px)'),
  stylesSource.indexOf('@media (max-width: 700px)')
);
const media760Source = stylesSource.slice(
  stylesSource.indexOf('@media (max-width: 760px)'),
  stylesSource.indexOf('@media (max-width: 640px)')
);

test('responsive console layout collapses admin tables before tablet width', () => {
  assert.match(media900Source, /\.admin-table\s*\{[\s\S]*?display:\s*block;[\s\S]*?min-width:\s*0;/);
  assert.match(media900Source, /\.admin-table thead\s*\{[\s\S]*?display:\s*none;/);
  assert.match(stylesSource, /\.table-shell\s*\{[\s\S]*?max-width:\s*100%;/);
  assert.doesNotMatch(media900Source, /\.environment-badge\s*\{[^}]*display:\s*none;/);
  assert.match(media900Source, /\.environment-badge__full\s*\{[\s\S]*?display:\s*none;/);
  assert.match(media900Source, /\.environment-badge__short\s*\{[\s\S]*?display:\s*inline;/);
  assert.match(media900Source, /\.sidebar\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(150px, 1fr\)\);/);
  assert.doesNotMatch(media900Source, /\.sidebar\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.doesNotMatch(media900Source, /\.context-title\s*\{[\s\S]*?min-width:\s*210px;/);
  assert.match(media900Source, /\.context-title\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(media760Source, /\.context-sidebar\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(stylesSource, /\.context-sidebar\s*\{[^}]*max-width:\s*100%;/);
  assert.match(stylesSource, /\.context-title\s*\{[^}]*overflow:\s*hidden;/);
  assert.match(stylesSource, /\.workspace-layout > \*\s*\{[^}]*min-width:\s*0;/);
  assert.match(stylesSource, /\.page-heading h1,[\s\S]*?\.page-heading p\s*\{[^}]*text-overflow:\s*ellipsis;/);
});

test('high-risk console actions use contextual in-page confirmation', () => {
  assert.match(accessKeysSource, /function RevokeAccessKeyDialog/);
  assert.match(accessKeysSource, /撤销 Token/);
  assert.match(teamsSource, /title="移除成员"/);
  assert.match(teamsSource, /status\.removing \? '移除中' : '移除成员'/);
  assert.match(teamsSource, /移除后，该用户将失去此团队及团队站点的相关权限。/);
  assert.doesNotMatch(teamsSource, /globalThis\.confirm\?\(`确认从团队中移除/);
  assert.match(siteDetailSource, /title="删除 Secret"/);
  assert.match(siteDetailSource, /删除后，运行时将不再获得该 Secret。/);
  assert.match(siteDetailSource, /title="删除变量"/);
  assert.match(siteDetailSource, /删除后，运行时将不再获得该环境变量。/);
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

test('disabled primary buttons are visually downgraded instead of looking active', () => {
  assert.match(stylesSource, /\.primary-button:disabled\s*\{[\s\S]*?background:\s*var\(--xd-surface\);/);
  assert.match(stylesSource, /\.primary-button:disabled\s*\{[\s\S]*?color:\s*var\(--xd-subtle\);/);
  assert.match(stylesSource, /\.primary-button:disabled:hover\s*\{[\s\S]*?background:\s*var\(--xd-surface\);/);
});

test('site cards use owner object label and open the site directly', () => {
  assert.match(sitesDirectorySource, /<SiteWaterfall state=\{state\} cardAction="open" \/>/);
  assert.match(sitesDirectorySource, /cardAction = 'detail'/);
  assert.match(sitesDirectorySource, /function SiteCard\(\{ site, cardAction = 'detail' \}\)/);
  assert.match(sitesDirectorySource, /siteCardOwnerLabel\(site\.owner\)/);
  assert.match(sitesDirectorySource, /siteVisibilityLabel\(visibility\)/);
  assert.match(sitesDirectorySource, /statusKind === 'disabled' \? <span className="tag tag-disabled">已停用<\/span> : null/);
  assert.match(sitesDirectorySource, /cardAction === 'open' && publicUrl/);
  assert.match(sitesDirectorySource, /cardAction !== 'open' && publicUrl/);
  assert.doesNotMatch(sitesDirectorySource, /const ownerType = site\.owner\?\.type === 'team' \? '团队' : '个人';/);
  assert.doesNotMatch(sitesDirectorySource, /\{ownerType\}/);
  assert.doesNotMatch(sitesDirectorySource, /tag-success' : 'tag tag-disabled'\}>\{status\}/);
});
