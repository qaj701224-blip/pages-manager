import { validateSiteSlug } from '@xd/pages-runtime-protocol';

import { authenticateApiRequest } from './auth.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newHexId, newId } from './id.js';
import { MAX_SITE_SECRET_VALUE_BYTES, normalizeRuntimeSecretName } from './runtime-config.js';
import { buildRouteSnapshot, writeRouteSnapshot } from './route-snapshot.js';
import { createDeploymentProvider as createWfpDeploymentProvider } from './wfp-provider.js';

const VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const ACL_SUBJECT_TYPES = new Set(['email', 'department']);
const ACL_ACCESS_ROLES = new Set(['viewer']);
const MAX_ACL_ENTRIES = 200;
const VISIBILITY_ACTION = '请使用 internal、org、acl、owner 或 disabled。';
const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Cell 平台保留项，请换一个业务站点名。';
const DEFAULT_REUSE_HOLD_SECONDS = 300;

export async function handleSitesApi(request, env, config, store) {
  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return authErrorResponse(auth.error);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/api/sites') {
    if (request.method === 'GET') return listSites(store, auth.actor, config.environment);
    if (request.method === 'POST') return createSite(request, env, config, store, auth.actor);
    return methodNotAllowed();
  }

  const aclEntriesSiteId = matchSiteAclEntries(url.pathname);
  if (aclEntriesSiteId) {
    if (request.method === 'POST') return grantSiteAclEntries(request, env, config, store, auth.actor, aclEntriesSiteId);
    if (request.method === 'DELETE') return revokeSiteAclEntries(request, env, config, store, auth.actor, aclEntriesSiteId);
    return methodNotAllowed();
  }

  const aclSiteId = matchSiteAcl(url.pathname);
  if (aclSiteId) {
    if (request.method === 'GET') return listSiteAcl(store, auth.actor, aclSiteId, config.environment);
    if (request.method === 'PUT') return replaceSiteAcl(request, env, config, store, auth.actor, aclSiteId);
    return methodNotAllowed();
  }

  const secretsSiteSlug = matchSiteSecrets(url.pathname);
  if (secretsSiteSlug) {
    if (request.method === 'PUT') return putSiteSecret(request, env, config, store, auth.actor, secretsSiteSlug);
    if (request.method === 'DELETE') return deleteSiteSecret(request, env, config, store, auth.actor, secretsSiteSlug);
    return methodNotAllowed();
  }

  const siteId = matchSiteId(url.pathname);
  if (siteId && request.method === 'GET') return getSite(store, auth.actor, siteId, config.environment);
  if (siteId && request.method === 'PATCH') return updateSite(request, env, config, store, auth.actor, siteId);
  if (siteId && request.method === 'DELETE') return deleteSite(env, config, store, auth.actor, siteId);
  if (siteId) return methodNotAllowed();

  return null;
}

