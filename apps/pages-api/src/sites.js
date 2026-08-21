import { validateSiteSlug } from '@xd/pages-runtime-protocol';

import { authenticateApiRequest } from './auth.js';
import { isSiteVisibility } from './domain/sites/access-policy.js';
import { actorCanManageSite, actorHasPublishScope } from './domain/sites/authorization.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { nextId } from './id.js';
import {
  MAX_SITE_SECRET_VALUE_BYTES,
  normalizeRuntimeSecretName,
  normalizeRuntimeVars,
} from './runtime-config.js';
import { logRuntimeConfigFailure, readRuntimeConfigErrorDiagnostic } from './runtime-config-diagnostics.js';
import { createRuntimeConfigSync } from './infrastructure/providers/runtime-config-sync.js';
import { createDeploymentProvider as createWfpDeploymentProvider } from './wfp-provider.js';
import { emitSiteDisabledWebhook } from './lifecycle-webhooks.js';
import {
  createRuntimeConfigApplication,
  runtimeConfigSyncErrorResponse,
} from './transport/shared/runtime-config-application.js';
import { mutateUserSiteAccessPolicy } from './transport/shared/site-policy-application.js';
import {
  createSiteOwnershipApplication,
  siteTransferErrorResponse,
} from './transport/shared/site-ownership-application.js';
import {
  createSiteLifecycleApplication,
  siteDeleteErrorResponse,
} from './transport/shared/site-lifecycle-application.js';
import {
  createSiteCreationApplication,
  siteCreateErrorResponse,
} from './transport/shared/site-creation-application.js';

export { actorCanManageSite };

const ACL_SUBJECT_TYPES = new Set(['email', 'department']);
const ACL_ACCESS_ROLES = new Set(['viewer']);
const MAX_ACL_ENTRIES = 200;
const MAX_RUNTIME_VAR_BODY_BYTES = 64 * 1024;
const VISIBILITY_ACTION = '请使用 internal、org、acl、owner 或 disabled。';
const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Cell 平台保留项，请换一个业务站点名。';

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
    if (request.method === 'PUT') return putSiteSecret(request, env, config, store, auth.actor, secretsSiteSlug);
    if (request.method === 'DELETE') return deleteSiteSecret(request, env, config, store, auth.actor, secretsSiteSlug);
    return methodNotAllowed();
  }

  const varsSiteSlug = matchSiteVars(url.pathname);
  if (varsSiteSlug) {
    if (request.method === 'PUT') return putSiteVar(request, env, config, store, auth.actor, varsSiteSlug);
    if (request.method === 'DELETE') return deleteSiteVar(request, env, config, store, auth.actor, varsSiteSlug);
    return methodNotAllowed();
  }

  const transferSiteId = matchSiteTransfer(url.pathname);
  if (transferSiteId) {
    if (request.method === 'POST') return transferSiteOwner(request, env, config, store, auth.actor, transferSiteId);
    return methodNotAllowed();
  }

  const siteId = matchSiteId(url.pathname);
  if (siteId && request.method === 'GET') return getSite(store, auth.actor, siteId, config.environment);
  if (siteId && request.method === 'PATCH') return updateSite(request, env, config, store, auth.actor, siteId, ctx);
  if (siteId && request.method === 'DELETE') return deleteSite(env, config, store, auth.actor, siteId, ctx);
  if (siteId) return methodNotAllowed();

  return null;
}

async function putSiteVar(request, env, config, store, actor, siteSlug) {
  const site = await getRuntimeManageableSiteBySlug(store, actor, siteSlug, config.environment);
  if (site instanceof Response) return site;
  if (typeof store.mutateSiteVar !== 'function') {
    logRuntimeConfigFailure(env, {
      operation: 'var_put',
      environment: config.environment,
      siteId: site.id,
      stage: 'capability_check',
      reason: 'capability_unavailable',
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime config store is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: MAX_RUNTIME_VAR_BODY_BYTES });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  if (!hasExactKeys(body, ['name', 'value'])) return runtimeVarInvalid();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  let normalized;
  try {
    normalized = normalizeRuntimeVars({ [name]: body.value });
  } catch (error) {
    return runtimeVarValidationError(error);
  }

  let mutation;
  let syncResult;
  try {
    const result = await createRuntimeConfigApplication({ store, env, config }).mutateVar({
      environment: config.environment,
      site,
      actor,
      operation: 'put',
      name,
      value: normalized[name],
    });
    mutation = result.mutation;
    syncResult = result.syncResult;
  } catch (error) {
    const syncResponse = runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'var' });
    if (syncResponse) return syncResponse;
    const response = runtimeVarMutationError(error);
    if (response.status >= 500) {
      const diagnostic = readRuntimeConfigErrorDiagnostic(error, {
        stage: 'unknown',
        reason: 'store_operation_failed',
      });
      logRuntimeConfigFailure(env, {
        operation: 'var_put',
        environment: config.environment,
        siteId: site.id,
        ...diagnostic,
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      });
    }
    return response;
  }
  return jsonOk({
    var: formatVar(site.slug, mutation.record, { deleted: false, appliesTo: syncResult.appliesTo }),
  });
}

