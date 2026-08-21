import { actorCanManageSite } from '../../domain/sites/authorization.js';
import { jsonError, jsonOk, readJsonBody } from '../../http.js';
import {
  MAX_SITE_SECRET_VALUE_BYTES,
  normalizeRuntimeSecretName,
  normalizeRuntimeVars,
} from '../../runtime-config.js';
import { logRuntimeConfigFailure, readRuntimeConfigErrorDiagnostic } from '../../runtime-config-diagnostics.js';
import {
  createRuntimeConfigApplication,
  runtimeConfigSyncErrorResponse,
} from '../shared/runtime-config-application.js';
import { normalizeSiteSlug, validateSiteSlugInput } from '../shared/site-input.js';

const MAX_RUNTIME_VAR_BODY_BYTES = 64 * 1024;

export async function putSiteVar(request, env, config, store, actor, siteSlug) {
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

  try {
    const result = await createRuntimeConfigApplication({ store, env, config }).mutateVar({
      environment: config.environment,
      site,
      actor,
      operation: 'put',
      name,
      value: normalized[name],
    });
    return jsonOk({
      var: formatVar(site.slug, result.mutation.record, {
        deleted: false,
        appliesTo: result.syncResult.appliesTo,
      }),
    });
  } catch (error) {
    return runtimeVarFailureResponse(error, { env, config, site, operation: 'var_put' });
  }
}

export async function deleteSiteVar(request, env, config, store, actor, siteSlug) {
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

  try {
    const result = await createRuntimeConfigApplication({ store, env, config }).mutateVar({
      environment: config.environment,
      site,
      actor,
      operation: 'delete',
      name,
    });
    return jsonOk({
      var: formatVar(site.slug, result.mutation.record, {
        deleted: true,
        appliesTo: result.syncResult.appliesTo,
      }),
    });
  } catch (error) {
    return runtimeVarFailureResponse(error, { env, config, site, operation: 'var_delete' });
  }
}

export async function putSiteSecret(request, env, config, store, actor, siteSlug) {
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
    return runtimeSecretFailureResponse(error, { env, config, site, operation: 'secret_put', deleting: false });
  }
}

export async function deleteSiteSecret(request, env, config, store, actor, siteSlug) {
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
    return runtimeSecretFailureResponse(error, { env, config, site, operation: 'secret_delete', deleting: true });
  }
}

async function getRuntimeManageableSiteBySlug(store, actor, siteSlug, environment) {
  const slug = normalizeSiteSlug(siteSlug);
  const slugError = validateSiteSlugInput(slug, environment);
  if (slugError) return slugError;
  const site = await store.findSiteBySlug(environment, slug);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug.');
  const visible = await store.getSiteForUser(site.id, actor.userId, actor, environment);
  if (!visible) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug and token scope.');
  if (!actorCanManageSite(actor, visible)) {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot manage runtime config for this site.',
      403,
      'Use a publisher or admin role for this site.'
    );
  }
  return visible;
}

function runtimeVarFailureResponse(error, { env, config, site, operation }) {
  const syncResponse = runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'var' });
  if (syncResponse) return syncResponse;
  const response = runtimeVarMutationError(error);
  if (response.status >= 500) {
    const diagnostic = readRuntimeConfigErrorDiagnostic(error, {
      stage: 'unknown',
      reason: 'store_operation_failed',
    });
    logRuntimeConfigFailure(env, {
      operation,
      environment: config.environment,
      siteId: site.id,
      ...diagnostic,
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    });
  }
  return response;
}

function runtimeSecretFailureResponse(error, { env, config, site, operation, deleting }) {
  const syncResponse = runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'secret' });
  if (syncResponse) return syncResponse;
  if (!deleting && error?.message === 'RUNTIME_BINDING_NAME_CONFLICT') {
    return jsonError(
      'RUNTIME_BINDING_NAME_CONFLICT',
      'Runtime binding names conflict.',
      400,
      'Use unique names for vars and site secrets.'
    );
  }
  if (!deleting && error?.message === 'RUNTIME_BINDINGS_LIMIT_EXCEEDED') {
    return jsonError(
      'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
      'Runtime bindings exceed platform limits.',
      413,
      'Reduce vars or site secrets and retry.'
    );
  }
  if (isRuntimeConfigConflict(error)) {
    const message = deleting
      ? 'Runtime secret changed while it was being deleted.'
      : 'Runtime secret changed while it was being updated.';
    return jsonError('RUNTIME_CONFIG_CHANGED', message, 409, 'Retry the secret command.');
  }
  const response = jsonError(
    'RUNTIME_CONFIG_UNSUPPORTED',
    'Runtime secret store is unavailable.',
    503,
    'Check runtime secret store configuration.'
  );
  logRuntimeConfigFailure(env, {
    operation,
    environment: config.environment,
    siteId: site.id,
    ...readRuntimeConfigErrorDiagnostic(error, { stage: 'unknown', reason: 'store_operation_failed' }),
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
  return response;
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
