import { isSiteVisibility, teamOwnerSupportsVisibility } from '../../domain/sites/access-policy.js';
import { viewerCanAdminSite, viewerCanPublishSite } from '../../domain/sites/authorization.js';
import { jsonError, jsonOk, readJsonBody } from '../../http.js';
import { emitSiteDisabledWebhook } from '../../lifecycle-webhooks.js';
import { MAX_SITE_SECRET_VALUE_BYTES, normalizeRuntimeSecretName, normalizeRuntimeVars } from '../../runtime-config.js';
import { logRuntimeConfigFailure, readRuntimeConfigErrorDiagnostic } from '../../runtime-config-diagnostics.js';
import {
  createRuntimeConfigApplication,
  createRuntimeConfigReadApplication,
  runtimeConfigSyncErrorResponse,
} from '../shared/runtime-config-application.js';
import { createSiteLifecycleApplication, siteDeleteErrorResponse } from '../shared/site-lifecycle-application.js';
import { mutateUserSiteAccessPolicy } from '../shared/site-policy-application.js';
import { normalizeSiteAclInput, rejectUserExposureMutation } from '../shared/site-input.js';
import {
  formatAclEntry,
  formatDeletedSiteVarMutation,
  formatSiteSecret,
  formatSiteVar,
  formatSiteVarMutation,
  formatWorkspaceSite,
} from './site-projections.js';

export async function deleteConsoleSite(env, config, store, site, options = {}) {
  if (!options.force && !viewerCanPublishSite(site)) {
    return jsonError(
      'SITE_DELETE_FORBIDDEN',
      'Site publisher role required.',
      403,
      'Use the site owner account or a team publisher/admin account.'
    );
  }

  let deleted;
  let route;
  try {
    const result = await createSiteLifecycleApplication({ store, env, config, ctx: options.ctx })({
      environment: config.environment,
      site,
      actor: options.actor,
      compensateSnapshotFailure: false,
    });
    deleted = result.site;
    route = result.route;
  } catch (error) {
    return siteDeleteErrorResponse(error);
  }
  return jsonOk({ site: formatWorkspaceSite({ ...deleted, route }) });
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

  const exposureError = rejectUserExposureMutation(body);
  if (exposureError) return exposureError;

  const visibility = typeof body.visibility === 'string' ? body.visibility : site.route?.visibility || site.defaultVisibility;
  if (!isSiteVisibility(visibility)) {
    return jsonError(
      'SITE_VISIBILITY_INVALID',
      'Site visibility is invalid.',
      400,
      '请使用 internal、org、acl、owner 或 disabled。'
    );
  }
  if (!teamOwnerSupportsVisibility(site, visibility)) return teamOwnerVisibilityUnsupported();
  const aclEntries = 'aclEntries' in body ? normalizeSiteAclInput(body.aclEntries, env) : previousAclEntries;
  if (aclEntries instanceof Response) return aclEntries;

  const mutation = await mutateUserSiteAccessPolicy({
    env,
    config,
    store,
    siteId: site.id,
    actorUserId: session.userId,
    visibility,
    ...(Array.isArray(body.aclEntries) ? { resolveAclEntries: () => aclEntries } : {}),
  });
  if (mutation instanceof Response) return mutation;

  await emitSiteDisabledWebhook({
    store,
    env,
    config,
    ctx: options.ctx,
    actor: session,
    site: mutation.site,
    previousRoute,
    route: mutation.route,
  });

  return jsonOk({
    access: {
      visibility: mutation.route.visibility,
      aclEntries: mutation.aclEntries.map(formatAclEntry),
    },
  });
}

