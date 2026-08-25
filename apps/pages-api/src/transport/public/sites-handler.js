import { buildSiteOwnerTransferAuditEvent } from '../../application/sites/build-owner-transfer-audit-event.js';
import { authenticateApiRequest } from '../../auth.js';
import {
  isSiteVisibility,
  mergeSiteAclEntries,
  removeSiteAclEntries,
  teamOwnerSupportsVisibility,
} from '../../domain/sites/access-policy.js';
import {
  actorCanManageSite,
  actorCanReadSitesApi,
  actorCanTransferSiteOwnership,
  actorHasPublishScope,
} from '../../domain/sites/authorization.js';
import { siteMetadataRoutingStatus } from '../../domain/sites/metadata.js';
import { jsonError, jsonOk, readJsonBody } from '../../http.js';
import { nextId } from '../../id.js';
import { emitSiteDisabledWebhook } from '../../lifecycle-webhooks.js';
import { createSiteCreationApplication, siteCreateErrorResponse } from '../shared/site-creation-application.js';
import { createSiteLifecycleApplication, siteDeleteErrorResponse } from '../shared/site-lifecycle-application.js';
import { createSiteMetadataApplication, runSiteMetadataRoutingReconciliation } from '../shared/site-metadata-application.js';
import { createSiteOwnershipApplication, siteTransferErrorResponse } from '../shared/site-ownership-application.js';
import { mutateUserSiteAccessPolicy } from '../shared/site-policy-application.js';
import {
  normalizeSiteAclInput,
  normalizeSiteSlug,
  rejectUserExposureMutation,
  validateSiteSlugInput,
} from '../shared/site-input.js';
import {
  deleteSiteSecret,
  deleteSiteVar,
  listSiteSecretMetadata,
  listSiteVars,
  putSiteSecret,
  putSiteVar,
} from './site-runtime-config-handler.js';

const VISIBILITY_ACTION = '请使用 internal、org、acl、owner 或 disabled。';

export async function handleSitesApi(request, env, config, store, ctx) {
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
    if (request.method === 'GET') return listSiteSecretMetadata(env, config, store, auth.actor, secretsSiteSlug);
    if (request.method === 'PUT') return putSiteSecret(request, env, config, store, auth.actor, secretsSiteSlug);
    if (request.method === 'DELETE') return deleteSiteSecret(request, env, config, store, auth.actor, secretsSiteSlug);
    return methodNotAllowed();
  }

  const varsSiteSlug = matchSiteVars(url.pathname);
  if (varsSiteSlug) {
    if (request.method === 'GET') return listSiteVars(env, config, store, auth.actor, varsSiteSlug);
    if (request.method === 'PUT') return putSiteVar(request, env, config, store, auth.actor, varsSiteSlug);
    if (request.method === 'DELETE') return deleteSiteVar(request, env, config, store, auth.actor, varsSiteSlug);
    return methodNotAllowed();
  }

  const transferSiteId = matchSiteTransfer(url.pathname);
  if (transferSiteId) {
    if (request.method === 'POST') return transferSiteOwner(request, env, config, store, auth.actor, transferSiteId);
    return methodNotAllowed();
  }

  const metadataSiteId = matchSiteMetadata(url.pathname);
  if (metadataSiteId) {
    if (request.method === 'PATCH') {
      return updateSiteMetadata(request, env, config, store, auth.actor, metadataSiteId, ctx);
    }
    return methodNotAllowed();
  }

  const siteId = matchSiteId(url.pathname);
  if (siteId && request.method === 'GET') return getSite(store, auth.actor, siteId, config.environment);
  if (siteId && request.method === 'PATCH') return updateSite(request, env, config, store, auth.actor, siteId, ctx);
  if (siteId && request.method === 'DELETE') return deleteSite(env, config, store, auth.actor, siteId, ctx);
  if (siteId) return methodNotAllowed();

  return null;
}

