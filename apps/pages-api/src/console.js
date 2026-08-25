import {
  consoleRequiresPlatformAdmin,
  isConsoleBffRequest,
  readOptionalConsoleUserSession,
  requireConsoleUserSession,
} from './console-auth.js';
import { departmentTeamDisplayName } from './department-path.js';
import { isSiteVisibility, teamOwnerSupportsVisibility } from './domain/sites/access-policy.js';
import { viewerCanAdminSite, viewerCanPublishSite } from './domain/sites/authorization.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { nextId } from './id.js';
import { buildSiteOwnerTransferAuditEvent } from './application/sites/build-owner-transfer-audit-event.js';
import { normalizeSiteSlug, rejectUserExposureMutation, validateSiteSlugInput } from './transport/shared/site-input.js';
import { createSiteCreationApplication, siteCreateErrorResponse } from './transport/shared/site-creation-application.js';
import { createSiteOwnershipApplication, siteTransferErrorResponse } from './transport/shared/site-ownership-application.js';
import {
  deleteConsoleSite,
  deleteSiteSecret,
  deleteSiteVar,
  putSiteSecret,
  putSiteVar,
  readSiteConfig,
  teamOwnerVisibilityUnsupported,
  updateSiteAccess,
  updateConsoleSiteMetadata,
} from './transport/console/site-mutations.js';
import {
  formatAclEntry,
  formatDeployment,
  formatDirectorySite,
  formatSiteDetail,
  formatWorkspaceSite,
} from './transport/console/site-projections.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';

export async function handleConsoleApi(request, env, config, store, ctx) {
  if (!isConsoleBffRequest(request)) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith(CONSOLE_PREFIX)) return null;

  if (url.pathname === `${CONSOLE_PREFIX}/auth/session`) {
    if (request.method !== 'GET') return methodNotAllowed();
    return validateConsoleAuthSession(request, env, config, store);
  }

  if (url.pathname === `${CONSOLE_PREFIX}/directory`) {
    if (request.method !== 'GET') return methodNotAllowed();
    const session = await readOptionalConsoleUserSession(request, env, config, store, {
      hydrateDepartment: true,
      includePlatformAdmin: consoleRequiresPlatformAdmin(request),
      requirePlatformAdmin: consoleRequiresPlatformAdmin(request),
    });
    if (session instanceof Response) return session;
    const sites = await store.listConsoleDirectorySites({
      environment: config.environment,
      viewerUserId: session?.userId || null,
    });
    return jsonOk({ sites: sites.map(formatDirectorySite) });
  }

  if (url.pathname === `${CONSOLE_PREFIX}/workspace/sites`) {
    const session = await requireConsoleUserSession(request, env, config, store);
    if (session instanceof Response) return session;
    if (request.method === 'POST') return createConsoleSite(request, env, config, store, session);
    if (request.method !== 'GET') return methodNotAllowed();
    const ownerFilter = url.searchParams.get('owner') === 'team' ? 'team' : 'personal';
    const teamId = ownerFilter === 'team' ? normalizeQueryValue(url.searchParams.get('teamId')) : null;
    const sites = await store.listWorkspaceSites({
      environment: config.environment,
      userId: session.userId,
      ownerFilter,
      teamId,
    });
    return jsonOk({ sites: sites.map(formatWorkspaceSite) });
  }

  const siteMetadataMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/sites\/([^/]+)\/metadata$/);
  if (siteMetadataMatch) {
    const session = await requireConsoleUserSession(request, env, config, store);
    if (session instanceof Response) return session;
    if (request.method !== 'PATCH') return methodNotAllowed();
    return updateConsoleSiteMetadata(request, env, config, store, session, decodeURIComponent(siteMetadataMatch[1]), { ctx });
  }

  const siteSettingsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/sites\/([^/]+)\/settings$/);
  if (siteSettingsMatch) {
    const session = await requireConsoleUserSession(request, env, config, store);
    if (session instanceof Response) return session;
    if (request.method !== 'PATCH') return methodNotAllowed();
    return updateConsoleSiteSettings(request, env, config, store, session, decodeURIComponent(siteSettingsMatch[1]));
  }

  const siteAccessMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/sites\/([^/]+)\/access$/);
  if (siteAccessMatch && request.method === 'PATCH') {
    const session = await requireConsoleUserSession(request, env, config, store);
    if (session instanceof Response) return session;
    return updateSiteAccess(request, env, config, store, session, siteAccessMatch[1], { ctx });
  }

  const siteVarMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/sites\/([^/]+)\/config\/vars\/([^/]+)$/);
  if (siteVarMatch) {
    const session = await requireConsoleUserSession(request, env, config, store);
    if (session instanceof Response) return session;
    if (request.method === 'PUT') {
      return putSiteVar(request, env, config, store, session, siteVarMatch[1], decodeURIComponent(siteVarMatch[2]));
    }
    if (request.method === 'DELETE') {
      return deleteSiteVar(env, config, store, session, siteVarMatch[1], decodeURIComponent(siteVarMatch[2]));
    }
    return methodNotAllowed();
  }

  const siteSecretMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/sites\/([^/]+)\/config\/secrets\/([^/]+)$/);
  if (siteSecretMatch) {
    const session = await requireConsoleUserSession(request, env, config, store);
    if (session instanceof Response) return session;
    if (request.method === 'PUT') {
      return putSiteSecret(request, env, config, store, session, siteSecretMatch[1], decodeURIComponent(siteSecretMatch[2]));
    }
    if (request.method === 'DELETE') {
      return deleteSiteSecret(env, config, store, session, siteSecretMatch[1], decodeURIComponent(siteSecretMatch[2]));
    }
    return methodNotAllowed();
  }

  const siteMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/sites\/([^/]+)(?:\/([^/]+))?$/);
  if (siteMatch) {
    const session = await requireConsoleUserSession(request, env, config, store);
    if (session instanceof Response) return session;

    const [, siteId, subresource] = siteMatch;
    const site = await store.getConsoleSiteDetail({
      environment: config.environment,
      userId: session.userId,
      siteId,
    });
    if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

    if (!subresource && request.method === 'DELETE') return deleteConsoleSite(env, config, store, site, { actor: session, ctx });
    if (request.method !== 'GET') return methodNotAllowed();
    if (!subresource) return jsonOk({ site: formatSiteDetail(site) });
    if (subresource === 'deployments') {
      const deployments = await store.listConsoleSiteDeployments({
        environment: config.environment,
        userId: session.userId,
        siteId,
      });
      return jsonOk({ deployments: deployments.map(formatDeployment) });
    }
    if (subresource === 'access') {
      const aclEntries = typeof store.listSiteAclEntries === 'function' ? await store.listSiteAclEntries(site.id) : [];
      return jsonOk({
        access: {
          visibility: site.route?.visibility || site.defaultVisibility,
          aclEntries: aclEntries.map(formatAclEntry),
        },
      });
    }
    if (subresource === 'config') {
      if (!viewerCanPublishSite(site)) {
        return jsonError('SITE_PUBLISHER_REQUIRED', 'Site publisher role required.', 403, 'Ask a site or team publisher.');
      }
      return readSiteConfig(env, config, store, site);
    }
    return null;
  }

  return null;
}