async function deleteSiteVar(request, env, config, store, actor, siteSlug) {
  const site = await getRuntimeManageableSiteBySlug(store, actor, siteSlug, config.environment);
  if (site instanceof Response) return site;
  if (typeof store.mutateSiteVar !== 'function') {
    logRuntimeConfigFailure(env, {
      operation: 'var_delete',
      environment: config.environment,
      siteId: site.id,
      stage: 'capability_check',
      reason: 'capability_unavailable',
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime config store is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  if (!hasExactKeys(body, ['name'])) return runtimeVarInvalid();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  try {
    normalizeRuntimeVars({ [name]: '' });
  } catch (error) {
    return runtimeVarValidationError(error);
  }

  let mutation;
  let syncResult;
  try {
    const result = await createRuntimeConfigApplication({ store, env, config }).mutateVar({
      environment: config.environment,
      site,
      actor,
      operation: 'delete',
      name,
    });
    mutation = result.mutation;
    syncResult = result.syncResult;
  } catch (error) {
    const syncResponse = runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'var' });
    if (syncResponse) return syncResponse;
    const response = runtimeVarMutationError(error);
    if (response.status >= 500) {
      const diagnostic = readRuntimeConfigErrorDiagnostic(error, {
        stage: 'unknown',
        reason: 'store_operation_failed',
      });
      logRuntimeConfigFailure(env, {
        operation: 'var_delete',
        environment: config.environment,
        siteId: site.id,
        ...diagnostic,
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      });
    }
    return response;
  }
  return jsonOk({
    var: formatVar(site.slug, mutation.record, { deleted: true, appliesTo: syncResult.appliesTo }),
  });
}

async function putSiteSecret(request, env, config, store, actor, siteSlug) {
  const site = await getRuntimeManageableSiteBySlug(store, actor, siteSlug, config.environment);
  if (site instanceof Response) return site;
  if (typeof store.putSiteSecretWithAudit !== 'function') {
    logRuntimeConfigFailure(env, {
      operation: 'secret_put',
      environment: config.environment,
      siteId: site.id,
      stage: 'capability_check',
      reason: 'capability_unavailable',
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
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
    const { secret } = await createRuntimeConfigApplication({ store, env, config }).putSecret({
      environment: config.environment,
      site,
      actor,
      name,
      value: body.value,
    });
    return jsonOk({ secret: formatSecret(site.slug, secret, { deleted: false }) });
  } catch (error) {
    const syncResponse = runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'secret' });
    if (syncResponse) return syncResponse;
    if (error?.message === 'RUNTIME_BINDING_NAME_CONFLICT') {
      return jsonError(
        'RUNTIME_BINDING_NAME_CONFLICT',
        'Runtime binding names conflict.',
        400,
        'Use unique names for vars and site secrets.'
      );
    }
    if (error?.message === 'RUNTIME_BINDINGS_LIMIT_EXCEEDED') {
      return jsonError(
        'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
        'Runtime bindings exceed platform limits.',
        413,
        'Reduce vars or site secrets and retry.'
      );
    }
    if (isRuntimeConfigConflict(error)) {
      return jsonError(
        'RUNTIME_CONFIG_CHANGED',
        'Runtime secret changed while it was being updated.',
        409,
        'Retry the secret command.'
      );
    }
    const response = jsonError(
      'RUNTIME_CONFIG_UNSUPPORTED',
      'Runtime secret store is unavailable.',
      503,
      'Check runtime secret store configuration.'
    );
    logRuntimeConfigFailure(env, {
      operation: 'secret_put',
      environment: config.environment,
      siteId: site.id,
      ...readRuntimeConfigErrorDiagnostic(error, { stage: 'unknown', reason: 'store_operation_failed' }),
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
    return response;
  }
}

async function deleteSiteSecret(request, env, config, store, actor, siteSlug) {
  const site = await getRuntimeManageableSiteBySlug(store, actor, siteSlug, config.environment);
  if (site instanceof Response) return site;
  if (typeof store.deleteSiteSecretWithAudit !== 'function') {
    logRuntimeConfigFailure(env, {
      operation: 'secret_delete',
      environment: config.environment,
      siteId: site.id,
      stage: 'capability_check',
      reason: 'capability_unavailable',
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
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
    const { secret } = await createRuntimeConfigApplication({ store, env, config }).deleteSecret({
      environment: config.environment,
      site,
      actor,
      name,
    });
    return jsonOk({ secret: formatSecret(site.slug, secret || { name }, { deleted: true }) });
  } catch (error) {
    const syncResponse = runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'secret' });
    if (syncResponse) return syncResponse;
    if (isRuntimeConfigConflict(error)) {
      return jsonError(
        'RUNTIME_CONFIG_CHANGED',
        'Runtime secret changed while it was being deleted.',
        409,
        'Retry the secret command.'
      );
    }
    const response = jsonError(
      'RUNTIME_CONFIG_UNSUPPORTED',
      'Runtime secret store is unavailable.',
      503,
      'Check runtime secret store configuration.'
    );
    logRuntimeConfigFailure(env, {
      operation: 'secret_delete',
      environment: config.environment,
      siteId: site.id,
      ...readRuntimeConfigErrorDiagnostic(error, { stage: 'unknown', reason: 'store_operation_failed' }),
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
    return response;
  }
}

export async function syncActiveWfpSecret(store, env, config, site, input) {
  try {
    return await runtimeConfigSync(store, env, config).syncSecret({
      site,
      mutation: input,
    });
  } catch (error) {
    return runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'secret' });
  }
}

export async function syncActiveWfpPlainTextBindings(store, env, config, site, snapshot) {
  try {
    return await runtimeConfigSync(store, env, config).syncPlainText({
      site,
      snapshot,
    });
  } catch (error) {
    return runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'var' });
  }
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
  if (site.ownerType === 'team' && visibility === 'owner') return teamOwnerVisibilityUnsupported();

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

  const site = await getOwnerSite(store, actor, siteId, config.environment);
  if (site instanceof Response) return site;

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  const target = await resolveSiteTransferTarget(store, actor, site, body, config.environment);
  if (target instanceof Response) return target;
  const currentVisibility = site.route?.visibility || site.defaultVisibility;
  if (target.ownerType === 'team' && currentVisibility === 'owner') return teamOwnerVisibilityUnsupported();

  let updated;
  let route;
  try {
    const result = await createSiteOwnershipApplication({ store, env })({
      environment: config.environment,
      site,
      target,
      buildAuditEvent: (updatedAt) =>
        buildSiteOwnerTransferAuditEvent(env, config, actor, site, target, {
          source: 'api',
          createdAt: updatedAt,
        }),
      compensateSnapshotFailure: false,
    });
    updated = result.site;
    route = result.route;
  } catch (error) {
    return siteTransferErrorResponse(error);
  }

  const visible = await store.getSiteForUser(updated.id, actor.userId, actor, config.environment);
  return jsonOk({ site: formatSite({ ...(visible || updated), route }) });
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

export function buildSiteOwnerTransferAuditEvent(env, config, actor, site, target, { source, createdAt } = {}) {
  return {
    id: nextId(env, 'aud'),
    environment: config.environment,
    traceId: null,
    eventType: 'site.owner.transfer',
    actorUserId: actor.userId || null,
    actorType: actor.type,
    siteId: site.id,
    routeId: site.route?.id || null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      siteSlug: site.slug,
      fromOwner: {
        type: site.ownerType || 'user',
        id: site.ownerId || site.ownerUserId,
      },
      toOwner: {
        type: target.ownerType,
        id: target.ownerId,
      },
      source: source || 'api',
    },
    createdAt: createdAt || readNow(env),
  };
}

export function rejectUserExposureMutation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'exposure')) return null;
  return jsonError(
    'SITE_EXPOSURE_ADMIN_REQUIRED',
    'Site exposure can only be changed by a platform admin.',
    403,
    'Use the Admin Console exposure control.'
  );
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

  const normalized = normalizeAclEntries(body.entries, env);
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

  const slug = normalizeSlug(body.slug);
  const visibility = body.visibility || 'org';
  const ownerType = body.ownerType === 'team' ? 'team' : 'user';
  const slugError = validateSlug(slug, config.environment);
  if (slugError) return slugError;
  if (!isSiteVisibility(visibility)) {
    return jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, VISIBILITY_ACTION);
  }
  if (ownerType === 'team' && visibility === 'owner') return teamOwnerVisibilityUnsupported();

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