async function putSiteSecret(request, env, config, store, actor, siteSlug) {
  const site = await getSecretManageableSiteBySlug(store, actor, siteSlug, config.environment);
  if (site instanceof Response) return site;
  if (!store.putSiteSecret) {
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime secret store is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const name = normalizeSecretNameForResponse(body.name);
  if (name instanceof Response) return name;
  if (typeof body.value !== 'string' || body.value.length === 0) {
    return jsonError('SECRET_VALUE_INVALID', 'Secret value is invalid.', 400, 'Send a non-empty string value.');
  }
  if (byteLength(body.value) > MAX_SITE_SECRET_VALUE_BYTES) {
    return jsonError('SECRET_VALUE_TOO_LARGE', 'Secret value is too large.', 413, 'Use a secret value no larger than 8 KiB.');
  }
  try {
    const secret = await putSiteSecretWithAudit(store, env, {
      id: nextId(env, 'sec'),
      environment: config.environment,
      siteId: site.id,
      siteSlug: site.slug,
      name,
      value: body.value,
      actorId: actor.userId,
      actorType: actor.type,
      routeId: site.route?.id || null,
      auditId: nextId(env, 'aud'),
      updatedAt: readNow(env),
    });
    const syncError = await syncActiveWfpSecret(store, env, config, site, {
      operation: 'put',
      name,
      value: body.value,
    });
    if (syncError) return syncError;
    return jsonOk({ secret: formatSecret(site.slug, secret, { deleted: false }) });
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

async function deleteSiteSecret(request, env, config, store, actor, siteSlug) {
  const site = await getSecretManageableSiteBySlug(store, actor, siteSlug, config.environment);
  if (site instanceof Response) return site;
  if (!store.deleteSiteSecret) {
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime secret store is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const name = normalizeSecretNameForResponse(body.name);
  if (name instanceof Response) return name;
  try {
    const secret = await deleteSiteSecretWithAudit(store, env, {
      environment: config.environment,
      siteId: site.id,
      siteSlug: site.slug,
      name,
      actorId: actor.userId,
      actorType: actor.type,
      routeId: site.route?.id || null,
      auditId: nextId(env, 'aud'),
      deletedAt: readNow(env),
    });
    const syncError = await syncActiveWfpSecret(store, env, config, site, {
      operation: 'delete',
      name,
    });
    if (syncError) return syncError;
    return jsonOk({ secret: formatSecret(site.slug, secret || { name }, { deleted: true }) });
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

async function putSiteSecretWithAudit(store, env, input) {
  if (typeof store.putSiteSecretWithAudit === 'function') return store.putSiteSecretWithAudit(input);
  void env;
  throw new Error('RUNTIME_SECRET_STORE_UNAVAILABLE');
}

async function deleteSiteSecretWithAudit(store, env, input) {
  if (typeof store.deleteSiteSecretWithAudit === 'function') return store.deleteSiteSecretWithAudit(input);
  void env;
  throw new Error('RUNTIME_SECRET_STORE_UNAVAILABLE');
}

export async function syncActiveWfpSecret(store, env, config, site, input) {
  if (typeof store.getRouteBySiteId !== 'function' || typeof store.getSiteVersion !== 'function') return null;

  const route = await store.getRouteBySiteId(site.id, config.environment);
  if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;

  const version = await store.getSiteVersion(route.activeVersionId, config.environment);
  if (!version || (!isWfpRoute(route) && !isWfpVersion(version))) return null;
  if (!versionRequiresWorker(version)) return null;
  const workerName = route.workerName || version.workerName;
  if (!workerName) return null;

  let provider;
  try {
    provider = createWfpDeploymentProvider(env, config);
  } catch (error) {
    if (input.operation === 'delete' && isNotFoundError(error)) return null;
    return jsonError(
      'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      'Runtime secret was saved but the active Worker could not be updated.',
      502,
      'Check platform Worker provider configuration and retry the secret command.'
    );
  }
  try {
    if (input.operation === 'put') {
      if (typeof provider.putSecret !== 'function') return null;
      await provider.putSecret({ workerName, name: input.name, value: input.value });
    } else {
      if (typeof provider.deleteSecret !== 'function') return null;
      await provider.deleteSecret({ workerName, name: input.name });
    }
    return null;
  } catch (error) {
    if (input.operation === 'delete' && isNotFoundError(error)) return null;
    return jsonError(
      'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      'Runtime secret was saved but the active Worker could not be updated.',
      502,
      'Retry the secret command before testing the current Worker.'
    );
  }
}

function isNotFoundError(error) {
  return Number(error?.status) === 404 || Number(error?.statusCode) === 404;
}

function isWfpRoute(route) {
  return route.executionProvider === 'wfp' || route.runtime === 'wfp';
}

function isWfpVersion(version) {
  return version.executionProvider === 'wfp' || version.runtime === 'wfp';
}

function versionRequiresWorker(version) {
  return version.deploymentShape === 'worker-only' || version.deploymentShape === 'worker-with-assets';
}

async function listSites(store, actor, environment) {
  if (!actorCanReadSite(actor)) {
    return jsonError('SITE_READ_FORBIDDEN', 'Actor cannot read sites.', 403, 'Use a token with read:site scope.');
  }
  const sites = await store.listSitesForUser(actor.userId, actor, environment);
  return jsonOk({
    sites: sites.map(formatSite),
  });
}

async function getSite(store, actor, siteId, environment) {
  if (!actorCanReadSite(actor, siteId)) {
    return jsonError('SITE_READ_FORBIDDEN', 'Actor cannot read this site.', 403, 'Use a token with read:site scope.');
  }
  const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  return jsonOk({ site: formatSite(site) });
}

async function updateSite(request, env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const visibility = typeof body.visibility === 'string' ? body.visibility : '';
  if (!VISIBILITIES.has(visibility)) {
    return jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, VISIBILITY_ACTION);
  }

  const route = await store.updateSiteVisibility(
    site.id,
    {
      visibility,
      updatedAt: readNow(env),
    },
    config.environment
  );
  const updatedSite = await store.getSiteForUser(site.id, actor.userId, actor, config.environment);
  const snapshotError = await refreshActiveRouteSnapshot(env, store, updatedSite, route, config.environment);
  if (snapshotError) {
    await restoreSiteVisibilityAfterSnapshotFailure(store, site.id, site, previousRoute, route, config.environment);
    return snapshotError;
  }

  return jsonOk({ site: formatSite({ ...updatedSite, route }) });
}

async function deleteSite(env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;
  const deletedAt = readNow(env);
  const reuseHoldUntil = addSecondsIso(deletedAt, readReuseHoldSeconds(env));
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
  return jsonOk({ site: formatSite({ ...deleted, route: await store.getRouteBySiteId(site.id, config.environment) }) });
}

async function listSiteAcl(store, actor, siteId, environment) {
  if (actor.type !== 'user') {
    return jsonError('SITE_POLICY_FORBIDDEN', 'Access keys cannot read site ACL.', 403, 'Use a user CLI token.');
  }

  const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

  const aclEntries = await store.listSiteAclEntries(site.id);
  return jsonOk({ aclEntries: aclEntries.map(formatAclEntry) });
}

async function replaceSiteAcl(request, env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));
  const previousAclEntries = await store.listSiteAclEntries(site.id);

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const normalized = normalizeAclEntries(body.entries, env);
  if (normalized instanceof Response) return normalized;

  const aclEntries = await store.replaceSiteAclEntries(
    site.id,
    normalized,
    {
      createdBy: actor.userId,
      updatedAt: readNow(env),
    },
    config.environment
  );
  const route = await store.getRouteBySiteId(site.id, config.environment);
  const snapshotError = await refreshActiveRouteSnapshot(env, store, site, route, config.environment);
  if (snapshotError) {
    await restoreSiteAclAfterSnapshotFailure(store, site.id, previousAclEntries, previousRoute, site, route, config.environment);
    return snapshotError;
  }

  return jsonOk({ aclEntries: aclEntries.map(formatAclEntry) });
}

async function grantSiteAclEntries(request, env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));
  const previousAclEntries = await store.listSiteAclEntries(site.id);

  const normalized = await readAndNormalizeAclEntries(request, env);
  if (normalized instanceof Response) return normalized;

  const mergedCount = countMergedAclEntries(previousAclEntries, normalized);
  if (mergedCount > MAX_ACL_ENTRIES) {
    return jsonError('ACL_ENTRIES_INVALID', 'ACL entries are invalid.', 400, 'A site can have at most 200 ACL entries.');
  }

  const aclEntries = await store.addSiteAclEntries(
    site.id,
    normalized,
    {
      createdBy: actor.userId,
      updatedAt: readNow(env),
    },
    config.environment
  );
  const route = await store.getRouteBySiteId(site.id, config.environment);
  if (!aclEntrySetsEqual(previousAclEntries, aclEntries)) {
    const snapshotError = await refreshActiveRouteSnapshot(env, store, site, route, config.environment);
    if (snapshotError) {
      await restoreSiteAclAfterSnapshotFailure(
        store,
        site.id,
        previousAclEntries,
        previousRoute,
        site,
        route,
        config.environment
      );
      return snapshotError;
    }
  }

  return jsonOk({ aclEntries: aclEntries.map(formatAclEntry) });
}

async function revokeSiteAclEntries(request, env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));
  const previousAclEntries = await store.listSiteAclEntries(site.id);

  const normalized = await readAndNormalizeAclEntries(request, env);
  if (normalized instanceof Response) return normalized;

  const aclEntries = await store.removeSiteAclEntries(site.id, normalized, { updatedAt: readNow(env) }, config.environment);
  const route = await store.getRouteBySiteId(site.id, config.environment);
  if (!aclEntrySetsEqual(previousAclEntries, aclEntries)) {
    const snapshotError = await refreshActiveRouteSnapshot(env, store, site, route, config.environment);
    if (snapshotError) {
      await restoreSiteAclAfterSnapshotFailure(
        store,
        site.id,
        previousAclEntries,
        previousRoute,
        site,
        route,
        config.environment
      );
      return snapshotError;
    }
  }

  return jsonOk({ aclEntries: aclEntries.map(formatAclEntry) });
}