async function createConsoleSite(request, env, config, store, session) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  const slug = normalizeSiteSlug(body.slug);
  const visibility = body.visibility || 'org';
  const ownerType = body.ownerType === 'team' ? 'team' : 'user';
  const slugError = validateSiteSlugInput(slug, config.environment);
  if (slugError) return slugError;
  if (!isSiteVisibility(visibility)) {
    return jsonError(
      'SITE_VISIBILITY_INVALID',
      'Site visibility is invalid.',
      400,
      '请使用 internal、org、acl、owner 或 disabled。'
    );
  }
  if (!teamOwnerSupportsVisibility({ ownerType }, visibility)) return teamOwnerVisibilityUnsupported();

  let ownerId = session.userId;
  if (ownerType === 'team') {
    const teamId = normalizeRequiredString(body.teamId);
    if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
    const team = await store.getTeam(teamId);
    if (!team || team.environment !== config.environment || team.deletedAt || team.status !== 'active') {
      return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
    }
    const member = await store.getTeamMember({ teamId, userId: session.userId });
    if (!member) return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
    if (member.role !== 'admin' && member.role !== 'publisher') {
      return jsonError(
        'TEAM_PUBLISHER_REQUIRED',
        'Team publisher role required.',
        403,
        'Ask a team publisher to create the site.'
      );
    }
    ownerId = team.id;
  }

  let site;
  try {
    const result = await createSiteCreationApplication({ store, env, config }).create({
      environment: config.environment,
      slug,
      ownerType,
      ownerId,
      ownerUserId: session.userId,
      visibility,
      actor: { type: 'user', userId: session.userId },
      allowLegacyV1Takeover: false,
      includeRoute: false,
    });
    site = result.site;
  } catch (error) {
    const response = siteCreateErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const detail = await store.getConsoleSiteDetail({
    environment: config.environment,
    userId: session.userId,
    siteId: site.id,
  });
  return jsonOk({ site: formatWorkspaceSite(detail || site) }, 201);
}