function actorCanReadSite(actor, siteId) {
  if (actor.type !== 'access_key') return true;
  if (siteId && actor.siteId && actor.siteId !== siteId) return false;
  return actor.scopes.includes('read:site') || actor.scopes.includes('deploy:site') || actor.scopes.includes('*');
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

async function getRuntimeManageableSiteBySlug(store, actor, siteSlug, environment) {
  const slug = normalizeSlug(siteSlug);
  const slugError = validateSlug(slug, environment);
  if (slugError) return slugError;
  const site = await store.findSiteBySlug(environment, slug);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug.');
  const visible = await store.getSiteForUser(site.id, actor.userId, actor, environment);
  if (!visible) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug and token scope.');
  if (!actorCanManageRuntimeConfig(actor, visible)) {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot manage runtime config for this site.',
      403,
      'Use a publisher or admin role for this site.'
    );
  }
  return visible;
}

function actorCanManageRuntimeConfig(actor, site) {
  return actorCanManageSite(actor, site);
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

function formatVar(siteSlug, record, { deleted, appliesTo }) {
  return {
    site: siteSlug,
    name: record.name,
    ...(!deleted && record.revision ? { revision: Number(record.revision) } : {}),
    ...(deleted ? { deleted: true } : { updated: true }),
    appliesTo,
  };
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function runtimeVarInvalid() {
  return jsonError('RUNTIME_VAR_INVALID', 'Runtime var is invalid.', 400, 'Use an uppercase non-sensitive binding name.');
}

function runtimeVarValidationError(error) {
  if (error?.message === 'RUNTIME_BINDING_NAME_RESERVED') {
    return jsonError(
      'RUNTIME_BINDING_NAME_RESERVED',
      'Runtime binding name is reserved.',
      400,
      'Use an application-specific name.'
    );
  }
  if (error?.message === 'RUNTIME_VARS_LIMIT_EXCEEDED') {
    return jsonError('RUNTIME_VARS_LIMIT_EXCEEDED', 'Runtime vars limit exceeded.', 413, 'Use fewer or smaller vars.');
  }
  return runtimeVarInvalid();
}

function runtimeVarMutationError(error) {
  if (error?.message === 'RUNTIME_VARS_LIMIT_EXCEEDED') {
    return jsonError('RUNTIME_VARS_LIMIT_EXCEEDED', 'Runtime vars limit exceeded.', 413, 'Use fewer or smaller vars.');
  }
  if (error?.message === 'RUNTIME_BINDING_NAME_CONFLICT') {
    return jsonError(
      'RUNTIME_BINDING_NAME_CONFLICT',
      'Runtime binding names conflict.',
      400,
      'Use unique names for vars and site secrets.'
    );
  }
  if (error?.message === 'RUNTIME_BINDINGS_LIMIT_EXCEEDED') {
    return jsonError(
      'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
      'Runtime bindings exceed platform limits.',
      413,
      'Reduce vars or site secrets and retry.'
    );
  }
  if (error?.message === 'SITE_VAR_REVISION_CONFLICT') {
    return jsonError(
      'RUNTIME_CONFIG_CHANGED',
      'Runtime config changed while it was being updated.',
      409,
      'Retry the runtime config change.'
    );
  }
  return jsonError(
    'RUNTIME_CONFIG_UNSUPPORTED',
    'Runtime config store is unavailable.',
    503,
    'Check runtime config store configuration.'
  );
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
  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;
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

function mergeSiteAclEntries(existing, incoming) {
  const entries = new Map(existing.map((entry) => [aclEntryKey(entry), entry]));
  for (const entry of incoming) {
    const key = aclEntryKey(entry);
    if (!entries.has(key)) entries.set(key, entry);
  }
  if (entries.size > MAX_ACL_ENTRIES) {
    return jsonError('ACL_ENTRIES_INVALID', 'ACL entries are invalid.', 400, 'A site can have at most 200 ACL entries.');
  }
  return [...entries.values()];
}

function removeSiteAclEntries(existing, removed) {
  const removedKeys = new Set(removed.map(aclEntryKey));
  return existing.filter((entry) => !removedKeys.has(aclEntryKey(entry)));
}

function aclEntryKey(entry) {
  return `${entry.effect || 'allow'}:${entry.subjectType}:${entry.subjectValue}:${entry.accessRole || 'viewer'}`;
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

function matchSiteVars(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/vars$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function matchSiteTransfer(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)\/transfer$/);
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

function runtimeConfigSync(store, env, config) {
  return createRuntimeConfigSync({
    store,
    environment: config.environment,
    createProvider: () => createWfpDeploymentProvider(env, config),
  });
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
