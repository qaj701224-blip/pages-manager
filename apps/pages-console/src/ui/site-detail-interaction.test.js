import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const radixSource = readFileSync(new URL('./components/RadixPrimitives.jsx', import.meta.url), 'utf8');
const accountSource = readFileSync(new URL('./pages/AccountSettings.jsx', import.meta.url), 'utf8');
const siteDetailSource = readFileSync(new URL('./pages/SiteDetail.jsx', import.meta.url), 'utf8');
const teamsSource = readFileSync(new URL('./pages/Teams.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('high-risk actions use Radix AlertDialog through shared ConfirmDialog', () => {
  assert.match(radixSource, /@radix-ui\/react-alert-dialog/);
  assert.match(radixSource, /export function ConfirmDialog/);
  assert.match(radixSource, /<AlertDialog\.Root/);
  assert.match(siteDetailSource, /<ConfirmDialog/);
  assert.match(teamsSource, /<ConfirmDialog/);
  assert.doesNotMatch(teamsSource, /globalThis\.confirm/);
});

test('account basic section shows SSO sync as secondary description', () => {
  const ssoDescriptionPattern =
    /<h2>\{t\('basicInfo'\)\}<\/h2>[\s\S]*?<p className="settings-card-description">\{profile\.ssoSource\}<\/p>/;
  const oldInlineNotePattern =
    /ProfileRow label=\{t\('name'\)\} value=\{profile\.displayName\} note=\{profile\.ssoSource\}/;

  assert.match(accountSource, ssoDescriptionPattern);
  assert.doesNotMatch(accountSource, oldInlineNotePattern);
});

test('site deployments show owner context beside deployment source', () => {
  assert.match(siteDetailSource, /<DeploymentsPanel state=\{resourceState\} site=\{site\} \/>/);
  assert.match(siteDetailSource, /<span>归属<\/span>/);
  assert.match(siteDetailSource, /deploymentOwnerLabel\(deployment, site\)/);
});

test('site overview summarizes service state instead of a raw active status row', () => {
  const overviewSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function SiteOverview'),
    siteDetailSource.indexOf('function DeploymentsPanel')
  );

  assert.match(overviewSource, /<SiteStatusSummary site=\{site\} \/>/);
  assert.match(siteDetailSource, /function SiteStatusSummary/);
  assert.match(siteDetailSource, /site-status-summary/);
  assert.doesNotMatch(overviewSource, /\['Status', site\.status \|\| 'active'\]/);
});

test('site access shows ACL editor only for acl visibility and opens add entry dialog', () => {
  assert.match(siteDetailSource, /const aclEnabled = visibility === 'acl';/);
  assert.match(siteDetailSource, /\{aclEnabled \? \(/);
  assert.match(siteDetailSource, /title="添加访问对象"/);
  assert.match(siteDetailSource, /setAclDialogOpen\(true\)/);
  assert.doesNotMatch(siteDetailSource, /<InfoList title="访问策略"/);
});

test('runtime config uses add dialogs instead of inline creation forms', () => {
  assert.match(siteDetailSource, /<RuntimeVarDialog/);
  assert.match(siteDetailSource, /<RuntimeSecretDialog/);
  assert.match(siteDetailSource, /setVarDialogOpen\(true\)/);
  assert.match(siteDetailSource, /setSecretDialogOpen\(true\)/);
  assert.match(siteDetailSource, /版本 \{item\.revision \|\| 0\}/);
  assert.doesNotMatch(siteDetailSource, /placeholder="API_BASE"/);
  assert.doesNotMatch(siteDetailSource, /placeholder="API_TOKEN"/);
  assert.doesNotMatch(siteDetailSource, /<RuntimeVarForm siteId=\{site\.id\}/);
  assert.doesNotMatch(siteDetailSource, /<RuntimeSecretForm siteId=\{site\.id\}/);
});

test('team cards stay compact and omit custom team type tag', () => {
  assert.match(teamsSource, /\{team\.typeLabel \? <span className="tag muted">\{team\.typeLabel\}<\/span> : null\}/);
  assert.match(teamsSource, /team-card__stats/);
  assert.match(teamsSource, /<strong>\{team\.siteCount\}<\/strong> 站点/);
  assert.match(teamsSource, /<strong>\{team\.memberCount\}<\/strong> 成员/);
  const compactGridPattern = /\.team-card-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill, minmax\(260px, 360px\)\);/;

  assert.match(stylesSource, compactGridPattern);
  assert.match(stylesSource, /\.team-card\s*\{[\s\S]*?min-height:\s*168px;/);
  assert.match(stylesSource, /\.team-card__stats\s*\{[\s\S]*?border-top:\s*1px solid var\(--xd-border\);/);
});
