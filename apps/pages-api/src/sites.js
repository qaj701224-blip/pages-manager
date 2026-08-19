import { validateSiteSlug } from '@xd/pages-runtime-protocol';
import { accessModeFromVisibility } from '@xd/pages-access-policy';

import { isWfpWorkerResource } from './admin-resource-governance.js';
import { authenticateApiRequest } from './auth.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newHexId, nextId } from './id.js';
import {
  MAX_SITE_SECRET_VALUE_BYTES,
  normalizeRuntimeSecretName,
  normalizeRuntimeVars,
  runtimeVarsObject,
} from './runtime-config.js';
import { logRuntimeConfigFailure, readRuntimeConfigErrorDiagnostic } from './runtime-config-diagnostics.js';
import { buildRouteSnapshot, writeRouteSnapshot } from './route-snapshot.js';
import { createDeploymentProvider as createWfpDeploymentProvider } from './wfp-provider.js';
import { createSiteWithLegacyV1Takeover } from './legacy-v1/takeover.js';
import { emitSiteDeletedWebhook, emitSiteDisabledWebhook } from './lifecycle-webhooks.js';

const VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const ACL_SUBJECT_TYPES = new Set(['email', 'department']);
const ACL_ACCESS_ROLES = new Set(['viewer']);
const MAX_ACL_ENTRIES = 200;
const MAX_RUNTIME_VAR_BODY_BYTES = 64 * 1024;
const VISIBILITY_ACTION = '请使用 internal、org、acl、owner 或 disabled。';
const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Cell 平台保留项，请换一个业务站点名。';
const DEFAULT_REUSE_HOLD_SECONDS = 300;
const RUNTIME_CONFIG_PROVIDER_TIMEOUT_MS = 15 * 1000;

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
  try {
    mutation = await store.mutateSiteVar({
      environment: config.environment,
      siteId: site.id,
      operation: 'put',
      name,
      value: normalized[name],
      actorId: actor.userId,
      updatedAt: readNow(env),
    });
  } catch (error) {
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
  const syncResult = await syncActiveWfpPlainTextBindings(store, env, config, site, mutation);
  if (syncResult instanceof Response) return syncResult;
  return jsonOk({ var: formatVar(site.slug, mutation.record, { deleted: false, appliesTo: syncResult.appliesTo }) });
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
  try {
    mutation = await store.mutateSiteVar({
      environment: config.environment,
      siteId: site.id,
      operation: 'delete',
      name,
      actorId: actor.userId,
      updatedAt: readNow(env),
    });
  } catch (error) {
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
  const syncResult = await syncActiveWfpPlainTextBindings(store, env, config, site, mutation);
  if (syncResult instanceof Response) return syncResult;
  return jsonOk({ var: formatVar(site.slug, mutation.record, { deleted: true, appliesTo: syncResult.appliesTo }) });
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

  let route;
  let version;
  try {
    route = await store.getRouteBySiteId(site.id, config.environment);
    if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;
    version = await store.getSiteVersion(route.activeVersionId, config.environment);
  } catch {
    return runtimeSecretSyncFailed(env, config, site, {
      stage: 'route_state_read',
      reason: 'store_operation_failed',
    });
  }
  if (!version || (!isWfpRoute(route) && !isWfpVersion(version))) return null;
  if (!versionRequiresWorker(version)) return null;
  const workerName = route.workerName || version.workerName;
  if (!workerName) return null;

  let provider;
  try {
    provider = createWfpDeploymentProvider(env, config);
  } catch {
    return runtimeSecretSyncFailed(env, config, site, {
      stage: 'provider_setup',
      reason: 'provider_configuration_failed',
      action: 'Check platform Worker provider configuration and retry the secret command.',
    });
  }
  try {
    const syncUnderSiteLease = async ({ signal: siteSignal } = {}) => {
      const activeTarget = await resolveActiveWfpWorker(store, config, site);
      if (!activeTarget) return null;
      const syncOnce = async ({ signal: runtimeSignal } = {}) => {
        const latestTarget = await resolveActiveWfpWorker(store, config, site);
        if (!latestTarget || latestTarget.workerName !== activeTarget.workerName) {
          throw new Error('RUNTIME_CONFIG_LOCKED');
        }
        const current = await currentSiteSecretMutation(store, config.environment, site.id, input);
        const signal = combineAbortSignals(siteSignal, runtimeSignal);
        if (current.operation === 'put') {
          if (typeof provider.putSecret !== 'function') return;
          await provider.putSecret({ workerName: latestTarget.workerName, name: current.name, value: current.value, signal });
        } else {
          if (typeof provider.deleteSecret !== 'function') return;
          try {
            await provider.deleteSecret({ workerName: latestTarget.workerName, name: current.name, signal });
          } catch (error) {
            if (!isNotFoundError(error)) throw error;
          }
        }
        const verifiedTarget = await resolveActiveWfpWorker(store, config, site);
        if (!verifiedTarget || verifiedTarget.workerName !== latestTarget.workerName) {
          throw new Error('RUNTIME_CONFIG_LOCKED');
        }
      };
      await withRuntimeConfigSyncLock(store, config.environment, site.id, syncOnce);
      return null;
    };
    if (typeof store.withSiteCommitLock === 'function') {
      return await store.withSiteCommitLock(config.environment, site.id, syncUnderSiteLease, {
        bestEffortRelease: true,
        waitForLockMs: typeof store.withRuntimeConfigLock === 'function' ? RUNTIME_CONFIG_PROVIDER_TIMEOUT_MS : 50,
      });
    }
    return await syncUnderSiteLease();
  } catch (error) {
    if (isRuntimeConfigLockError(error)) return runtimeConfigChanged('Runtime config changed while syncing a secret.');
    if (isSiteCommitLockError(error)) return runtimeConfigChanged('Runtime config changed while syncing a secret.');
    return runtimeSecretSyncFailed(env, config, site);
  }
}

export async function syncActiveWfpPlainTextBindings(store, env, config, site, snapshot) {
  if (typeof store.getRouteBySiteId !== 'function' || typeof store.getSiteVersion !== 'function') {
    return { appliesTo: 'next_deployment' };
  }

  let target;
  try {
    target = await resolveActiveWfpWorker(store, config, site);
  } catch {
    return runtimeVarSyncFailed(env, config, site, {
      stage: 'route_state_read',
      reason: 'store_operation_failed',
    });
  }
  if (!target) return { appliesTo: 'next_deployment' };

  let provider;
  try {
    provider = createWfpDeploymentProvider(env, config);
  } catch {
    logRuntimeConfigFailure(env, {
      operation: 'plain_text_sync',
      environment: config.environment,
      siteId: site.id,
      stage: 'provider_setup',
      reason: 'provider_configuration_failed',
      errorCode: 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
    });
    return jsonError(
      'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
      'Runtime var was saved but the active Worker could not be updated.',
      502,
      'Check platform Worker provider configuration and retry the runtime config change.'
    );
  }
  if (typeof provider.replacePlainTextBindings !== 'function') return { appliesTo: 'next_deployment' };

  const syncUnderSiteLease = async ({ signal: siteSignal } = {}) => {
    let activeTarget;
    try {
      activeTarget = await resolveActiveWfpWorker(store, config, site);
    } catch {
      return runtimeVarSyncFailed(env, config, site, {
        stage: 'route_state_read',
        reason: 'store_operation_failed',
      });
    }
    if (!activeTarget) return { appliesTo: 'next_deployment' };

    const syncOnce = async ({ signal: runtimeSignal } = {}) => {
      const latestTarget = await resolveActiveWfpWorker(store, config, site);
      if (!latestTarget || latestTarget.workerName !== activeTarget.workerName) {
        throw new Error('RUNTIME_CONFIG_LOCKED');
      }
      const vars =
        typeof store.listEnabledSiteVars === 'function'
          ? runtimeVarsObject(await store.listEnabledSiteVars(config.environment, site.id))
          : runtimeVarsObject(snapshot?.vars || []);
      await provider.replacePlainTextBindings({
        workerName: latestTarget.workerName,
        vars,
        signal: combineAbortSignals(siteSignal, runtimeSignal),
      });
      const verifiedTarget = await resolveActiveWfpWorker(store, config, site);
      if (!verifiedTarget || verifiedTarget.workerName !== latestTarget.workerName) {
        throw new Error('RUNTIME_CONFIG_LOCKED');
      }
      return { appliesTo: 'active_worker' };
    };

    if (typeof store.withRuntimeConfigLock === 'function') {
      return store.withRuntimeConfigLock(config.environment, site.id, syncOnce);
    }

    if (!Array.isArray(snapshot?.vars)) {
      await withRuntimeConfigSyncLock(store, config.environment, site.id, syncOnce);
      return { appliesTo: 'active_worker' };
    }

    let current = snapshot;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await withRuntimeConfigSyncLock(store, config.environment, site.id, async ({ signal } = {}) => {
        const latestTarget = await resolveActiveWfpWorker(store, config, site);
        if (!latestTarget || latestTarget.workerName !== activeTarget.workerName) {
          throw new Error('RUNTIME_CONFIG_LOCKED');
        }
        await provider.replacePlainTextBindings({
          workerName: latestTarget.workerName,
          vars: runtimeVarsObject(current.vars),
          signal: combineAbortSignals(siteSignal, signal),
        });
      });
      const routeState = await readRuntimeConfigRouteState(store, config.environment, site.id);
      const generation = Number(routeState?.runtimeConfigGeneration || 0);
      const verifiedTarget = await resolveActiveWfpWorker(store, config, site);
      if (!verifiedTarget || verifiedTarget.workerName !== activeTarget.workerName) {
        throw new Error('RUNTIME_CONFIG_LOCKED');
      }
      if (generation === Number(current.generation || 0)) return { appliesTo: 'active_worker' };
      current = {
        vars: await store.listEnabledSiteVars(config.environment, site.id),
        generation,
      };
    }
    return jsonError('RUNTIME_CONFIG_CHANGED', 'Runtime config changed while syncing.', 409, 'Retry the runtime config change.');
  };

  try {
    if (typeof store.withSiteCommitLock === 'function') {
      return await store.withSiteCommitLock(config.environment, site.id, syncUnderSiteLease, {
        bestEffortRelease: true,
        waitForLockMs: typeof store.withRuntimeConfigLock === 'function' ? RUNTIME_CONFIG_PROVIDER_TIMEOUT_MS : 50,
      });
    }
    return await syncUnderSiteLease();
  } catch (error) {
    if (isRuntimeConfigLockError(error)) return runtimeConfigChanged('Runtime config changed while syncing.');
    if (isSiteCommitLockError(error)) return { appliesTo: 'next_deployment' };
    return runtimeVarSyncFailed(env, config, site);
  }
}

