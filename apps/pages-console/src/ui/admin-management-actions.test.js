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

test('admin failed deployments show owner context', () => {
  assert.match(adminDashboardSource, /adminSiteOwnerView\(deployment\.owner\)/);
  assert.match(adminDashboardSource, /<th>归属<\/th>/);
  assert.match(adminDashboardSource, /data-label="归属"/);
  assert.match(adminDashboardSource, /deployment\.siteSlug \|\| deployment\.siteId/);
  assert.doesNotMatch(adminDashboardSource, /<td data-label="站点">\{deployment\.siteId\}<\/td>/);
});

test('admin site management exposes a safe detail action', () => {
  assert.match(adminSitesSource, /<th>操作<\/th>/);
  assert.match(adminSitesSource, /to=\{`\/admin\/sites\/\$\{encodeURIComponent\(site\.id\)\}`\}/);
  assert.doesNotMatch(adminSitesSource, /\/workspace\/sites/);
  assert.match(adminSitesSource, />\s*查看详情\s*<\/Link>/);
});

test('admin site management displays and filters the active deployment shape', () => {
  assert.match(adminSitesSource, /<th>站点类型<\/th>/);
  assert.match(adminSitesSource, /aria-label="站点类型"/);
  assert.match(adminSitesSource, /siteDeploymentShapeLabel\(site\.deploymentShape\)/);
  assert.match(adminSitesSource, /filterAdminSites\(state\.sites, \{ query, ownerType, status, deploymentShape \}\)/);
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
  assert.match(adminDeploymentCleanupsSource, /<AppTabs\.Content forceMount value="orphan-scan">/);
  assert.match(adminDeploymentCleanupsSource, /filterWorkerOrphanScanWorkers/);
  assert.match(adminDeploymentCleanupsSource, /orphanReason/);
  assert.doesNotMatch(adminDeploymentCleanupsSource, /deleteAdminWorkerOrphan|cleanupOrphanWorker/);
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
  assert.doesNotMatch(adminV1SitesSource, /\.metadata|token|delete/i);
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
