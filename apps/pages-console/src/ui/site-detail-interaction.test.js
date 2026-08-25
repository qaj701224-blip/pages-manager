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

test('shared app dialogs ignore pointer interactions outside the dialog', () => {
  const appDialogSource = radixSource.slice(
    radixSource.indexOf('export function AppDialog'),
    radixSource.indexOf('export function ConfirmDialog')
  );

  assert.match(appDialogSource, /onPointerDownOutside=\{\(event\) => event\.preventDefault\(\)\}/);
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
  assert.match(siteDetailSource, /<DeploymentsPanel state=\{resourceState\} site=\{site\} scope=\{scope\} \/>/);
  assert.match(siteDetailSource, /<span>归属<\/span>/);
  assert.match(siteDetailSource, /deploymentOwnerLabel\(deployment, site\)/);
  assert.match(siteDetailSource, /scope === 'admin'/);
  assert.match(siteDetailSource, /<span>操作人<\/span>/);
  assert.match(siteDetailSource, /adminDeploymentActorView\(deployment\.actor\)/);
});

test('only admin site deployments expose the trace timeline action', () => {
  const deploymentsSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function DeploymentsPanel'),
    siteDetailSource.indexOf('function DeploymentActorCell')
  );

  assert.match(deploymentsSource, /scope === 'admin'/);
  assert.match(deploymentsSource, /<DeploymentTracePanel/);
  assert.match(deploymentsSource, />\s*查看时间线\s*</);
  assert.doesNotMatch(deploymentsSource, /scope === 'workspace'[\s\S]*?<DeploymentTracePanel/);
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

test('site settings edit name and URL independently and explain old URL release', () => {
  const settingsSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function SiteSettingsPanel'),
    siteDetailSource.indexOf('function SiteOwnerEditor')
  );
  const slugSettingsSource = settingsSource.slice(settingsSource.indexOf('function SiteSlugSettings'));
  const slugPollingSource = slugSettingsSource.slice(
    slugSettingsSource.indexOf('const poll = async'),
    slugSettingsSource.indexOf('const saveSlug = async')
  );

  assert.match(
    siteDetailSource,
    /const title = state\.site\?\.displayName \|\| state\.site\?\.title \|\| state\.site\?\.slug \|\| siteId;/,
  );
  assert.match(settingsSource, /<SiteTitleSettings/);
  assert.match(settingsSource, /<SiteSlugSettings/);
  assert.match(settingsSource, /siteApi\.updateMetadata\(site\.id, normalizeSiteTitleMetadataPayload\(title\)\)/);
  assert.match(settingsSource, /siteApi\.updateMetadata\(site\.id, normalizeSiteSlugMetadataPayload\(slug\)\)/);
  assert.match(settingsSource, /onSiteUpdate\?\.\(\{ title: data\.site\.title \}\)/);
  assert.match(settingsSource, /slug: data\.site\.slug,[\s\S]*?routingStatus: data\.site\.routingStatus/);
  assert.match(settingsSource, /旧地址将停止访问，并在安全期后释放给其他站点使用/);
  assert.match(settingsSource, /xd-cell\.config\.json/);
  assert.match(settingsSource, /routingStatus === 'pending'/);
  assert.match(settingsSource, /siteApi\.getSite\(site\.id\)/);
  assert.match(slugPollingSource, /pollRequestGuardRef\.current\.begin\(siteSlugKey\)/);
  assert.match(slugPollingSource, /pollRequestGuardRef\.current\.isCurrent\(request\)/);
  assert.match(slugPollingSource, /slug: data\.site\.slug,[\s\S]*?routingStatus: data\.site\.routingStatus/);
  assert.doesNotMatch(slugPollingSource, /onSiteUpdate\?\.\(data\.site\)/);
  assert.match(slugSettingsSource, /return \(\) => pollRequestGuardRef\.current\.activate\(null\)/);
});