async function withRuntimeConfigSyncLock(store, environment, siteId, callback) {
  if (typeof store.withRuntimeConfigLock !== 'function') return withProviderTimeout(callback);
  return store.withRuntimeConfigLock(environment, siteId, callback);
}

async function withProviderTimeout(callback) {
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort(new Error('RUNTIME_CONFIG_PROVIDER_TIMEOUT'));
  }, RUNTIME_CONFIG_PROVIDER_TIMEOUT_MS);
  try {
    return await callback({ signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function combineAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof globalThis.AbortSignal?.any === 'function') return globalThis.AbortSignal.any(activeSignals);
  const controller = new globalThis.AbortController();
  for (const activeSignal of activeSignals) {
    if (activeSignal.aborted) {
      controller.abort(activeSignal.reason);
      break;
    }
    activeSignal.addEventListener('abort', () => controller.abort(activeSignal.reason), { once: true });
  }
  return controller.signal;
}

async function currentSiteSecretMutation(store, environment, siteId, input) {
  if (typeof store.listEnabledSiteSecrets !== 'function') return input;
  const secrets = await store.listEnabledSiteSecrets(environment, siteId);
  const current = secrets.find((secret) => secret.name === input.name);
  return current ? { operation: 'put', name: current.name, value: current.value } : { operation: 'delete', name: input.name };
}

function isRuntimeConfigLockError(error) {
  return error instanceof Error && error.message === 'RUNTIME_CONFIG_LOCKED';
}

function isSiteCommitLockError(error) {
  return error?.code === 'SITE_POLICY_LOCKED' || error?.code === 'SITE_COMMIT_TIMEOUT';
}

function runtimeConfigChanged(message) {
  return jsonError('RUNTIME_CONFIG_CHANGED', message, 409, 'Retry the runtime config change.');
}

async function resolveActiveWfpWorker(store, config, site) {
  const route = await store.getRouteBySiteId(site.id, config.environment);
  if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;
  const version = await store.getSiteVersion(route.activeVersionId, config.environment);
  if (!version || (!isWfpRoute(route) && !isWfpVersion(version))) return null;
  if (!versionRequiresWorker(version)) return null;
  const workerName = route.workerName || version.workerName;
  return workerName ? { workerName } : null;
}

async function readRuntimeConfigRouteState(store, environment, siteId) {
  if (typeof store.getRuntimeConfigRouteState === 'function') {
    return store.getRuntimeConfigRouteState(environment, siteId);
  }
  return store.getRouteBySiteId(siteId, environment);
}

function runtimeSecretSyncFailed(
  env,
  config,
  site,
  {
    stage = 'provider_sync',
    reason = 'provider_request_failed',
    action = 'Retry the secret command before testing the current Worker.',
  } = {}
) {
  logRuntimeConfigFailure(env, {
    operation: 'secret_sync',
    environment: config.environment,
    siteId: site.id,
    stage,
    reason,
    errorCode: 'SECRET_ACTIVE_WORKER_SYNC_FAILED',
  });
  return jsonError(
    'SECRET_ACTIVE_WORKER_SYNC_FAILED',
    'Runtime secret was saved but the active Worker could not be updated.',
    502,
    action
  );
}

function runtimeVarSyncFailed(env, config, site, { stage = 'provider_sync', reason = 'provider_request_failed' } = {}) {
  logRuntimeConfigFailure(env, {
    operation: 'plain_text_sync',
    environment: config.environment,
    siteId: site.id,
    stage,
    reason,
    errorCode: 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
  });
  return jsonError(
    'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
    'Runtime var was saved but the active Worker could not be updated.',
    502,
    'Retry the runtime config change before testing the current Worker.'
  );
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
  if (!VISIBILITIES.has(visibility)) {
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
  const deletedAt = readNow(env);
  const reuseHoldUntil = addSecondsIso(deletedAt, readReuseHoldSeconds(env));
  const previousRoute = site.route || (await store.getRouteBySiteId(site.id, config.environment));
  const previousHostnameClaim = previousRoute?.hostname ? await store.getHostnameClaim(previousRoute.hostname) : null;
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
    if (snapshotError) {
      await restoreSiteDeleteAfterSnapshotFailure(
        store,
        site.id,
        site,
        previousRoute,
        previousHostnameClaim,
        route,
        config.environment
      );
      return snapshotError;
    }
  }
  await enqueueDeletedSiteWfpCleanup(store, env, config, site, previousRoute, reuseHoldUntil);
  await emitSiteDeletedWebhook({ store, env, config, ctx, actor, site: deleted, previousRoute, route });
  return jsonOk({ site: formatSite({ ...deleted, route }) });
}

export async function enqueueDeletedSiteWfpCleanup(store, env, config, site, previousRoute, cleanupAfter) {
  if (typeof store.createDeploymentResourceCleanupTask !== 'function') return;
  const resourcesByWorker = new Map();
  if (isWfpWorkerResource(previousRoute, config.environment)) {
    resourcesByWorker.set(previousRoute.workerName, {
      workerName: previousRoute.workerName,
      siteId: site.id,
      versionId: previousRoute.activeVersionId || null,
    });
  }

  if (typeof store.listSiteWfpCleanupReferences === 'function') {
    try {
      const references = await store.listSiteWfpCleanupReferences({
        siteId: site.id,
        environment: config.environment,
      });
      for (const route of references?.activeRoutes || []) {
        if (!isWfpWorkerResource(route, config.environment)) continue;
        resourcesByWorker.set(route.workerName, {
          workerName: route.workerName,
          siteId: route.siteId || site.id,
          versionId: route.versionId || null,
        });
      }
      for (const version of references?.versions || []) {
        if (!isWfpWorkerResource(version, config.environment)) continue;
        resourcesByWorker.set(version.workerName, {
          workerName: version.workerName,
          siteId: version.siteId || site.id,
          versionId: version.id || null,
        });
      }
    } catch {
      // The site deletion is already committed; cleanup remains best-effort post-commit maintenance.
    }
  }

  for (const resource of resourcesByWorker.values()) {
    try {
      await store.createDeploymentResourceCleanupTask({
        id: nextId(env, 'cln'),
        environment: config.environment,
        resourceType: 'wfp_user_worker',
        resourceRef: resource.workerName,
        siteId: resource.siteId,
        versionId: resource.versionId,
        deploymentId: null,
        cleanupReason: 'site_deleted',
        status: 'pending',
        cleanupAfter,
        createdAt: readNow(env),
        updatedAt: readNow(env),
      });
    } catch {
      // Cleanup is post-commit maintenance. A successful site delete must stay successful.
    }
  }
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

  const updatedAt = readNow(env);
  const updated = await store.transferSiteOwner(
    site.id,
    {
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      ownerUserId: target.ownerUserId,
      updatedAt,
      auditEvent: buildSiteOwnerTransferAuditEvent(env, config, actor, site, target, {
        source: 'api',
        createdAt: updatedAt,
      }),
    },
    config.environment
  );
  if (!updated) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');

  const route = await store.getRouteBySiteId(updated.id, config.environment);
  const snapshotError = await refreshActiveRouteSnapshot(env, store, updated, route, config.environment);
  if (snapshotError) return snapshotError;

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

export async function mutateUserSiteAccessPolicy({ env, config, store, siteId, actorUserId, visibility, resolveAclEntries }) {
  try {
    return await store.withSiteCommitLock(
      config.environment,
      siteId,
      async (lease) => {
        const currentSite = await store.getSite(siteId, config.environment);
        const currentRoute = await store.getRouteBySiteId(siteId, config.environment);
        if (!currentSite || !currentRoute) {
          return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
        }

        const previousAclEntries = await store.listSiteAclEntries(siteId);
        const nextAclEntries = resolveAclEntries ? resolveAclEntries(previousAclEntries) : undefined;
        if (nextAclEntries instanceof Response) return nextAclEntries;
        const updatedAt = readNow(env);
        const mutation = await store.updateSiteAccessPolicy({
          environment: config.environment,
          siteId,
          actorUserId,
          ...(visibility === undefined ? {} : { accessMode: accessModeFromVisibility(visibility) }),
          ...(resolveAclEntries ? { aclEntries: nextAclEntries } : {}),
          expected: sitePolicyExpected(currentRoute),
          lease,
          updatedAt,
        });

        const snapshotError = await refreshActiveRouteSnapshot(
          env,
          store,
          mutation.site,
          mutation.route,
          config.environment,
          mutation.aclEntries
        );
        if (!snapshotError) return mutation;

        let compensation;
        try {
          const latestRoute = await store.getRouteBySiteId(siteId, config.environment);
          if (!sitePolicyRouteCanBeCompensated(latestRoute, mutation.route)) return routePolicyRepairRequired();
          compensation = await store.updateSiteAccessPolicy({
            environment: config.environment,
            siteId,
            actorUserId,
            exposure: previousRouteExposure(currentRoute),
            accessMode: accessModeFromVisibility(currentRoute.visibility),
            aclEntries: previousAclEntries,
            expected: sitePolicyExpected(latestRoute),
            lease,
            updatedAt,
          });
        } catch {
          return routePolicyRepairRequired();
        }

        const compensationSnapshotError = await refreshActiveRouteSnapshot(
          env,
          store,
          compensation.site,
          compensation.route,
          config.environment,
          compensation.aclEntries
        );
        return compensationSnapshotError ? routePolicyRepairRequired() : snapshotError;
      },
      { bestEffortRelease: true }
    );
  } catch (error) {
    if (isSitePolicyMutationConflict(error)) {
      return jsonError(
        'SITE_POLICY_CONFLICT',
        'Site policy changed while the access update was being applied.',
        409,
        'Refresh the site and retry.'
      );
    }
    return jsonError(
      'SITE_POLICY_UPDATE_FAILED',
      'Site access policy could not be updated.',
      503,
      'Retry after refreshing the site.'
    );
  }
}

function sitePolicyExpected(route) {
  return {
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    activeVersionId: route.activeVersionId,
    runtimeConfigGeneration: route.runtimeConfigGeneration,
  };
}

function previousRouteExposure(route) {
  return route.exposure === 'public' ? 'public' : 'internal';
}

function sitePolicyRouteCanBeCompensated(current, committed) {
  if (!current || !committed) return false;
  return (
    current.id === committed.id &&
    current.environment === committed.environment &&
    current.siteId === committed.siteId &&
    current.exposure === committed.exposure &&
    current.accessMode === committed.accessMode &&
    current.visibility === committed.visibility &&
    current.policyVersion === committed.policyVersion &&
    current.routeGeneration === committed.routeGeneration &&
    current.activeVersionId === committed.activeVersionId &&
    current.routeStatus === committed.routeStatus
  );
}

function isSitePolicyMutationConflict(error) {
  return ['SITE_POLICY_LOCKED', 'SITE_POLICY_CONFLICT', 'SITE_COMMIT_TIMEOUT'].includes(error?.code || error?.message);
}

function routePolicyRepairRequired() {
  return jsonError(
    'ROUTE_POLICY_REPAIR_REQUIRED',
    'Route policy could not be confirmed effective.',
    503,
    'Repair the route snapshot before retrying.'
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
  if (!VISIBILITIES.has(visibility)) {
    return jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, VISIBILITY_ACTION);
  }
  if (ownerType === 'team' && visibility === 'owner') return teamOwnerVisibilityUnsupported();

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
    site = await createSiteWithLegacyV1Takeover({
      env,
      config,
      store,
      actor,
      siteInput: {
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
      },
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
    return jsonError('TEAM_PUBLISHER_REQUIRED', 'Team publisher role required.', 403, 'Ask a team publisher to create the site.');
  }
  return { ownerId: team.id };
}

export function siteCreateErrorResponse(error) {
  const message = error instanceof Error ? error.message : '';
  const code = error?.code || message;
  if (/SITE_SLUG_CONFLICT/.test(message)) {
    return jsonError('SITE_SLUG_CONFLICT', 'Site slug already exists.', 409, 'Choose a different site slug.');
  }
  if (code === 'V1_TAKEOVER_STATE_CHANGED') {
    return jsonError('HOSTNAME_CLAIM_CONFLICT', 'Site hostname is already claimed.', 409, '请检查站点状态后重试。');
  }
  if (/HOSTNAME_CLAIM_CONFLICT/.test(message)) {
    return jsonError(
      'HOSTNAME_CLAIM_CONFLICT',
      'Site hostname is already claimed.',
      409,
      '请换一个站点名，或使用原站点 owner 继续部署。'
    );
  }
  if (code === 'V1_TAKEOVER_CONFIG_UNAVAILABLE' || code === 'V1_TAKEOVER_CLEANUP_FAILED') {
    return jsonError(
      'SITE_CREATE_UNAVAILABLE',
      'Site could not be created right now.',
      503,
      'Retry later with the same site name.'
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

export function hostnameForSlug(slug, config) {
  if (config.environment === 'staging') return `${slug}-staging.${config.siteDomainSuffix}`;
  return `${slug}.${config.siteDomainSuffix}`;
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

export function actorCanManageSite(actor, site) {
  if (!site) return false;
  if (actor.type === 'access_key') {
    if (actor.siteId && actor.siteId !== site.id) return false;
    if (!actorHasPublishScope(actor)) return false;
    const ownerType = actor.ownerType || 'user';
    const ownerId = actor.ownerId || actor.userId;
    if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === ownerId;
    if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
    return (site.ownerId || site.ownerUserId) === ownerId;
  }
  if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
  return (site.ownerId || site.ownerUserId) === actor.userId;
}

function actorHasPublishScope(actor) {
  return actor.type !== 'access_key' || actor.scopes.includes('deploy:site') || actor.scopes.includes('*');
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

export async function refreshActiveRouteSnapshot(env, store, site, route, environment, knownAclEntries) {
  if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;

  const version = await store.getSiteVersion(route.activeVersionId, environment);
  if (!version) {
    return jsonError('ROUTE_VERSION_NOT_FOUND', 'Active route version was not found.', 500, 'Check route consistency.');
  }
  const aclEntries = knownAclEntries || (await store.listSiteAclEntries(site.id));
  try {
    await writeRouteSnapshot(env, buildRouteSnapshot({ site, route, version, aclEntries }));
  } catch {
    return jsonError('ROUTE_SNAPSHOT_WRITE_FAILED', 'Route snapshot could not be written.', 503, 'Retry the policy update.');
  }
  return null;
}

export async function refreshCurrentRouteSnapshot(env, store, site, route, environment) {
  if (!route) return null;
  const version = route.activeVersionId
    ? await store.getSiteVersion(route.activeVersionId, environment)
    : inactiveRouteVersion(route);
  if (!version && route.routeStatus === 'active') {
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

function inactiveRouteVersion(route) {
  return {
    id: null,
    executionProvider: route.executionProvider,
    dispatchType: route.dispatchType,
    dispatchBindingName: route.dispatchBindingName,
    slotId: route.slotId,
    contentHash: null,
    deploymentShape: 'inactive',
    resolvedFallback: null,
    routingMode: null,
  };
}

function routeWasActive(route) {
  return route?.routeStatus === 'active' && Boolean(route.activeVersionId);
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

export async function restoreSiteDeleteAfterSnapshotFailure(
  store,
  siteId,
  previousSite,
  previousRoute,
  previousHostnameClaim,
  expectedRoute,
  environment
) {
  if (typeof store.restoreSiteDeleteIfCurrent === 'function') {
    return store.restoreSiteDeleteIfCurrent(
      siteId,
      previousSite,
      previousRoute,
      previousHostnameClaim,
      expectedRoute,
      environment
    );
  }
  if (typeof store.restoreSiteRouteIfCurrent === 'function') {
    return store.restoreSiteRouteIfCurrent(siteId, previousRoute, expectedRoute, environment);
  }
  return store.restoreSiteRoute(siteId, previousRoute, environment);
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