async function createSite(request, env, config, store, actor) {
  if (actor.type !== 'user') {
    return jsonError('SITE_CREATE_FORBIDDEN', 'Access keys cannot create sites.', 403, 'Use a user CLI token.');
  }

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
    return jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, VISIBILITY_ACTION);
  }

  let ownerId = actor.userId;
  if (ownerType === 'team') {
    const teamOwner = await resolveTeamPublishOwner(store, actor.userId, body.teamId, config.environment);
    if (teamOwner instanceof Response) return teamOwner;
    ownerId = teamOwner.ownerId;
  }

  const siteId = nextId(env, 'site');
  const routeId = nextId(env, 'route');
  const siteUuid = nextSiteUuid(env);
  const hostname = hostnameForSlug(slug, config);

  let site;
  try {
    site = await store.createSite({
      id: siteId,
      slug,
      ownerType,
      ownerId,
      ownerUserId: actor.userId,
      siteUuid,
      defaultVisibility: visibility,
      environment: config.environment,
      routeId,
      hostname,
    });
  } catch (error) {
    const response = siteCreateErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const route = await store.getRouteBySiteId(site.id, config.environment);
  return jsonOk({ site: formatSite({ ...site, route }) }, 201);
}

async function resolveTeamPublishOwner(store, userId, teamIdValue, environment) {
  const teamId = normalizeRequiredString(teamIdValue);
  if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
  const team = await store.getTeam(teamId);
  if (!team || team.environment !== environment) {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  const member = await store.getTeamMember({ teamId, userId });
  if (!member) return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  if (member.role !== 'admin' && member.role !== 'publisher') {
    return jsonError(
      'TEAM_PUBLISHER_REQUIRED',
      'Team publisher role required.',
      403,
      'Ask a team publisher to create the site.'
    );
  }
  return { ownerId: team.id };
}

export function siteCreateErrorResponse(error) {
  const message = error instanceof Error ? error.message : '';
  if (/SITE_SLUG_CONFLICT/.test(message)) {
    return jsonError('SITE_SLUG_CONFLICT', 'Site slug already exists.', 409, 'Choose a different site slug.');
  }
  if (/HOSTNAME_CLAIM_CONFLICT/.test(message)) {
    return jsonError(
      'HOSTNAME_CLAIM_CONFLICT',
      'Site hostname is already claimed.',
      409,
      '请换一个站点名，或使用原站点 owner 继续部署。'
    );
  }
  return null;
}

export function validateSlug(slug, environment) {
  const validation = validateSiteSlug(slug, { environment });
  if (validation.ok) return null;
  if (validation.error.code === 'RESERVED_SLUG') {
    return jsonError('SITE_SLUG_RESERVED', 'Site slug is reserved.', 400, RESERVED_SITE_SLUG_ACTION);
  }
  return jsonError(
    'SITE_SLUG_INVALID',
    'Site slug is invalid.',
    400,
    'Use 2-50 lowercase letters, numbers, and hyphens; the first and last characters must be alphanumeric.'
  );
}

function formatSite(site) {
  const route = site.route || null;
  return {
    id: site.id,
    slug: site.slug,
    environment: site.environment,
    defaultVisibility: site.defaultVisibility,
    url: route ? `https://${route.hostname}` : null,
    route: route
      ? {
          id: route.id,
          hostname: route.hostname,
          status: route.routeStatus,
          runtime: route.runtime,
          activeVersionId: route.activeVersionId,
          visibility: route.visibility,
          routeGeneration: route.routeGeneration,
          policyVersion: route.policyVersion,
          cacheTier: route.cacheTier,
        }
      : null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    deletedAt: site.deletedAt || null,
  };
}

export function hostnameForSlug(slug, config) {
  if (config.environment === 'staging') return `${slug}-staging.${config.siteDomainSuffix}`;
  return `${slug}.${config.siteDomainSuffix}`;
}

function actorCanReadSite(actor, siteId) {
  if (actor.type !== 'access_key') return true;
  if (siteId && actor.siteId && actor.siteId !== siteId) return false;
  return actor.scopes.includes('read:site');
}

async function getOwnerSite(store, actor, siteId, environment) {
  if (actor.type !== 'user') {
    return jsonError('SITE_POLICY_FORBIDDEN', 'Access keys cannot manage site policy.', 403, 'Use a user CLI token.');
  }
  const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (site.ownerType === 'team') {
    if (site.managementRole !== 'admin') {
      return jsonError(
        'SITE_POLICY_FORBIDDEN',
        'Only team admins can manage team site policy.',
        403,
        'Use a team admin account.'
      );
    }
    return site;
  }
  if (site.ownerUserId !== actor.userId) {
    return jsonError('SITE_POLICY_FORBIDDEN', 'Only the site owner can manage site policy.', 403, 'Use the owner account.');
  }
  return site;
}

async function getSecretManageableSiteBySlug(store, actor, siteSlug, environment) {
  const slug = normalizeSlug(siteSlug);
  const slugError = validateSlug(slug, environment);
  if (slugError) return slugError;
  const site = await store.findSiteBySlug(environment, slug);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug.');
  const visible = await store.getSiteForUser(site.id, actor.userId, actor, environment);
  if (!visible) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug and token scope.');
  if (!actorCanManageSecrets(actor, visible)) {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot manage runtime secrets for this site.',
      403,
      'Use a user CLI token for the personal site owner or a team admin.'
    );
  }
  return visible;
}