test('runtime config refresh preserves rendered data and reserves the page scrollbar', () => {
  const reloadSource = siteDetailSource.slice(
    siteDetailSource.indexOf('const reloadResource = useCallback'),
    siteDetailSource.indexOf('useEffect(() =>', siteDetailSource.indexOf('const reloadResource = useCallback')),
  );
  const configSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function ConfigPanel'),
    siteDetailSource.indexOf('function SiteSettingsPanel'),
  );

  assert.match(reloadSource, /status: current\.data \? 'refreshing' : 'loading'/);
  assert.match(reloadSource, /data: current\.data/);
  assert.match(reloadSource, /resourceRequestGuardRef\.current\.begin\(resourceKey\)/);
  assert.match(reloadSource, /resourceRequestGuardRef\.current\.isCurrent\(request\)/);
  assert.doesNotMatch(reloadSource, /setResourceState\(\{ status: 'loading', data: null/);
  assert.match(configSource, /refreshResourceInBackground\(onResourceReload\)/);
  assert.doesNotMatch(configSource, /await onResourceReload\?\.\(\)/);
  assert.equal((configSource.match(/initialFocusRef=\{nameInputRef\}/g) || []).length, 2);
  assert.match(stylesSource, /html\s*\{[\s\S]*?scrollbar-gutter:\s*stable;/);
});

test('site mutation callbacks stay keyed to the resource tab and site that started them', () => {
  const detailSource = siteDetailSource.slice(
    siteDetailSource.indexOf('export function SiteDetail'),
    siteDetailSource.indexOf('function SiteContextSidebar'),
  );
  const sitePatchSource = detailSource.slice(
    detailSource.indexOf('const patchActiveSite'),
    detailSource.indexOf('const updateActiveResource'),
  );
  const resourceUpdateSource = detailSource.slice(
    detailSource.indexOf('const updateActiveResource'),
    detailSource.indexOf('const fetchActiveResource'),
  );

  assert.match(sitePatchSource, /patchSiteStateForId\(current, siteId, patch\)/);
  assert.match(sitePatchSource, /\[onSiteChange, siteId\]/);
  assert.match(resourceUpdateSource, /applyResourceUpdateForKey\(/);
  assert.match(resourceUpdateSource, /resourceKey, current, data/);
  assert.match(resourceUpdateSource, /\[resourceKey\]/);
  assert.match(detailSource, /onResourceUpdate=\{updateActiveResource\}/);
  assert.match(detailSource, /onSitePatch=\{patchActiveSite\}/);
  assert.doesNotMatch(detailSource, /onResourceUpdate=\{\(data\) => setResourceState/);
});

test('access mutations cannot update a remounted tab after their original form unmounts', () => {
  const accessPolicySource = siteDetailSource.slice(
    siteDetailSource.indexOf('function AccessPolicyForm'),
    siteDetailSource.indexOf('function AdminExposurePanel'),
  );
  const exposureSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function AdminExposurePanel'),
    siteDetailSource.indexOf('function AclEntryDialog'),
  );

  for (const mutationSource of [accessPolicySource, exposureSource]) {
    assert.match(mutationSource, /mutationRequestGuardRef\.current\.activate\(site\.id\)/);
    assert.match(mutationSource, /return \(\) => mutationRequestGuardRef\.current\.activate\(null\)/);
    assert.match(mutationSource, /mutationRequestGuardRef\.current\.begin\(site\.id\)/);
    assert.match(mutationSource, /mutationRequestGuardRef\.current\.isCurrent\(request\)/);
  }
});

test('site settings ignore mutations completed after navigation and keep metadata patches independent', () => {
  const settingsSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function SiteSettingsPanel'),
    siteDetailSource.indexOf('function SiteOwnerEditor'),
  );
  const titleSettingsSource = settingsSource.slice(
    settingsSource.indexOf('function SiteTitleSettings'),
    settingsSource.indexOf('function SiteSlugSettings'),
  );

  assert.match(settingsSource, /settingsRequestGuardRef\.current\.activate\(site\.id\)/);
  assert.match(settingsSource, /return \(\) => settingsRequestGuardRef\.current\.activate\(null\)/);
  assert.match(settingsSource, /settingsRequestGuardRef\.current\.isCurrent\(request\)/);
  assert.match(settingsSource, /onSiteUpdate\?\.\(pickSiteOwnershipPatch\(data\.site\)\)/);
  assert.doesNotMatch(settingsSource, /onSiteUpdate\?\.\(data\.site\)/);
  assert.match(titleSettingsSource, /titleRequestGuardRef\.current\.activate\(site\.id\)/);
  assert.match(titleSettingsSource, /return \(\) => titleRequestGuardRef\.current\.activate\(null\)/);
  assert.match(titleSettingsSource, /titleRequestGuardRef\.current\.isCurrent\(request\)/);
});

test('site access shows ACL editor only for acl visibility and opens add entry dialog', () => {
  assert.match(siteDetailSource, /const aclEnabled = visibility === 'acl';/);
  assert.match(siteDetailSource, /\{aclEnabled \? \(/);
  assert.match(siteDetailSource, /title="添加访问对象"/);
  assert.match(siteDetailSource, /setAclDialogOpen\(true\)/);
  assert.doesNotMatch(siteDetailSource, /<InfoList title="访问策略"/);
});

test('admin exposure audit warnings remain visible after a successful update', () => {
  const panelSource = siteDetailSource.slice(siteDetailSource.indexOf('function AdminExposurePanel'));

  assert.match(panelSource, /data\.auditStatus === 'unconfirmed'/);
  assert.match(panelSource, /siteExposureAuditWarning\(nextExposure\)/);
});

test('admin exposure panel shows the current public reason as escaped React text', () => {
  const panelSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function AdminExposurePanel'),
    siteDetailSource.indexOf('function AclEntryDialog')
  );

  assert.match(panelSource, /exposure === 'public' && access\.exposureReason\?\.text/);
  assert.match(panelSource, /aria-label="最近一次允许互联网访问原因"/);
  assert.match(panelSource, /\{access\.exposureReason\.text\}/);
  assert.match(panelSource, /开启时间：\{formatDate\(access\.exposureReason\.changedAt\)\}/);
  assert.doesNotMatch(panelSource, /dangerouslySetInnerHTML/);
  assert.match(stylesSource, /\.exposure-policy-reason\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(stylesSource, /\.exposure-policy-reason\s*\{[\s\S]*?border-top:\s*1px solid var\(--xd-border\);/);
  assert.match(stylesSource, /\.exposure-policy-reason strong\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
});

test('site access cards keep network range and access requirements in consistent positions', () => {
  const accessFormSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function AccessPolicyForm'),
    siteDetailSource.indexOf('function AdminExposurePanel')
  );
  const exposurePanelSource = siteDetailSource.slice(
    siteDetailSource.indexOf('function AdminExposurePanel'),
    siteDetailSource.indexOf('function AclEntryDialog')
  );

  assert.match(exposurePanelSource, /className="info-list access-control-card exposure-policy-card"/);
  assert.match(exposurePanelSource, /className="access-control-card__head"/);
  assert.match(exposurePanelSource, /className="access-control-card__body network-range-body"/);
  assert.match(exposurePanelSource, /<h2>网络范围<\/h2>/);
  assert.match(exposurePanelSource, /\{rangeView\.status\}/);
  assert.match(exposurePanelSource, /\{rangeView\.effect\}/);
  assert.match(exposurePanelSource, /\{rangeView\.description\}/);
  assert.match(exposurePanelSource, /\{rangeView\.action\}/);
  assert.doesNotMatch(exposurePanelSource, /className="primary-button"[\s\S]*?\{rangeView\.action\}/);
  assert.doesNotMatch(exposurePanelSource, /className="panel-head"/);
  assert.doesNotMatch(exposurePanelSource, /网络范围与 Visibility/);
  const mobileExposureSummaryPattern =
    /@media \(max-width: 640px\)[\s\S]*?\.exposure-policy-summary\s*\{[\s\S]*?flex-direction:\s*column;/;
  const mobileExposureActionsPattern =
    /\.exposure-policy-summary > button\s*\{[\s\S]*?align-self:\s*flex-start;/;
  const mobileCardHeadPattern =
    /@media \(max-width: 640px\)[\s\S]*?\.access-control-card__head,[\s\S]*?flex-direction:\s*column;/;
  assert.match(stylesSource, mobileExposureSummaryPattern);
  assert.match(stylesSource, mobileExposureActionsPattern);
  assert.match(stylesSource, mobileCardHeadPattern);
  assert.match(accessFormSource, /<form className="info-list access-control-card"/);
  assert.match(accessFormSource, /className="access-control-card__head"/);
  assert.match(accessFormSource, /className="access-control-card__body"/);
  assert.match(accessFormSource, /<h2>访问权限<\/h2>/);
  assert.match(accessFormSource, /label="访问对象"/);
  assert.match(accessFormSource, /siteAccessOptionLabel\(option\)/);
  assert.match(accessFormSource, /siteAccessRequirementDescription\(visibility\)/);
  assert.match(accessFormSource, /<AlertTriangle[^>]*\/>[\s\S]*?当前组合：\{siteAccessEffectLabel/);
  assert.doesNotMatch(accessFormSource, /acl-policy-summary/);
  assert.doesNotMatch(accessFormSource, /className="panel-head"/);

  const summaryRule = stylesSource.match(/\.exposure-policy-summary\s*\{([^}]*)\}/)?.[1] || '';
  const cardRule = stylesSource.match(/\.access-control-card\s*\{([^}]*)\}/)?.[1] || '';
  const cardHeadRule = stylesSource.match(/\.access-control-card__head\s*\{([^}]*)\}/)?.[1] || '';
  const cardTitleRule = stylesSource.match(/\.access-control-card__head h2\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(summaryRule, /border:/);
  assert.doesNotMatch(summaryRule, /border-radius:/);
  assert.doesNotMatch(summaryRule, /background:/);
  assert.match(cardRule, /min-height:\s*194px;/);
  assert.doesNotMatch(cardHeadRule, /border-bottom:/);
  assert.match(cardTitleRule, /padding:\s*0;/);
});

test('read-only access policy uses the same access subject terminology', () => {
  const readOnlySource = siteDetailSource.slice(
    siteDetailSource.indexOf('function ReadOnlyAccessPolicy'),
    siteDetailSource.indexOf('function ReadOnlyAclList')
  );

  assert.match(readOnlySource, /<h2>访问权限<\/h2>/);
  assert.match(readOnlySource, /className="info-list access-control-card"/);
  assert.match(readOnlySource, /className="access-control-card__head"/);
  assert.match(readOnlySource, /className="access-control-card__body"/);
  assert.doesNotMatch(readOnlySource, /className="panel-head"/);
  assert.match(readOnlySource, /<dt>访问对象<\/dt>/);
  assert.match(readOnlySource, /siteAccessOptionLabel\(access\.visibility \|\| 'internal'\)/);
  assert.match(readOnlySource, /siteAccessRequirementDescription\(access\.visibility \|\| 'internal'\)/);
  assert.doesNotMatch(readOnlySource, /Visibility/);
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

test('workspace runtime config navigation and requests are gated by effective role', () => {
  assert.match(siteDetailSource, /state\.status === 'ready'[\s\S]*?canViewRuntimeConfig\(state\.site, scope\);/);
  assert.match(siteDetailSource, /activeTab === 'config' && !canViewConfig/);
  assert.match(siteDetailSource, /\{canViewConfig \? \([\s\S]*?label="运行配置"[\s\S]*?\) : null\}/);
  assert.match(siteDetailSource, /当前角色无权查看运行配置/);
  assert.doesNotMatch(siteDetailSource, /当前角色只能查看运行配置/);
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