async function listSites(store, actor, environment) {
  if (!actorCanReadSitesApi(actor)) {
    return jsonError('SITE_READ_FORBIDDEN', 'Actor cannot read sites.', 403, 'Use a token with read:site scope.');
  }
  const sites = await store.listSitesForUser(actor.userId, actor, environment);
  return jsonOk({
    sites: sites.map(formatSite),
  });
}

async function getSite(store, actor, siteId, environment) {
  if (!actorCanReadSitesApi(actor, siteId)) {
    return jsonError('SITE_READ_FORBIDDEN', 'Actor cannot read this site.', 403, 'Use a token with read:site scope.');
  }
  const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  return jsonOk({ site: formatSite(site) });
}

async function updateSite(request, env, config, store, actor, siteId, ctx) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  const visibility = typeof body.visibility === 'string' ? body.visibility : '';
  if (!isSiteVisibility(visibility)) {
    return jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, VISIBILITY_ACTION);
  }
  if (!teamOwnerSupportsVisibility(site, visibility)) return teamOwnerVisibilityUnsupported();

  const mutation = await mutateUserSiteAccessPolicy({
    env,
    config,
    store,
    siteId: site.id,
    actorUserId: actor.userId,
    visibility,
  });
  if (mutation instanceof Response) return mutation;

  await emitSiteDisabledWebhook({
    store,
    env,
    config,
    ctx,
    actor,
    site: mutation.site,
    previousRoute,
    route: mutation.route,
  });

  return jsonOk({ site: formatSite({ ...mutation.site, route: mutation.route }) });
}

async function updateSiteMetadata(request, env, config, store, actor, siteId, ctx) {
  if (env.SITE_METADATA_MUTATIONS_ENABLED !== 'true') {
    return jsonError(
      'SITE_METADATA_MUTATIONS_DISABLED',
      'Site metadata mutations are temporarily disabled.',
      503,
      'Retry after the feature is enabled.'
    );
  }

  const site = await store.getSiteForUser(siteId, actor.userId, actor, config.environment);
  if (!site || !actorCanManageSite(actor, site)) {
    return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  }

  let patch;
  try {
    patch = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const command = {
    environment: config.environment,
    siteId: site.id,
    actor,
    source: 'api',
    patch,
  };
  let mutation;
  try {
    mutation = await createSiteMetadataApplication({ store, env, config })(command);
  } catch (error) {
    return siteMetadataErrorResponse(error);
  }

  const responseSite = formatSiteMetadata({ ...mutation.site, route: mutation.route });
  if (Object.hasOwn(patch, 'slug') && mutation.routingStatus === 'pending') {
    if (typeof ctx?.waitUntil === 'function') {
      ctx.waitUntil(runSiteMetadataRoutingReconciliation(env, config, store, { limit: 50 }).catch(() => {}));
    }
    return jsonOk(
      {
        site: responseSite,
        warning: {
          code: 'SITE_METADATA_ROUTING_PENDING',
          message: 'Site metadata was saved and routing is still being synchronized.',
          action: 'Retry this request or wait for routing reconciliation.',
        },
      },
      202
    );
  }
  return jsonOk({ site: responseSite });
}

async function deleteSite(env, config, store, actor, siteId, ctx) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;
  let deleted;
  let route;
  try {
    const result = await createSiteLifecycleApplication({ store, env, config, ctx })({
      environment: config.environment,
      site,
      actor,
      compensateSnapshotFailure: true,
    });
    deleted = result.site;
    route = result.route;
  } catch (error) {
    return siteDeleteErrorResponse(error);
  }
  return jsonOk({ site: formatSite({ ...deleted, route }) });
}