function actorCanManageSecrets(actor, site) {
  if (!site) return false;
  if (actor.type === 'access_key') return false;
  if (site.ownerType === 'team') return site.managementRole === 'admin';
  return (site.ownerUserId || site.ownerId) === actor.userId;
}

function normalizeSecretNameForResponse(value) {
  try {
    return normalizeRuntimeSecretName(value);
  } catch {
    return jsonError('SECRET_NAME_INVALID', 'Secret name is invalid.', 400, 'Use a valid Worker binding name such as API_TOKEN.');
  }
}

function formatSecret(siteSlug, secret, { deleted }) {
  return {
    site: siteSlug,
    name: secret.name,
    updated: !deleted,
    deleted,
  };
}

function isRuntimeConfigConflict(error) {
  return error instanceof Error && error.message === 'SITE_SECRET_REVISION_CONFLICT';
}

function byteLength(value) {
  return new globalThis.TextEncoder().encode(String(value)).byteLength;
}

export function normalizeAclEntries(value, env) {
  if (!Array.isArray(value) || value.length > MAX_ACL_ENTRIES) {
    return jsonError('ACL_ENTRIES_INVALID', 'ACL entries are invalid.', 400, 'Send an entries array with at most 200 items.');
  }

  const deduped = new Map();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return jsonError('ACL_ENTRY_INVALID', 'ACL entry is invalid.', 400, 'Send ACL entry objects.');
    }

    const effect = entry.effect || 'allow';
    if (effect !== 'allow') {
      return jsonError('ACL_EFFECT_UNSUPPORTED', 'ACL deny entries are not supported.', 400, 'Use allow-only ACL entries.');
    }

    const accessRole = entry.accessRole || 'viewer';
    if (!ACL_ACCESS_ROLES.has(accessRole)) {
      return jsonError('ACL_ROLE_UNSUPPORTED', 'ACL role is not supported.', 400, 'Use viewer ACL entries.');
    }

    const subjectType = String(entry.subjectType || '')
      .trim()
      .toLowerCase();
    if (!ACL_SUBJECT_TYPES.has(subjectType)) {
      return jsonError('ACL_SUBJECT_TYPE_UNSUPPORTED', 'ACL subject type is not supported.', 400, 'Use email or department.');
    }

    const subjectValue = normalizeAclSubjectValue(subjectType, entry.subjectValue);
    if (!subjectValue) {
      return jsonError('ACL_SUBJECT_VALUE_INVALID', 'ACL subject value is invalid.', 400, 'Use a non-empty subject value.');
    }

    const key = `${effect}:${subjectType}:${subjectValue}:${accessRole}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        id: nextId(env, 'acl'),
        subjectType,
        subjectValue,
        accessRole,
        effect,
      });
    }
  }

  return [...deduped.values()];
}

async function readAndNormalizeAclEntries(request, env) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  return normalizeAclEntries(body.entries, env);
}

function normalizeAclSubjectValue(subjectType, value) {
  const normalized = String(value || '').trim();
  if (subjectType === 'email') {
    const email = normalized.toLowerCase();
    return isValidEmailAclSubject(email) ? email : '';
  }
  if (subjectType === 'department') return normalizeDepartmentPath(normalized);
  return '';
}

function isValidEmailAclSubject(value) {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

function normalizeDepartmentPath(value) {
  if (!value || hasControlCharacter(value)) return '';
  const parts = value
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const path = parts.join('/');
  if (path.length > 256 || parts.some((part) => part.length > 80)) return '';
  return path;
}

function hasControlCharacter(value) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function countMergedAclEntries(existing, incoming) {
  const keys = new Set(existing.map(aclEntryKey));
  for (const entry of incoming) keys.add(aclEntryKey(entry));
  return keys.size;
}

function aclEntrySetsEqual(left, right) {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map(aclEntryKey));
  return right.every((entry) => keys.has(aclEntryKey(entry)));
}

function aclEntryKey(entry) {
  return `${entry.effect || 'allow'}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole || 'viewer'}`;
}

export async function refreshActiveRouteSnapshot(env, store, site, route, environment) {
  if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;

  const version = await store.getSiteVersion(route.activeVersionId, environment);
  if (!version) {
    return jsonError('ROUTE_VERSION_NOT_FOUND', 'Active route version was not found.', 500, 'Check route consistency.');
  }
  const aclEntries = await store.listSiteAclEntries(site.id);
  try {
    await writeRouteSnapshot(env, buildRouteSnapshot({ site, route, version, aclEntries }));
  } catch {
    return jsonError('ROUTE_SNAPSHOT_WRITE_FAILED', 'Route snapshot could not be written.', 503, 'Retry the policy update.');
  }
  return null;
}

export async function restoreSiteVisibilityAfterSnapshotFailure(
  store,
  siteId,
  previousSite,
  previousRoute,
  expectedRoute,
  environment
) {
  if (typeof store.restoreSiteVisibilityIfCurrent === 'function') {
    return store.restoreSiteVisibilityIfCurrent(siteId, previousSite, previousRoute, expectedRoute, environment);
  }
  return store.restoreSiteVisibility(siteId, previousSite, previousRoute, environment);
}

export async function restoreSiteAclAfterSnapshotFailure(
  store,
  siteId,
  previousEntries,
  previousRoute,
  previousSite,
  expectedRoute,
  environment
) {
  if (typeof store.restoreSiteAclEntriesIfCurrent === 'function') {
    return store.restoreSiteAclEntriesIfCurrent(siteId, previousEntries, previousRoute, previousSite, expectedRoute, environment);
  }
  return store.restoreSiteAclEntries(siteId, previousEntries, previousRoute, previousSite, environment);
}

function formatAclEntry(entry) {
  return {
    id: entry.id,
    subjectType: entry.subjectType,
    subjectValue: entry.subjectValue,
    accessRole: entry.accessRole,
    effect: entry.effect,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
  };
}

export function normalizeSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeRequiredString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function matchSiteAcl(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/acl$/);
  return match ? match[1] : null;
}

function matchSiteAclEntries(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/acl\/entries$/);
  return match ? match[1] : null;
}

function matchSiteSecrets(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/secrets$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchSiteId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)$/);
  return match ? match[1] : null;
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') {
    const id = env.nextId(prefix);
    if (id) return id;
  }
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

function authErrorResponse(error) {
  return jsonError(error.code, error.message, error.status, error.action);
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
