import {
  consoleRequiresPlatformAdmin,
  isConsoleBffRequest,
  readOptionalConsoleUserSession,
  requireConsoleUserSession,
} from './console-auth.js';
import { departmentTeamDisplayName } from './department-path.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newHexId, newId } from './id.js';
import { MAX_SITE_SECRET_VALUE_BYTES, normalizeRuntimeSecretName, normalizeRuntimeVars } from './runtime-config.js';
import {
  hostnameForSlug,
  normalizeSlug,
  normalizeAclEntries,
  refreshActiveRouteSnapshot,
  refreshCurrentRouteSnapshot,
  restoreSiteAclAfterSnapshotFailure,
  restoreSiteVisibilityAfterSnapshotFailure,
  buildSiteOwnerTransferAuditEvent,
  siteCreateErrorResponse,
  syncActiveWfpSecret,
  validateSlug,
} from './sites.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';
const DEFAULT_REUSE_HOLD_SECONDS = 300;
const VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);

export async function handleConsoleApi(request, env, config, store) {
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
    return updateSiteAccess(request, env, config, store, session, siteAccessMatch[1]);
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

    if (!subresource && request.method === 'DELETE') return deleteConsoleSite(env, config, store, site);
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
      return jsonOk({ config: await readSiteConfig(store, config.environment, site.id) });
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

  const slug = normalizeSlug(body.slug);
  const visibility = body.visibility || 'org';
  const ownerType = body.ownerType === 'team' ? 'team' : 'user';
  const slugError = validateSlug(slug, config.environment);
  if (slugError) return slugError;
  if (!VISIBILITIES.has(visibility)) {
    return jsonError(
      'SITE_VISIBILITY_INVALID',
      'Site visibility is invalid.',
      400,
      '请使用 internal、org、acl、owner 或 disabled。'
    );
  }
  if (ownerType === 'team' && visibility === 'owner') return teamOwnerVisibilityUnsupported();

  let ownerId = session.userId;
  if (ownerType === 'team') {
    const teamId = normalizeRequiredString(body.teamId);
    if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
    const team = await store.getTeam(teamId);
    if (!team || team.environment !== config.environment) {
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
    site = await store.createSite({
      id: nextId(env, 'site'),
      slug,
      ownerType,
      ownerId,
      ownerUserId: session.userId,
      siteUuid: nextSiteUuid(env),
      defaultVisibility: visibility,
      environment: config.environment,
      routeId: nextId(env, 'route'),
      hostname: hostnameForSlug(slug, config),
    });
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

export async function deleteConsoleSite(env, config, store, site, options = {}) {
  if (!options.force && !hasPublisherRole(site)) {
    return jsonError(
      'SITE_DELETE_FORBIDDEN',
      'Site publisher role required.',
      403,
      'Use the site owner account or a team publisher/admin account.'
    );
  }

  const deletedAt = readNow(env);
  const reuseHoldUntil = addSecondsIso(deletedAt, readReuseHoldSeconds(env));
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));
  const shouldWriteDeletedSnapshot = routeWasActive(previousRoute);
  const deleted = await store.deleteSite(
    site.id,
    {
      deletedAt,
      reuseHoldUntil,
      releaseReason: 'site_deleted',
    },
    config.environment
  );
  if (!deleted) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  const route = await store.getRouteBySiteId(site.id, config.environment);
  if (shouldWriteDeletedSnapshot) {
    const snapshotError = await refreshCurrentRouteSnapshot(env, store, deleted, route, config.environment);
    if (snapshotError) return snapshotError;
  }
  return jsonOk({ site: formatWorkspaceSite({ ...deleted, route }) });
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
  if (!hasPublisherRole(site)) {
    return jsonError(
      'SITE_PUBLISHER_REQUIRED',
      'Site publisher role required.',
      403,
      'Use the site owner account or a team publisher/admin account.'
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
  if (target.ownerType === 'team' && currentVisibility === 'owner') return teamOwnerVisibilityUnsupported();

  const updatedAt = readNow(env);
  const updated = await store.transferSiteOwner(
    site.id,
    {
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      ownerUserId: target.ownerUserId,
      updatedAt,
      auditEvent: buildSiteOwnerTransferAuditEvent(env, config, { type: 'user', userId: session.userId }, site, target, {
        source: 'console',
        createdAt: updatedAt,
      }),
    },
    config.environment
  );
  if (!updated) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

  const route = await store.getRouteBySiteId(updated.id, config.environment);
  const snapshotError = await refreshActiveRouteSnapshot(env, store, updated, route, config.environment);
  if (snapshotError) return snapshotError;

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

export async function updateSiteAccess(request, env, config, store, session, siteId, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
  if (site instanceof Response) return site;
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));
  const previousAclEntries = await store.listSiteAclEntries(site.id);

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const visibility = typeof body.visibility === 'string' ? body.visibility : site.route?.visibility || site.defaultVisibility;
  if (!VISIBILITIES.has(visibility)) {
    return jsonError(
      'SITE_VISIBILITY_INVALID',
      'Site visibility is invalid.',
      400,
      '请使用 internal、org、acl、owner 或 disabled。'
    );
  }
  if (site.ownerType === 'team' && visibility === 'owner') return teamOwnerVisibilityUnsupported();
  const aclEntries = 'aclEntries' in body ? normalizeAclEntries(body.aclEntries, env) : previousAclEntries;
  if (aclEntries instanceof Response) return aclEntries;

  const route = await store.updateSiteVisibility(
    site.id,
    {
      visibility,
      updatedAt: readNow(env),
    },
    config.environment
  );
  const nextAclEntries = Array.isArray(body.aclEntries)
    ? await store.replaceSiteAclEntries(
        site.id,
        aclEntries,
        {
          createdBy: session.userId,
          updatedAt: readNow(env),
        },
        config.environment
      )
    : previousAclEntries;

  const snapshotError = await refreshActiveRouteSnapshot(env, store, site, route, config.environment);
  if (snapshotError) {
    await restoreSiteVisibilityAfterSnapshotFailure(store, site.id, site, previousRoute, route, config.environment);
    await restoreSiteAclAfterSnapshotFailure(store, site.id, previousAclEntries, previousRoute, site, route, config.environment);
    return snapshotError;
  }

  return jsonOk({
    access: {
      visibility: route.visibility,
      aclEntries: nextAclEntries.map(formatAclEntry),
    },
  });
}

export async function putSiteVar(request, env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
  if (site instanceof Response) return site;
  if (typeof store.replaceSiteVars !== 'function' || typeof store.listEnabledSiteVars !== 'function') {
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime config store is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const vars = await nextVarsForPut(store, config.environment, site.id, name, body.value);
  if (vars instanceof Response) return vars;
  const records = await replaceSiteVars(store, env, config, session, site.id, vars);
  const record = records.find((item) => item.name === name);
  return jsonOk({ var: formatSiteVarMutation(record) });
}

export async function deleteSiteVar(env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
  if (site instanceof Response) return site;
  if (typeof store.replaceSiteVars !== 'function' || typeof store.listEnabledSiteVars !== 'function') {
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime config store is unavailable.', 503, 'Retry later.');
  }

  const vars = await nextVarsForDelete(store, config.environment, site.id, name);
  if (vars instanceof Response) return vars;
  await replaceSiteVars(store, env, config, session, site.id, vars);
  return jsonOk({ var: formatDeletedSiteVarMutation(name) });
}

export async function putSiteSecret(request, env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
  if (site instanceof Response) return site;
  if (typeof store.putSiteSecretWithAudit !== 'function') {
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime secret store is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const normalizedName = normalizeSecretNameForResponse(name);
  if (normalizedName instanceof Response) return normalizedName;
  if (typeof body.value !== 'string' || body.value.length === 0) {
    return jsonError('SECRET_VALUE_INVALID', 'Secret value is invalid.', 400, 'Send a non-empty string value.');
  }
  if (byteLength(body.value) > MAX_SITE_SECRET_VALUE_BYTES) {
    return jsonError('SECRET_VALUE_TOO_LARGE', 'Secret value is too large.', 413, 'Use a secret value no larger than 8 KiB.');
  }

  try {
    const secret = await store.putSiteSecretWithAudit({
      id: nextId(env, 'sec'),
      environment: config.environment,
      siteId: site.id,
      siteSlug: site.slug,
      name: normalizedName,
      value: body.value,
      actorId: session.userId,
      actorType: 'user',
      routeId: site.route?.id || null,
      auditId: nextId(env, 'aud'),
      updatedAt: readNow(env),
    });
    const syncError = await syncActiveWfpSecret(store, env, config, site, {
      operation: 'put',
      name: normalizedName,
      value: body.value,
    });
    if (syncError) return syncError;
    return jsonOk({ secret: formatSiteSecret(secret) });
  } catch (error) {
    if (isRuntimeConfigConflict(error)) {
      return jsonError(
        'RUNTIME_CONFIG_CHANGED',
        'Runtime secret changed while it was being updated.',
        409,
        'Retry the secret command.'
      );
    }
    return jsonError(
      'RUNTIME_CONFIG_UNSUPPORTED',
      'Runtime secret store is unavailable.',
      503,
      'Check runtime secret store configuration.'
    );
  }
}

export async function deleteSiteSecret(env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
  if (site instanceof Response) return site;
  if (typeof store.deleteSiteSecretWithAudit !== 'function') {
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime secret store is unavailable.', 503, 'Retry later.');
  }
  const normalizedName = normalizeSecretNameForResponse(name);
  if (normalizedName instanceof Response) return normalizedName;

  try {
    await store.deleteSiteSecretWithAudit({
      environment: config.environment,
      siteId: site.id,
      siteSlug: site.slug,
      name: normalizedName,
      actorId: session.userId,
      actorType: 'user',
      routeId: site.route?.id || null,
      auditId: nextId(env, 'aud'),
      deletedAt: readNow(env),
    });
    const syncError = await syncActiveWfpSecret(store, env, config, site, {
      operation: 'delete',
      name: normalizedName,
    });
    if (syncError) return syncError;
    return jsonOk({ secret: { name: normalizedName, deleted: true } });
  } catch (error) {
    if (isRuntimeConfigConflict(error)) {
      return jsonError(
        'RUNTIME_CONFIG_CHANGED',
        'Runtime secret changed while it was being deleted.',
        409,
        'Retry the secret command.'
      );
    }
    return jsonError(
      'RUNTIME_CONFIG_UNSUPPORTED',
      'Runtime secret store is unavailable.',
      503,
      'Check runtime secret store configuration.'
    );
  }
}

export async function readSiteConfig(store, environment, siteId) {
  const vars = typeof store.listEnabledSiteVars === 'function' ? await store.listEnabledSiteVars(environment, siteId) : [];
  const secrets =
    typeof store.listEnabledSiteSecrets === 'function' ? await store.listEnabledSiteSecrets(environment, siteId) : [];
  return {
    vars: vars.map(formatSiteVar),
    secrets: secrets.map(formatSiteSecret),
  };
}

async function requireConsoleSiteRole(store, config, session, siteId, role) {
  const site = await store.getConsoleSiteDetail({
    environment: config.environment,
    userId: session.userId,
    siteId,
  });
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (role === 'admin' && !hasAdminRole(site)) {
    return jsonError('SITE_ADMIN_REQUIRED', 'Site admin role required.', 403, 'Ask a site or team admin to perform this action.');
  }
  if (role === 'publisher' && !hasPublisherRole(site)) {
    return jsonError('SITE_PUBLISHER_REQUIRED', 'Site publisher role required.', 403, 'Ask a site or team publisher.');
  }
  return site;
}

function formatDirectorySite(site) {
  return {
    id: site.id,
    slug: site.slug,
    hostname: site.route?.hostname || site.hostname || null,
    owner: formatOwner(site, { includeDisplayName: true }),
    visibility: site.route?.visibility || site.defaultVisibility,
    status: site.route?.routeStatus || 'active',
  };
}

function formatWorkspaceSite(site) {
  return {
    id: site.id,
    slug: site.slug,
    hostname: site.route?.hostname || site.hostname || null,
    owner: formatOwner(site, { includeDisplayName: true }),
    visibility: site.route?.visibility || site.defaultVisibility,
    status: site.route?.routeStatus || 'active',
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function formatSiteDetail(site) {
  return {
    ...formatWorkspaceSite(site),
    owner: formatOwner(site, { includeDisplayName: true, includeId: true, includeEmail: true }),
    access: {
      visibility: site.route?.visibility || site.defaultVisibility,
    },
    permissions: {
      role: site.managementRole || (site.ownerUserId === site.currentUserId ? 'admin' : 'viewer'),
      canManage: canManageSite(site.managementRole) || site.ownerUserId === site.currentUserId,
      canManageAccess: canManageSite(site.managementRole) || site.ownerUserId === site.currentUserId,
    },
  };
}

function formatOwner(site, { includeDisplayName, includeId = false, includeEmail = false }) {
  const type = site.ownerType || 'user';
  const owner = { type };
  if (includeId) owner.id = site.ownerId || site.ownerUserId || null;
  if (includeEmail && type === 'user' && site.ownerEmail) owner.email = site.ownerEmail;
  if (includeDisplayName && site.ownerDisplayName) owner.displayName = site.ownerDisplayName;
  if (type === 'team' && site.ownerTeamType) owner.teamType = site.ownerTeamType;
  return owner;
}

function canManageSite(role) {
  return role === 'admin' || role === 'publisher';
}

function formatDeployment(deployment) {
  return {
    id: deployment.id,
    status: deployment.status,
    source: deployment.source || null,
    operation: deployment.operation || null,
    createdAt: deployment.createdAt,
    completedAt: deployment.completedAt || null,
  };
}

export function formatAclEntry(entry) {
  return {
    id: entry.id,
    subjectType: entry.subjectType,
    subjectValue: entry.subjectValue,
    accessRole: entry.accessRole,
    effect: entry.effect,
    createdAt: entry.createdAt,
  };
}

function formatSiteVar(record) {
  return {
    name: record.name,
    value: record.value,
    revision: Number(record.revision || 0),
    updatedAt: record.updatedAt,
  };
}

function formatSiteVarMutation(record) {
  return {
    ...formatSiteVar(record),
    appliesTo: 'next_deployment',
  };
}

function formatDeletedSiteVarMutation(name) {
  return {
    name,
    deleted: true,
    appliesTo: 'next_deployment',
  };
}

function formatSiteSecret(record) {
  return {
    name: record.name,
    revision: Number(record.revision || 0),
    updatedAt: record.updatedAt,
  };
}

async function nextVarsForPut(store, environment, siteId, name, value) {
  const normalized = normalizeVarPatch(name, value);
  if (normalized instanceof Response) return normalized;
  const vars = await currentVarsObject(store, environment, siteId);
  vars[normalized.name] = normalized.value;
  return vars;
}

async function nextVarsForDelete(store, environment, siteId, name) {
  const normalized = normalizeVarName(name);
  if (normalized instanceof Response) return normalized;
  const vars = await currentVarsObject(store, environment, siteId);
  delete vars[normalized];
  return vars;
}

async function currentVarsObject(store, environment, siteId) {
  const records = await store.listEnabledSiteVars(environment, siteId);
  return Object.fromEntries(records.map((record) => [record.name, record.value]));
}

async function replaceSiteVars(store, env, config, session, siteId, vars) {
  return store.replaceSiteVars({
    environment: config.environment,
    siteId,
    vars,
    actorId: session.userId,
    updatedAt: readNow(env),
    createId: (name) => nextId(env, `var${name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'runtime'}`),
  });
}

function normalizeVarPatch(name, value) {
  if (typeof value !== 'string') {
    return jsonError('RUNTIME_VAR_VALUE_INVALID', 'Runtime var value is invalid.', 400, 'Send a string value.');
  }
  try {
    const normalized = normalizeRuntimeVars({ [name]: value });
    const normalizedName = Object.keys(normalized)[0];
    return { name: normalizedName, value: normalized[normalizedName] };
  } catch (error) {
    return runtimeVarError(error);
  }
}

function normalizeVarName(name) {
  try {
    const normalized = normalizeRuntimeVars({ [name]: '' });
    return Object.keys(normalized)[0];
  } catch (error) {
    return runtimeVarError(error);
  }
}

function runtimeVarError(error) {
  if (error?.message === 'RUNTIME_VARS_LIMIT_EXCEEDED') {
    return jsonError('RUNTIME_VARS_LIMIT_EXCEEDED', 'Runtime vars limit exceeded.', 413, 'Use fewer or smaller vars.');
  }
  if (error?.message === 'RUNTIME_BINDING_NAME_RESERVED') {
    return jsonError(
      'RUNTIME_BINDING_NAME_RESERVED',
      'Runtime binding name is reserved.',
      400,
      'Use an application-specific name.'
    );
  }
  return jsonError('RUNTIME_VAR_INVALID', 'Runtime var is invalid.', 400, 'Use an uppercase non-sensitive binding name.');
}

function normalizeSecretNameForResponse(value) {
  try {
    return normalizeRuntimeSecretName(value);
  } catch (error) {
    if (error?.message === 'RUNTIME_BINDING_NAME_RESERVED') {
      return jsonError(
        'RUNTIME_BINDING_NAME_RESERVED',
        'Runtime binding name is reserved.',
        400,
        'Use an application-specific name.'
      );
    }
    return jsonError('SECRET_NAME_INVALID', 'Secret name is invalid.', 400, 'Use a valid Worker binding name such as API_TOKEN.');
  }
}

function hasPublisherRole(site) {
  if (site.ownerType === 'user') return site.ownerId === site.currentUserId || site.ownerUserId === site.currentUserId;
  return site.managementRole === 'admin' || site.managementRole === 'publisher';
}

function hasAdminRole(site) {
  if (site.ownerType === 'user') return site.ownerId === site.currentUserId || site.ownerUserId === site.currentUserId;
  return site.managementRole === 'admin';
}

function routeWasActive(route) {
  return route?.routeStatus === 'active' && Boolean(route.activeVersionId);
}

function byteLength(value) {
  return new globalThis.TextEncoder().encode(String(value)).byteLength;
}

function isRuntimeConfigConflict(error) {
  return String(error?.message || error).includes('SITE_SECRET_REVISION_CONFLICT');
}

function teamOwnerVisibilityUnsupported() {
  return jsonError(
    'SITE_VISIBILITY_INVALID',
    'Team-owned sites cannot use owner visibility.',
    400,
    '团队站点请使用 internal、org、acl 或 disabled。'
  );
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  return newId(prefix);
}

function nextSiteUuid(env) {
  if (typeof env?.nextSiteUuid === 'function') {
    const id = env.nextSiteUuid();
    if (id) return id;
  }
  return newHexId();
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function readReuseHoldSeconds(env) {
  const value = Number(env?.HOSTNAME_REUSE_HOLD_SECONDS || DEFAULT_REUSE_HOLD_SECONDS);
  if (!Number.isInteger(value) || value < 0 || value > 86_400) return DEFAULT_REUSE_HOLD_SECONDS;
  return value;
}

function addSecondsIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
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