async function transferSiteOwner(request, env, config, store, actor, siteId) {
  if (typeof store.transferSiteOwner !== 'function') {
    return jsonError('SITE_TRANSFER_UNSUPPORTED', 'Site transfer is unavailable.', 503, 'Retry later.');
  }

  const site = await store.getSiteForUser(siteId, actor.userId, actor, config.environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  if (sameOwner(site, requestedOwnerAuthority(body))) {
    return jsonError(
      'SITE_TRANSFER_INVALID',
      'Site transfer target is invalid.',
      400,
      'Choose an owner different from the current owner.'
    );
  }
  if (!actorCanTransferSiteOwnership(actor, site)) {
    return jsonError(
      'SITE_TRANSFER_FORBIDDEN',
      'Actor cannot transfer this site.',
      403,
      'Use the personal owner or source team admin account.'
    );
  }
  const target = await resolveSiteTransferTarget(store, actor, site, body, config.environment);
  if (target instanceof Response) return target;
  const currentVisibility = site.route?.visibility || site.defaultVisibility;
  if (!teamOwnerSupportsVisibility(target, currentVisibility)) return teamOwnerVisibilityUnsupported();

  let updated;
  let route;
  try {
    const result = await createSiteOwnershipApplication({ store, env })({
      environment: config.environment,
      site,
      actor,
      target,
      targetUserMustMatchActor: true,
      buildAuditEvent: (updatedAt, currentSite) =>
        buildSiteOwnerTransferAuditEvent({
          id: nextId(env, 'aud'),
          environment: config.environment,
          actor,
          site: currentSite,
          target,
          source: 'api',
          createdAt: updatedAt,
        }),
      compensateSnapshotFailure: true,
    });
    updated = result.site;
    route = result.route;
  } catch (error) {
    return siteTransferErrorResponse(error);
  }

  const visible = await store.getSiteForUser(updated.id, actor.userId, actor, config.environment);
  return jsonOk({ site: formatSite({ ...(visible || updated), route }) });
}

function sameOwner(site, target) {
  return (
    Boolean(target) && (site.ownerType || 'user') === target.ownerType && (site.ownerId || site.ownerUserId) === target.ownerId
  );
}

function requestedOwnerAuthority(body) {
  const ownerType = body?.ownerType === 'team' || body?.ownerType === 'user' ? body.ownerType : null;
  if (!ownerType) return null;
  const ownerId = normalizeRequiredString(ownerType === 'team' ? body.teamId || body.ownerId : body.ownerId || body.userId);
  return ownerId ? { ownerType, ownerId } : null;
}

async function resolveSiteTransferTarget(store, actor, site, body, environment) {
  const ownerType = body?.ownerType === 'team' || body?.ownerType === 'user' ? body.ownerType : '';
  if (!ownerType) {
    return jsonError('SITE_TRANSFER_INVALID', 'Site transfer target is invalid.', 400, 'Use ownerType user or team.');
  }

  if (ownerType === 'user') {
    if (actor.type === 'access_key' && (actor.ownerType || 'user') === 'team') {
      return jsonError(
        'SITE_TRANSFER_FORBIDDEN',
        'Team access tokens cannot transfer sites to personal owners.',
        403,
        'Use a personal access token or user CLI session.'
      );
    }
    const ownerId = normalizeRequiredString(body.ownerId || body.userId);
    if (!ownerId || ownerId !== actor.userId) {
      return jsonError(
        'SITE_TRANSFER_FORBIDDEN',
        'Actor cannot transfer this site to the requested personal owner.',
        403,
        'Transfer sites only to the authenticated user.'
      );
    }
    const user = typeof store.getUser === 'function' ? await store.getUser(ownerId) : null;
    if (!user || user.employeeStatus !== 'active') {
      return jsonError('SITE_TRANSFER_FORBIDDEN', 'Target user is not active.', 403, 'Choose an active user.');
    }
    return { ownerType: 'user', ownerId, ownerUserId: ownerId };
  }

  const teamId = normalizeRequiredString(body.teamId || body.ownerId);
  const teamTarget = await resolveTeamTransferTarget(store, actor, teamId, environment);
  if (teamTarget instanceof Response) return teamTarget;
  return {
    ownerType: 'team',
    ownerId: teamTarget.team.id,
    ownerUserId: actor.userId || site.ownerUserId,
  };
}

async function resolveTeamTransferTarget(store, actor, teamId, environment) {
  if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
  const team = typeof store.getTeam === 'function' ? await store.getTeam(teamId) : null;
  if (!team || team.environment !== environment || team.deletedAt) {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }

  if (actor.type === 'access_key' && (actor.ownerType || 'user') === 'team') {
    if (actor.ownerId === team.id && actorHasPublishScope(actor)) return { team, role: 'publisher' };
    return jsonError(
      'SITE_TRANSFER_FORBIDDEN',
      'Team access token cannot transfer sites to this team.',
      403,
      'Use a token owned by the target team.'
    );
  }

  const member =
    actor.userId && typeof store.getTeamMember === 'function'
      ? await store.getTeamMember({ teamId, userId: actor.userId })
      : null;
  if (!member || (member.role !== 'admin' && member.role !== 'publisher')) {
    return jsonError(
      'SITE_TRANSFER_FORBIDDEN',
      'Team publisher role required.',
      403,
      'Choose a team where the actor is publisher or admin.'
    );
  }
  return { team, role: member.role };
}

async function listSiteAcl(store, actor, siteId, environment) {
  const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (actor.type === 'access_key' && !actorCanManageSite(actor, site)) {
    return jsonError(
      'SITE_POLICY_FORBIDDEN',
      'Access key cannot read ACL for this site.',
      403,
      'Use a deploy-capable token for a site you can manage.'
    );
  }

  const aclEntries = await store.listSiteAclEntries(site.id);
  return jsonOk({ aclEntries: aclEntries.map(formatAclEntry) });
}

async function replaceSiteAcl(request, env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  const normalized = normalizeSiteAclInput(body.entries, env);
  if (normalized instanceof Response) return normalized;

  const mutation = await mutateUserSiteAccessPolicy({
    env,
    config,
    store,
    siteId: site.id,
    actorUserId: actor.userId,
    resolveAclEntries: () => normalized,
  });
  if (mutation instanceof Response) return mutation;

  return jsonOk({ aclEntries: mutation.aclEntries.map(formatAclEntry) });
}

async function grantSiteAclEntries(request, env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;

  const normalized = await readAndNormalizeAclEntries(request, env);
  if (normalized instanceof Response) return normalized;

  const mutation = await mutateUserSiteAccessPolicy({
    env,
    config,
    store,
    siteId: site.id,
    actorUserId: actor.userId,
    resolveAclEntries: (current) => mergeSiteAclEntries(current, normalized),
  });
  if (mutation instanceof Response) return mutation;

  return jsonOk({ aclEntries: mutation.aclEntries.map(formatAclEntry) });
}

async function revokeSiteAclEntries(request, env, config, store, actor, siteId) {
  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;

  const normalized = await readAndNormalizeAclEntries(request, env);
  if (normalized instanceof Response) return normalized;

  const mutation = await mutateUserSiteAccessPolicy({
    env,
    config,
    store,
    siteId: site.id,
    actorUserId: actor.userId,
    resolveAclEntries: (current) => removeSiteAclEntries(current, normalized),
  });
  if (mutation instanceof Response) return mutation;

  return jsonOk({ aclEntries: mutation.aclEntries.map(formatAclEntry) });
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

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  const slug = normalizeSiteSlug(body.slug);
  const visibility = body.visibility || 'org';
  const ownerType = body.ownerType === 'team' ? 'team' : 'user';
  const slugError = validateSiteSlugInput(slug, config.environment);
  if (slugError) return slugError;
  if (!isSiteVisibility(visibility)) {
    return jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, VISIBILITY_ACTION);
  }
  if (!teamOwnerSupportsVisibility({ ownerType }, visibility)) return teamOwnerVisibilityUnsupported();

  let ownerId = actor.userId;
  if (ownerType === 'team') {
    const teamOwner = await resolveTeamPublishOwner(store, actor.userId, body.teamId, config.environment);
    if (teamOwner instanceof Response) return teamOwner;
    ownerId = teamOwner.ownerId;
  }

  let site;
  let route;
  try {
    const result = await createSiteCreationApplication({ store, env, config }).create({
      environment: config.environment,
      slug,
      ownerType,
      ownerId,
      ownerUserId: actor.userId,
      visibility,
      actor,
      allowLegacyV1Takeover: true,
      includeRoute: true,
    });
    site = result.site;
    route = result.route;
  } catch (error) {
    const response = siteCreateErrorResponse(error);
    if (response) return response;
    throw error;
  }

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
    return jsonError('TEAM_PUBLISHER_REQUIRED', 'Team publisher role required.', 403, 'Ask a team publisher to create the site.');
  }
  return { ownerId: team.id };
}

