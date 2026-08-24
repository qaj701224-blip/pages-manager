import { accessModeFromVisibility } from '@xd/pages-access-policy';

import {
  projectAdminSiteDetail as formatAdminSiteDetail,
  projectAdminTeamMember as formatAdminTeamMember,
} from '../../application/governance/list-admin-resources.js';
import {
  deleteConsoleSite,
  deleteSiteSecret,
  deleteSiteVar,
  putSiteSecret,
  putSiteVar,
  readSiteConfig,
  updateSiteAccess,
} from './site-mutations.js';
import { formatAclEntry } from './site-projections.js';
import { isConsoleBffRequest, requireConsoleUserSession } from '../../console-auth.js';
import { jsonError, jsonOk } from '../../http.js';
import { handleConsoleAdminWebhooksApi } from '../../webhooks.js';
import {
  formatAdminDeployment,
  getAdminDeploymentTrace,
  getAdminDeploymentTraceByTraceId,
  getAdminSite,
  getAdminTeam,
  getAdminTeamRecord,
  grantPlatformAdmin,
  listAdminSites,
  listAdminTeams,
  listAdminUsers,
  listAuditEvents,
  listPlatformAdmins,
  mergeDepartmentTeam,
  readAdminSitePublicExposureReason,
  removeAdminTeamMember,
  revokePlatformAdmin,
  updateAdminSiteExposure,
  updateAdminSiteSettings,
  updateAdminTeamMember,
  updateAdminTeamSettings,
  deleteAdminTeam,
} from './admin-resources.js';
import {
  bulkRetireAdminV1Sites,
  listAdminV1Sites,
  retireAdminV1Site,
} from './admin-v1-governance.js';
import {
  backfillAdminWorkerOrphans,
  bulkDeleteAdminNormalWorkers,
  deleteAdminNormalWorker,
  getAdminDashboard,
  getAdminOps,
  listAdminNormalWorkers,
  listDeploymentCleanups,
  runDeploymentCleanupTask,
  runDueDeploymentCleanupsAdmin,
  scanAdminWorkerOrphans,
} from './admin-worker-governance.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';