export async function putSiteVar(request, env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
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
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const normalized = normalizeVarPatch(name, body.value);
  if (normalized instanceof Response) return normalized;
  let mutation;
  let syncResult;
  try {
    const result = await createRuntimeConfigApplication({ store, env, config }).mutateVar({
      environment: config.environment,
      site,
      actor: consoleActor(session),
      operation: 'put',
      name: normalized.name,
      value: normalized.value,
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
  return jsonOk({ var: formatSiteVarMutation(mutation.record, syncResult.appliesTo) });
}

export async function deleteSiteVar(env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
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

  const normalized = normalizeVarName(name);
  if (normalized instanceof Response) return normalized;
  let syncResult;
  try {
    const result = await createRuntimeConfigApplication({ store, env, config }).mutateVar({
      environment: config.environment,
      site,
      actor: consoleActor(session),
      operation: 'delete',
      name: normalized,
    });
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
  return jsonOk({ var: formatDeletedSiteVarMutation(normalized, syncResult.appliesTo) });
}

export async function putSiteSecret(request, env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
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
    const { secret } = await createRuntimeConfigApplication({ store, env, config }).putSecret({
      environment: config.environment,
      site,
      actor: consoleActor(session),
      name: normalizedName,
      value: body.value,
    });
    return jsonOk({ secret: formatSiteSecret(secret) });
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

export async function deleteSiteSecret(env, config, store, session, siteId, name, options = {}) {
  const site = options.site || (await requireConsoleSiteRole(store, config, session, siteId, 'publisher'));
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
  const normalizedName = normalizeSecretNameForResponse(name);
  if (normalizedName instanceof Response) return normalizedName;

  try {
    await createRuntimeConfigApplication({ store, env, config }).deleteSecret({
      environment: config.environment,
      site,
      actor: consoleActor(session),
      name: normalizedName,
    });
    return jsonOk({ secret: { name: normalizedName, deleted: true } });
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

export async function readSiteConfig(env, config, store, site) {
  try {
    const reader = createRuntimeConfigReadApplication({ store });
    const vars = await reader.listVars({ environment: config.environment, siteId: site.id });
    const secrets = await reader.listSecretMetadata({ environment: config.environment, siteId: site.id });
    return jsonOk({
      config: {
        vars: vars.map(formatSiteVar),
        secrets: secrets.map(formatSiteSecret),
      },
    });
  } catch (error) {
    logRuntimeConfigFailure(env, {
      operation: 'config_list',
      environment: config.environment,
      siteId: site.id,
      ...readRuntimeConfigErrorDiagnostic(error, {
        stage: error?.message === 'RUNTIME_CONFIG_UNSUPPORTED' ? 'capability_check' : 'read',
        reason: error?.message === 'RUNTIME_CONFIG_UNSUPPORTED' ? 'capability_unavailable' : 'store_operation_failed',
      }),
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
    return jsonError('RUNTIME_CONFIG_UNSUPPORTED', 'Runtime config store is unavailable.', 503, 'Retry later.');
  }
}

export function teamOwnerVisibilityUnsupported() {
  return jsonError(
    'SITE_VISIBILITY_INVALID',
    'Team-owned sites cannot use owner visibility.',
    400,
    '团队站点请使用 internal、org、acl 或 disabled。'
  );
}

async function requireConsoleSiteRole(store, config, session, siteId, role) {
  const site = await store.getConsoleSiteDetail({
    environment: config.environment,
    userId: session.userId,
    siteId,
  });
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (role === 'admin' && !viewerCanAdminSite(site)) {
    return jsonError('SITE_ADMIN_REQUIRED', 'Site admin role required.', 403, 'Ask a site or team admin to perform this action.');
  }
  if (role === 'publisher' && !viewerCanPublishSite(site)) {
    return jsonError('SITE_PUBLISHER_REQUIRED', 'Site publisher role required.', 403, 'Ask a site or team publisher.');
  }
  return site;
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

function byteLength(value) {
  return new globalThis.TextEncoder().encode(String(value)).byteLength;
}

function isRuntimeConfigConflict(error) {
  return String(error?.message || error).includes('SITE_SECRET_REVISION_CONFLICT');
}

function consoleActor(session) {
  return { type: 'user', userId: session.userId };
}