function formatSite(site) {
  const route = site.route || null;
  return {
    id: site.id,
    title: site.title || null,
    displayName: site.title || site.slug,
    slug: site.slug,
    routingStatus: siteMetadataRoutingStatus(site),
    environment: site.environment,
    defaultVisibility: site.defaultVisibility,
    owner: {
      type: site.ownerType || 'user',
    },
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

function formatSiteMetadata(site) {
  const projected = formatSite(site);
  return {
    id: projected.id,
    title: projected.title,
    displayName: projected.displayName,
    slug: projected.slug,
    routingStatus: projected.routingStatus,
    url: projected.url,
  };
}

async function getOwnerSite(store, actor, siteId, environment) {
  const site = await store.getSiteForUser(siteId, actor.userId, actor, environment);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (!actorCanManageSite(actor, site)) {
    return jsonError(
      'SITE_POLICY_FORBIDDEN',
      'Actor cannot manage this site.',
      403,
      'Use a publisher or admin role for this site.'
    );
  }
  return site;
}

async function readAndNormalizeAclEntries(request, env) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;
  return normalizeSiteAclInput(body.entries, env);
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

function matchSiteVars(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/vars$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchSiteTransfer(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/transfer$/);
  return match ? match[1] : null;
}

function matchSiteMetadata(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/metadata$/);
  return match ? match[1] : null;
}

function matchSiteId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)$/);
  return match ? match[1] : null;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function authErrorResponse(error) {
  return jsonError(error.code, error.message, error.status, error.action);
}

