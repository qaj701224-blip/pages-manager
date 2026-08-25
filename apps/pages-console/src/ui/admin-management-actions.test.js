import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminDashboardSource = readFileSync(new URL('./pages/AdminDashboard.jsx', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('./pages/Admin.jsx', import.meta.url), 'utf8');
const adminDeploymentCleanupsSource = readFileSync(new URL('./pages/AdminDeploymentCleanups.jsx', import.meta.url), 'utf8');
const adminV1SitesSource = readFileSync(new URL('./pages/AdminV1Sites.jsx', import.meta.url), 'utf8');
const adminNormalWorkersSource = readFileSync(new URL('./pages/AdminNormalWorkers.jsx', import.meta.url), 'utf8');
const adminSitesSource = readFileSync(new URL('./pages/AdminSites.jsx', import.meta.url), 'utf8');
const siteDetailSource = readFileSync(new URL('./pages/SiteDetail.jsx', import.meta.url), 'utf8');
const adminTeamsSource = readFileSync(new URL('./pages/AdminTeams.jsx', import.meta.url), 'utf8');
const adminUsersSource = readFileSync(new URL('./pages/AdminUsers.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
let deploymentTracePanelSource = '';
try {
  deploymentTracePanelSource = readFileSync(new URL('./components/DeploymentTracePanel.jsx', import.meta.url), 'utf8');
} catch {
  // The red test should fail on the missing implementation, not while loading fixtures.
}

test('admin failed deployments show owner context', () => {
  assert.match(adminDashboardSource, /adminDeploymentOwnerView\(deployment\.owner\)/);
  assert.match(adminDashboardSource, /adminDeploymentActorView\(deployment\.actor\)/);
  assert.match(adminDashboardSource, /<th>客户端来源<\/th>/);
  assert.match(adminDashboardSource, /<th>站点归属<\/th>/);
  assert.match(adminDashboardSource, /<th>操作人<\/th>/);
  assert.match(adminDashboardSource, /data-label="站点归属"/);
  assert.match(adminDashboardSource, /data-label="操作人"/);
  assert.match(adminDashboardSource, /deployment\.siteSlug \|\| deployment\.siteId/);
  assert.doesNotMatch(adminDashboardSource, /<td data-label="站点">\{deployment\.siteId\}<\/td>/);
});

test('admin site management exposes a safe detail action', () => {
  assert.match(adminSitesSource, /<th>操作<\/th>/);
  assert.match(adminSitesSource, /to=\{`\/admin\/sites\/\$\{encodeURIComponent\(site\.id\)\}`\}/);
  assert.doesNotMatch(adminSitesSource, /\/workspace\/sites/);
  assert.match(adminSitesSource, />\s*查看详情\s*<\/Link>/);
});

test('admin site list keeps metadata changes made in the embedded detail view', () => {
  assert.match(adminSitesSource, /onSiteChange=\{patchListedSite\}/);
  assert.match(adminSitesSource, /patchSiteSummaryForId\(current\.sites, updatedSiteId, patch\)/);
  assert.match(siteDetailSource, /onSiteChange\?\.\(siteId, patch\)/);
});

test('admin site management displays and filters the active deployment shape', () => {
  assert.match(adminSitesSource, /<th>站点类型<\/th>/);
  assert.match(adminSitesSource, /aria-label="站点类型"/);
  assert.match(adminSitesSource, /siteDeploymentShapeLabel\(site\.deploymentShape\)/);
  assert.match(adminSitesSource, /filterAdminSites\(state\.sites, \{ query, ownerType, status, deploymentShape, exposure \}\)/);
});

test('admin site management exposes network exposure controls without changing visibility options', () => {
  assert.match(adminSitesSource, /aria-label="公网范围"/);
  assert.match(adminSitesSource, /siteExposureLabel\(site\.exposure\)/);
  assert.match(adminSitesSource, /filterAdminSites\(state\.sites, \{ query, ownerType, status, deploymentShape, exposure \}\)/);
  assert.match(adminSitesSource, /listAdminSites\(\{ exposure: exposure === 'all' \? undefined : exposure \}\)/);
  assert.match(adminSitesSource, /\[exposure\]/);
  assert.match(siteDetailSource, /updateAdminSiteExposure/);
  assert.match(siteDetailSource, /AdminExposurePanel/);
  assert.match(siteDetailSource, /<h2>网络范围<\/h2>/);
  assert.match(siteDetailSource, /<h2>访问权限<\/h2>/);
  assert.match(siteDetailSource, /label="访问对象"/);
  assert.match(siteDetailSource, /开启原因/);
  assert.match(siteDetailSource, /最近一次开启原因/);
  assert.match(siteDetailSource, /开启时间/);
  assert.match(siteDetailSource, /移除 XD_OFFICE_NET/);
  assert.match(siteDetailSource, /允许互联网访问/);
  assert.match(siteDetailSource, /限制为公司网络/);
  assert.match(siteDetailSource, /当前组合：/);
  assert.match(siteDetailSource, /不会立即恢复 XD_OFFICE_NET/);
  assert.doesNotMatch(siteDetailSource, /<h2>公网访问<\/h2>/);
  assert.doesNotMatch(siteDetailSource, /label="Visibility"/);
  assert.doesNotMatch(siteDetailSource, /VISIBILITY_OPTIONS = \[[^\]]*public/);
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

test('admin user list labels XDS leaf path as SSO department', () => {
  assert.match(adminUsersSource, /placeholder="搜索姓名、邮箱、SSO 部门"/);
  assert.match(adminUsersSource, /<th>SSO 部门<\/th>/);
  assert.match(adminUsersSource, /data-label="SSO 部门"/);
});

test('admin user list uses server pagination and filters', () => {
  assert.match(adminUsersSource, /debouncedQuery/);
  assert.match(adminUsersSource, /offset: page \* limit/);
  assert.match(adminUsersSource, /admin: adminFilter === 'all' \? undefined : adminFilter/);
  assert.match(adminUsersSource, /status: statusFilter === 'all' \? undefined : statusFilter/);
  assert.match(adminUsersSource, /用户分页/);
  assert.match(adminUsersSource, /上一页/);
  assert.match(adminUsersSource, /下一页/);
  assert.match(adminUsersSource, /state\.status === 'loading' && !state\.loaded/);
});

test('admin normal worker management is exposed as a legacy operations surface', () => {
  assert.match(adminSource, /id: 'normal-workers'/);
  assert.match(adminSource, /Legacy Normal Workers/);
  assert.match(adminSource, /<AdminNormalWorkers/);
  assert.match(apiSource, /listAdminNormalWorkers/);
  assert.match(apiSource, /deleteAdminNormalWorker/);
  assert.match(apiSource, /bulkDeleteAdminNormalWorkers/);
  assert.match(adminNormalWorkersSource, /listAdminNormalWorkers\(\)/);
  assert.match(adminNormalWorkersSource, /deleteAdminNormalWorker\(worker\.id/);
  assert.match(adminNormalWorkersSource, /bulkDeleteAdminNormalWorkers/);
  assert.match(adminNormalWorkersSource, /selectedIds/);
  assert.match(adminNormalWorkersSource, /toggleAllDeletable/);
  assert.match(adminNormalWorkersSource, /hasSingleDeleteInFlight/);
  assert.match(adminNormalWorkersSource, /worker\.id !== busyId/);
  assert.match(adminNormalWorkersSource, /仍被 active route 引用/);
  assert.match(adminNormalWorkersSource, /DELETE \$\{worker\.workerName\}/);
  assert.match(adminNormalWorkersSource, /BULK DELETE/);
  assert.match(adminNormalWorkersSource, /state\.notice\.action/);
  assert.match(adminNormalWorkersSource, /current\.workers\.length > 0 \? 'ready' : 'error'/);
  assert.match(adminNormalWorkersSource, /NORMAL_WORKER_DELETE_FAILED/);
});

test('admin deployment cleanup management is exposed as a WFP GC surface', () => {
  assert.match(adminSource, /id: 'deployment-cleanups'/);
  assert.match(adminSource, /Deployment Cleanups/);
  assert.match(adminSource, /<AdminDeploymentCleanups/);
  assert.match(apiSource, /listAdminDeploymentCleanups/);
  assert.match(apiSource, /runAdminDeploymentCleanup/);
  assert.match(adminDeploymentCleanupsSource, /listAdminDeploymentCleanups\(\{ status: filter === 'all' \? '' : filter \}\)/);
  assert.match(adminDeploymentCleanupsSource, /runAdminDeploymentCleanup\(task\.id/);
  assert.match(adminDeploymentCleanupsSource, /RUN \$\{task\.id\}/);
  assert.match(adminDeploymentCleanupsSource, /cleanupAfter/);
  assert.match(adminDeploymentCleanupsSource, /lastErrorCode/);
  assert.match(adminDeploymentCleanupsSource, /task\.canRun/);
});

test('admin resource governance exposes a manual read-only orphan scan', () => {
  assert.match(apiSource, /scanAdminWorkerOrphans/);
  assert.match(adminDeploymentCleanupsSource, /AppTabs\.Trigger[\s\S]*?Orphan Scan/);
  assert.match(adminDeploymentCleanupsSource, /async function runOrphanScan/);
  assert.match(adminDeploymentCleanupsSource, /scanAdminWorkerOrphans\(\)/);
  assert.match(adminDeploymentCleanupsSource, /onClick=\{runOrphanScan\}/);
  assert.match(adminDeploymentCleanupsSource, /<AppTabs\.Content className="tabs-content" forceMount value="orphan-scan">/);
  assert.match(stylesSource, /\.admin-governance-tabs \.tabs-content\[data-state='inactive'\]\s*\{\s*display:\s*none;/);
  assert.match(adminDeploymentCleanupsSource, /filterWorkerOrphanScanWorkers/);
  assert.match(adminDeploymentCleanupsSource, /orphanReason/);
  assert.match(adminDeploymentCleanupsSource, /state\.scan\.completeness === 'incomplete'/);
  assert.match(adminDeploymentCleanupsSource, /state\.scan\.scannedCount/);
  assert.match(adminDeploymentCleanupsSource, /state\.scan\.namespaceScriptCount/);
  assert.match(adminDeploymentCleanupsSource, /扫描结果可能不完整/);
  assert.doesNotMatch(adminDeploymentCleanupsSource, /deleteAdminWorkerOrphan|cleanupOrphanWorker/);
});

test('resource governance actions require complete scans and expose safe domain links', () => {
  assert.match(adminDeploymentCleanupsSource, /state\.scan\.completeness === 'complete'/);
  assert.match(adminDeploymentCleanupsSource, /backfillAdminWorkerOrphans/);
  assert.match(adminDeploymentCleanupsSource, /incomplete/);
  assert.match(adminDeploymentCleanupsSource, /selectedRollbackEligibleCount/);
  assert.match(adminDeploymentCleanupsSource, /删除后该版本不可回滚/);
  assert.match(adminDeploymentCleanupsSource, /target="_blank"/);
  assert.match(adminDeploymentCleanupsSource, /rel="noopener noreferrer"/);
  assert.match(adminV1SitesSource, /bulkRetireAdminV1Sites/);
  assert.match(adminV1SitesSource, /deleteAdminV1Site/);
  assert.match(adminV1SitesSource, /globalThis\.confirm\?\./);
  assert.match(adminV1SitesSource, /确认退役 v1 站点/);
  assert.match(adminV1SitesSource, /确认批量退役/);
  assert.doesNotMatch(adminV1SitesSource, /globalThis\.prompt/);
  assert.match(adminV1SitesSource, /platform_reserved/);
  assert.match(adminV1SitesSource, /unknown/);
  assert.match(adminV1SitesSource, /site\.canRetire === true/);
  assert.match(adminV1SitesSource, /v1RetireBlockedLabel/);
  assert.match(adminV1SitesSource, /script_name_mismatch/);
  assert.match(adminV1SitesSource, /worker_missing/);
  assert.match(adminV1SitesSource, /target="_blank"/);
  assert.match(adminV1SitesSource, /rel="noopener noreferrer"/);
  assert.match(adminSitesSource, /target="_blank"/);
  assert.match(adminSitesSource, /rel="noopener noreferrer"/);
});

test('admin v1 site inventory is registered as a read-only operations page', () => {
  assert.match(adminSource, /id: 'v1-sites'/);
  assert.match(adminSource, /Legacy v1 Sites/);
  assert.match(adminSource, /<AdminV1Sites/);
  assert.match(apiSource, /listAdminV1Sites/);
  assert.match(adminV1SitesSource, /listAdminV1Sites\(\)/);
  assert.match(adminV1SitesSource, /filterV1Sites/);
  assert.match(adminV1SitesSource, /疑似废弃/);
  assert.match(adminV1SitesSource, /migratedCandidate/);
  assert.match(adminV1SitesSource, /onRetry=\{reload\}/);
  assert.doesNotMatch(adminV1SitesSource, /\.metadata/i);
  assert.match(adminV1SitesSource, /归属 Token/);
});

test('admin errors preserve actionable API guidance and support an optional retry', () => {
  assert.match(adminDashboardSource, /error\?\.message/);
  assert.match(adminDashboardSource, /error\?\.action/);
  assert.match(adminDashboardSource, /onRetry \? \(/);
  assert.match(adminDashboardSource, />\s*重试\s*</);
});

test('admin dashboard shows lightweight cleanup counts and keeps on-demand totals unknown', () => {
  assert.match(adminDashboardSource, /resourceCleanup/);
  assert.match(adminDashboardSource, /formatCleanupBacklogAge/);
  assert.match(adminDashboardSource, /按需扫描/);
  assert.match(adminDashboardSource, /resourceCleanup\.orphanCandidates === null/);
  assert.match(adminDashboardSource, /resourceCleanup\.v1Sites === null/);
});

test('admin deployment failure review exposes diagnostics context', () => {
  assert.match(adminDashboardSource, /deployment\.failureStage/);
  assert.match(adminDashboardSource, /deployment\.errorCode/);
  assert.match(siteDetailSource, /failureDiagnostics/);
  assert.match(siteDetailSource, /DeploymentDiagnostics/);
  assert.match(siteDetailSource, /deploymentFailureSummary/);
});

test('deployment failure review keeps full Provider diagnostics in site detail instead of the dashboard list', () => {
  assert.match(siteDetailSource, /deploymentProviderView\(diagnostics\.provider\)/);
  assert.doesNotMatch(adminDashboardSource, /deploymentProviderView/);
  assert.doesNotMatch(adminDashboardSource, /data-label="Provider"/);
});

test('admin deployment rows load and display a reusable trace timeline', () => {
  assert.match(adminDashboardSource, /<DeploymentTracePanel/);
  assert.match(adminDashboardSource, />\s*查看时间线\s*</);
  assert.match(deploymentTracePanelSource, /getAdminDeploymentTrace\(deploymentId\)/);
  assert.match(deploymentTracePanelSource, /mounted\.current = true/);
  assert.match(deploymentTracePanelSource, /state\.status === 'loading'/);
  assert.match(deploymentTracePanelSource, /state\.status === 'error'/);
  assert.match(deploymentTracePanelSource, /该部署没有阶段事件，仅可查看终态摘要/);
  assert.match(deploymentTracePanelSource, /\['错误说明', deployment\.errorMessage\]/);
  assert.match(deploymentTracePanelSource, /deploymentTraceEventView\(event\)/);
  assert.match(deploymentTracePanelSource, /\['Provider', view\.provider, view\.providerTitle\]/);
  assert.match(deploymentTracePanelSource, /\['清理', view\.cleanup/);
  assert.match(deploymentTracePanelSource, /Provider Request ID/);
  assert.match(stylesSource, /\.deployment-trace-table/);
  assert.match(stylesSource, /\.deployment-trace-impact/);
  assert.match(stylesSource, /\.admin-table \.deployment-trace-table td/);
  assert.match(stylesSource, /@media \(max-width: 900px\)[\s\S]*?\.deployment-trace-table tbody\s*\{[\s\S]*?display:\s*grid;/);
});

test('mobile admin deployment timeline overrides the generic table cell grid after it is declared', () => {
  const media640Start = stylesSource.indexOf('@media (max-width: 640px)');
  const media640Source = stylesSource.slice(media640Start, stylesSource.indexOf('@media (max-width: 520px)', media640Start));
  const genericCellRule = media640Source.lastIndexOf('.admin-table td {');
  const traceCellRule = media640Source.lastIndexOf('.admin-table .deployment-trace-row > td {');

  assert.ok(genericCellRule >= 0);
  assert.ok(traceCellRule > genericCellRule);
  assert.match(
    media640Source.slice(traceCellRule),
    /\.admin-table \.deployment-trace-row > td\s*\{[\s\S]*?display:\s*block;[\s\S]*?padding:\s*0;/
  );
  assert.match(
    media640Source.slice(traceCellRule),
    /\.admin-table \.deployment-trace-row > td::before\s*\{[\s\S]*?display:\s*none;/
  );
});

test('admin deep routes stay under the admin guard', () => {
  assert.match(appSource, /path="\/admin\/:page\/:resourceId"/);
  assert.match(appSource, /path="\/admin\/:page\/:resourceId\/:subpage"/);
  assert.match(appSource, /resourceId=\{resourceId\}/);
  assert.match(appSource, /subpage=\{subpage\}/);
});

test('admin detail tabs expose a clear active state', () => {
  assert.match(stylesSource, /\.detail-tabs a\s*\{[\s\S]*?border:\s*1px solid transparent;/);
  assert.match(
    stylesSource,
    /\.detail-tabs a:hover,[\s\S]*?\.detail-tabs a.active\s*\{[\s\S]*?border-color:\s*rgba\(243, 112, 34, 0\.28\);/
  );
  assert.match(stylesSource, /\.detail-tabs a.active\s*\{[\s\S]*?box-shadow:\s*inset 0 -2px 0 var\(--xd-orange\);/);
});