async function updateConsoleSiteSettings(request, env, config, store, session, siteId) {
  if (typeof store.transferSiteOwner !== 'function') {
    return jsonError('SITE_TRANSFER_UNSUPPORTED', 'Site transfer is unavailable.', 503, 'Retry later.');
  }

  const site = await store.getConsoleSiteDetail({
    environment: config.environment,
    userId: session.userId,
    siteId,
  });
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (!viewerCanAdminSite(site)) {
    return jsonError(
      'SITE_ADMIN_REQUIRED',
      'Site owner or team admin role required.',
      403,
      'Use the personal owner account or a team admin account.'
    );
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const target = await resolveConsoleSiteOwnerTarget(store, config, session, body);
  if (target instanceof Response) return target;
  const currentVisibility = site.route?.visibility || site.defaultVisibility;
  if (!teamOwnerSupportsVisibility(target, currentVisibility)) return teamOwnerVisibilityUnsupported();

  let updated;
  let route;
  try {
    const result = await createSiteOwnershipApplication({ store, env })({
      environment: config.environment,
      site,
      actor: { type: 'user', userId: session.userId },
      target,
      buildAuditEvent: (updatedAt, currentSite) =>
        buildSiteOwnerTransferAuditEvent({
          id: nextId(env, 'aud'),
          environment: config.environment,
          actor: { type: 'user', userId: session.userId },
          site: currentSite,
          target,
          source: 'console',
          createdAt: updatedAt,
        }),
      compensateSnapshotFailure: true,
    });
    updated = result.site;
    route = result.route;
  } catch (error) {
    return siteTransferErrorResponse(error);
  }

  const visible = await store.getConsoleSiteDetail({
    environment: config.environment,
    userId: session.userId,
    siteId: updated.id,
  });
  if (visible) return jsonOk({ site: formatSiteDetail(visible) });

  return jsonOk({
    site: formatSiteDetail({
      ...updated,
      route,
      currentUserId: session.userId,
      managementRole: null,
      ownerDisplayName: target.displayName,
      ownerEmail: target.email || null,
      ownerTeamType: target.teamType || null,
      ownerDepartmentPath: target.departmentPath || null,
    }),
  });
}

async function resolveConsoleSiteOwnerTarget(store, config, session, body) {
  const ownerType = body?.ownerType === 'team' || body?.ownerType === 'user' ? body.ownerType : '';
  if (!ownerType) {
    return jsonError('SITE_TRANSFER_INVALID', 'Site transfer target is invalid.', 400, 'Use ownerType user or team.');
  }

  if (ownerType === 'user') {
    const ownerId = normalizeRequiredString(body.ownerId || body.userId);
    if (!ownerId) return jsonError('SITE_TRANSFER_INVALID', 'Site transfer target is invalid.', 400, 'Choose a user.');
    const user = typeof store.getUser === 'function' ? await store.getUser(ownerId) : null;
    if (!isActiveConsoleUser(user)) {
      return jsonError('SITE_TRANSFER_FORBIDDEN', 'Target user is not active.', 403, 'Choose an active user.');
    }
    return {
      ownerType: 'user',
      ownerId: user.id,
      ownerUserId: user.id,
      displayName: user.realname || user.email || user.account || user.id,
      email: user.email || null,
    };
  }

  const teamId = normalizeRequiredString(body.teamId || body.ownerId);
  if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
  const team = typeof store.getTeam === 'function' ? await store.getTeam(teamId) : null;
  if (!team || team.environment !== config.environment || team.deletedAt || team.status !== 'active') {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  const member =
    typeof store.getTeamMember === 'function' ? await store.getTeamMember({ teamId: team.id, userId: session.userId }) : null;
  if (!member || (member.role !== 'admin' && member.role !== 'publisher')) {
    return jsonError(
      'SITE_TRANSFER_FORBIDDEN',
      'Team publisher role required.',
      403,
      'Choose a team where you are publisher or admin.'
    );
  }
  return {
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: session.userId,
    displayName: departmentTeamDisplayName(team) || team.departmentPath || team.id,
    teamType: team.teamType || null,
    departmentPath: team.departmentPath || null,
    role: member.role,
  };
}

function isActiveConsoleUser(user) {
  return Boolean(user?.id) && user.employeeStatus === 'active';
}

async function validateConsoleAuthSession(request, env, config, store) {
  const session = await requireConsoleUserSession(request, env, config, store, {
    hydrateDepartment: true,
    includePlatformAdmin: true,
  });
  if (session instanceof Response) return session;
  return jsonOk({
    session: {
      userId: session.userId,
      email: session.email,
      realname: session.user?.realname || null,
      departmentPath: session.user?.departmentPath || null,
      employeeStatus: session.employeeStatus,
      sessionVersion: session.sessionVersion,
      isPlatformAdmin: session.isPlatformAdmin,
    },
  });
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}

function normalizeRequiredString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeQueryValue(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}