export async function handleConsoleAdminApi(request, env, config, store, ctx) {
  if (!isConsoleBffRequest(request)) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${CONSOLE_PREFIX}/admin`)) return null;

  const session = await requireConsoleUserSession(request, env, config, store, { requirePlatformAdmin: true });
  if (session instanceof Response) return session;

  const webhooksResponse = await handleConsoleAdminWebhooksApi(request, env, config, store, session);
  if (webhooksResponse) return webhooksResponse;

  if (url.pathname === `${CONSOLE_PREFIX}/admin/dashboard`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminDashboard(env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/ops`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminOps(config);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/deployment-cleanups`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listDeploymentCleanups(url, env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/deployment-cleanups/run-due`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return runDueDeploymentCleanupsAdmin(request, env, config, store, session);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/worker-orphan-scan`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return scanAdminWorkerOrphans(env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/worker-orphan-scan/backfill`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return backfillAdminWorkerOrphans(request, env, config, store, session);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/v1-sites`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminV1Sites(env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/v1-sites/bulk-retire`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return bulkRetireAdminV1Sites(request, env, config, store, session);
  }

  const adminV1SiteMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/v1-sites\/([^/]+)$/);
  if (adminV1SiteMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return retireAdminV1Site(env, config, store, session, decodeURIComponent(adminV1SiteMatch[1]));
  }

  const cleanupRunMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/deployment-cleanups\/([^/]+)\/run$/);
  if (cleanupRunMatch) {
    if (request.method !== 'POST') return methodNotAllowed();
    return runDeploymentCleanupTask(env, config, store, session, decodeURIComponent(cleanupRunMatch[1]));
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/normal-workers`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminNormalWorkers(config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/normal-workers/bulk-delete`) {
    if (request.method !== 'POST') return methodNotAllowed();
    return bulkDeleteAdminNormalWorkers(request, env, config, store, session);
  }

  const adminNormalWorkerMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/normal-workers\/([^/]+)$/);
  if (adminNormalWorkerMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return deleteAdminNormalWorker(request, env, config, store, session, decodeURIComponent(adminNormalWorkerMatch[1]));
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/users`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminUsers(url, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/sites`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminSites(url, config, store);
  }

  const adminDeploymentTraceMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/deployments\/([^/]+)\/trace$/);
  if (adminDeploymentTraceMatch) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminDeploymentTrace(config, store, decodeURIComponent(adminDeploymentTraceMatch[1]));
  }

  const adminTraceIdMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/deployment-traces\/([^/]+)$/);
  if (adminTraceIdMatch) {
    if (request.method !== 'GET') return methodNotAllowed();
    return getAdminDeploymentTraceByTraceId(config, store, decodeURIComponent(adminTraceIdMatch[1]));
  }

  const adminSiteVarMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/config\/vars\/([^/]+)$/);
  if (adminSiteVarMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteVarMatch[1]));
    if (site instanceof Response) return site;
    const name = decodeURIComponent(adminSiteVarMatch[2]);
    if (request.method === 'PUT') return putSiteVar(request, env, config, store, session, site.id, name, { site });
    if (request.method === 'DELETE') return deleteSiteVar(env, config, store, session, site.id, name, { site });
    return methodNotAllowed();
  }

  const adminSiteSecretMatch = url.pathname.match(
    /^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/config\/secrets\/([^/]+)$/
  );
  if (adminSiteSecretMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteSecretMatch[1]));
    if (site instanceof Response) return site;
    const name = decodeURIComponent(adminSiteSecretMatch[2]);
    if (request.method === 'PUT') return putSiteSecret(request, env, config, store, session, site.id, name, { site });
    if (request.method === 'DELETE') return deleteSiteSecret(env, config, store, session, site.id, name, { site });
    return methodNotAllowed();
  }

  const adminSiteAccessMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/access$/);
  if (adminSiteAccessMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteAccessMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'PATCH') return updateSiteAccess(request, env, config, store, session, site.id, { site, ctx });
    if (request.method !== 'GET') return methodNotAllowed();
    const aclEntries = typeof store.listSiteAclEntries === 'function' ? await store.listSiteAclEntries(site.id) : [];
    const exposure = site.route?.exposure || site.defaultExposure || 'internal';
    const exposureReason = await readAdminSitePublicExposureReason(env, store, config, site, exposure);
    return jsonOk({
      access: {
        exposure,
        accessMode: site.route?.accessMode || accessModeFromVisibility(site.route?.visibility || site.defaultVisibility),
        visibility: site.route?.visibility || site.defaultVisibility,
        aclEntries: aclEntries.map(formatAclEntry),
        exposureReason,
      },
    });
  }

  const adminSiteExposureMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/exposure$/);
  if (adminSiteExposureMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteExposureMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'PATCH') return updateAdminSiteExposure(request, env, config, store, session, site);
    if (request.method !== 'GET') return methodNotAllowed();
    const route = await store.getRouteBySiteId(site.id, config.environment);
    return jsonOk({
      access: {
        exposure: route?.exposure || site.defaultExposure || 'internal',
        accessMode: route?.accessMode || accessModeFromVisibility(route?.visibility || site.defaultVisibility),
        visibility: route?.visibility || site.defaultVisibility,
      },
    });
  }

  const adminSiteDeploymentsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/deployments$/);
  if (adminSiteDeploymentsMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteDeploymentsMatch[1]));
    if (site instanceof Response) return site;
    if (request.method !== 'GET') return methodNotAllowed();
    const deployments =
      typeof store.listAdminSiteDeployments === 'function'
        ? await store.listAdminSiteDeployments({ environment: config.environment, siteId: site.id })
        : [];
    return jsonOk({ deployments: deployments.map(formatAdminDeployment) });
  }

  const adminSiteConfigMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/config$/);
  if (adminSiteConfigMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteConfigMatch[1]));
    if (site instanceof Response) return site;
    if (request.method !== 'GET') return methodNotAllowed();
    return readSiteConfig(env, config, store, site);
  }

  const adminSiteSettingsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)\/settings$/);
  if (adminSiteSettingsMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteSettingsMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'PATCH') return updateAdminSiteSettings(request, env, config, store, session, site);
    return methodNotAllowed();
  }

  const adminSiteMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/sites\/([^/]+)$/);
  if (adminSiteMatch) {
    const site = await getAdminSite(config, store, decodeURIComponent(adminSiteMatch[1]));
    if (site instanceof Response) return site;
    if (request.method === 'GET') return jsonOk({ site: formatAdminSiteDetail(site) });
    if (request.method === 'DELETE') return deleteConsoleSite(env, config, store, site, { force: true, actor: session, ctx });
    return methodNotAllowed();
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/teams`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAdminTeams(url, config, store);
  }

  const adminTeamSettingsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/settings$/);
  if (adminTeamSettingsMatch) {
    if (request.method !== 'PATCH') return methodNotAllowed();
    return updateAdminTeamSettings(request, config, store, decodeURIComponent(adminTeamSettingsMatch[1]));
  }

  const adminTeamMemberMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (adminTeamMemberMatch) {
    const teamId = decodeURIComponent(adminTeamMemberMatch[1]);
    const userId = decodeURIComponent(adminTeamMemberMatch[2]);
    if (request.method === 'PATCH') return updateAdminTeamMember(request, config, store, session, teamId, userId);
    if (request.method === 'DELETE') return removeAdminTeamMember(config, store, session, teamId, userId);
    return methodNotAllowed();
  }

  const adminTeamMembersMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/members$/);
  if (adminTeamMembersMatch) {
    const team = await getAdminTeamRecord(config, store, decodeURIComponent(adminTeamMembersMatch[1]));
    if (team instanceof Response) return team;
    if (request.method !== 'GET') return methodNotAllowed();
    const members = typeof store.listTeamMembers === 'function' ? await store.listTeamMembers({ teamId: team.id }) : [];
    return jsonOk({ members: members.map(formatAdminTeamMember) });
  }

  const adminTeamMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)$/);
  if (adminTeamMatch) {
    const teamId = decodeURIComponent(adminTeamMatch[1]);
    if (request.method === 'GET') return getAdminTeam(config, store, teamId);
    if (request.method === 'DELETE') return deleteAdminTeam(config, store, session, teamId);
    return methodNotAllowed();
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/audit`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listAuditEvents(config, store);
  }

  const teamMergeMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/teams\/([^/]+)\/merge$/);
  if (teamMergeMatch) {
    if (request.method !== 'POST') return methodNotAllowed();
    return mergeDepartmentTeam(request, config, store, session, decodeURIComponent(teamMergeMatch[1]));
  }

  if (url.pathname === `${CONSOLE_PREFIX}/admin/platform-admins`) {
    if (request.method === 'GET') return listPlatformAdmins(config, store);
    if (request.method === 'POST') return grantPlatformAdmin(request, config, store, session);
    return methodNotAllowed();
  }

  const platformAdminMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/platform-admins\/([^/]+)$/);
  if (platformAdminMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed();
    return revokePlatformAdmin(request, config, store, session, decodeURIComponent(platformAdminMatch[1]));
  }

  return null;
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