function teamOwnerVisibilityUnsupported() {
  return jsonError(
    'SITE_VISIBILITY_INVALID',
    'Team-owned sites cannot use owner visibility.',
    400,
    'Use internal, org, acl, or disabled for team-owned sites.'
  );
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}

function siteMetadataErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'SITE_METADATA_INVALID') {
    return jsonError('SITE_METADATA_INVALID', 'Site metadata is invalid.', 400, 'Send title, slug, or both.');
  }
  if (code === 'SITE_TITLE_INVALID') {
    return jsonError(
      'SITE_TITLE_INVALID',
      'Site title is invalid.',
      400,
      'Use 1-80 visible Unicode characters, or null to clear the title.'
    );
  }
  if (code === 'SITE_SLUG_INVALID') {
    return jsonError(
      'SITE_SLUG_INVALID',
      'Site slug is invalid.',
      400,
      'Use 2-50 lowercase letters, numbers, and hyphens; the first and last characters must be alphanumeric.'
    );
  }
  if (code === 'SITE_SLUG_RESERVED') {
    return jsonError('SITE_SLUG_RESERVED', 'Site slug is reserved.', 400, 'Choose a different site slug.');
  }
  if (code === 'SITE_SLUG_CONFLICT') {
    return jsonError('SITE_SLUG_CONFLICT', 'Site slug already exists.', 409, 'Choose a different site slug.');
  }
  if (code === 'SITE_METADATA_CONFLICT') {
    return jsonError('SITE_METADATA_CONFLICT', 'Site metadata changed concurrently.', 409, 'Refresh the site and retry.');
  }
  if (code === 'SITE_NOT_FOUND') return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  return jsonError('SITE_METADATA_UPDATE_FAILED', 'Site metadata could not be updated.', 500, 'Retry the update.');
}
