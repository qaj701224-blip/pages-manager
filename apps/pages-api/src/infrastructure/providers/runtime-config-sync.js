import { runtimeVarsObject } from '../../domain/runtime-config/rules.js';

const DEFAULT_PROVIDER_TIMEOUT_MS = 15 * 1000;

export function createRuntimeConfigSync({ store, createProvider, environment, providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS }) {
  if (!store || typeof store !== 'object') throw new TypeError('runtime config store is required');
  if (typeof createProvider !== 'function') throw new TypeError('createProvider is required');

  return {
    syncSecret: (input) => syncSecret({ store, createProvider, environment, providerTimeoutMs }, input),
    syncPlainText: (input) => syncPlainText({ store, createProvider, environment, providerTimeoutMs }, input),
  };
}

async function syncSecret(context, { site, mutation }) {
  const { store, environment } = context;
  if (typeof store.getRouteBySiteId !== 'function' || typeof store.getSiteVersion !== 'function') return null;

  let route;
  let version;
  try {
    route = await store.getRouteBySiteId(site.id, environment);
    if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;
    version = await store.getSiteVersion(route.activeVersionId, environment);
  } catch {
    throw syncError('SECRET_ACTIVE_WORKER_SYNC_FAILED', 'route_state_read', 'store_operation_failed');
  }
  if (!version || (!isWfpRoute(route) && !isWfpVersion(version))) return null;
  if (!versionRequiresWorker(version)) return null;
  const workerName = route.workerName || version.workerName;
  if (!workerName) return null;

  let provider;
  try {
    provider = context.createProvider();
  } catch {
    throw syncError('SECRET_ACTIVE_WORKER_SYNC_FAILED', 'provider_setup', 'provider_configuration_failed');
  }

  try {
    const syncUnderSiteLease = async ({ signal: siteSignal } = {}) => {
      const activeTarget = await resolveActiveWfpWorker(store, environment, site);
      if (!activeTarget) return null;
      const syncOnce = async ({ signal: runtimeSignal } = {}) => {
        const latestTarget = await resolveActiveWfpWorker(store, environment, site);
        if (!latestTarget || latestTarget.workerName !== activeTarget.workerName) throw lockedError();
        const current = await currentSiteSecretMutation(store, environment, site.id, mutation);
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
        const verifiedTarget = await resolveActiveWfpWorker(store, environment, site);
        if (!verifiedTarget || verifiedTarget.workerName !== latestTarget.workerName) throw lockedError();
      };
      await withRuntimeConfigSyncLock(store, environment, site.id, context.providerTimeoutMs, syncOnce);
      return null;
    };
    if (typeof store.withSiteCommitLock === 'function') {
      return await store.withSiteCommitLock(environment, site.id, syncUnderSiteLease, {
        bestEffortRelease: true,
        waitForLockMs: typeof store.withRuntimeConfigLock === 'function' ? context.providerTimeoutMs : 50,
      });
    }
    return await syncUnderSiteLease();
  } catch (error) {
    if (isRuntimeConfigLockError(error) || isSiteCommitLockError(error)) {
      throw syncError('RUNTIME_CONFIG_CHANGED', 'provider_sync', 'runtime_config_changed');
    }
    throw syncError('SECRET_ACTIVE_WORKER_SYNC_FAILED', 'provider_sync', 'provider_request_failed');
  }
}

async function syncPlainText(context, { site, snapshot }) {
  const { store, environment } = context;
  if (typeof store.getRouteBySiteId !== 'function' || typeof store.getSiteVersion !== 'function') {
    return { appliesTo: 'next_deployment' };
  }

  let target;
  try {
    target = await resolveActiveWfpWorker(store, environment, site);
  } catch {
    throw syncError('RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED', 'route_state_read', 'store_operation_failed');
  }
  if (!target) return { appliesTo: 'next_deployment' };

  let provider;
  try {
    provider = context.createProvider();
  } catch {
    throw syncError('RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED', 'provider_setup', 'provider_configuration_failed');
  }
  if (typeof provider.replacePlainTextBindings !== 'function') return { appliesTo: 'next_deployment' };

  const syncUnderSiteLease = async ({ signal: siteSignal } = {}) => {
    let activeTarget;
    try {
      activeTarget = await resolveActiveWfpWorker(store, environment, site);
    } catch {
      throw syncError('RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED', 'route_state_read', 'store_operation_failed');
    }
    if (!activeTarget) return { appliesTo: 'next_deployment' };

    const syncOnce = async ({ signal: runtimeSignal } = {}) => {
      const latestTarget = await resolveActiveWfpWorker(store, environment, site);
      if (!latestTarget || latestTarget.workerName !== activeTarget.workerName) throw lockedError();
      const vars =
        typeof store.listEnabledSiteVars === 'function'
          ? runtimeVarsObject(await store.listEnabledSiteVars(environment, site.id))
          : runtimeVarsObject(snapshot?.vars || []);
      await provider.replacePlainTextBindings({
        workerName: latestTarget.workerName,
        vars,
        signal: combineAbortSignals(siteSignal, runtimeSignal),
      });
      const verifiedTarget = await resolveActiveWfpWorker(store, environment, site);
      if (!verifiedTarget || verifiedTarget.workerName !== latestTarget.workerName) throw lockedError();
      return { appliesTo: 'active_worker' };
    };

    if (typeof store.withRuntimeConfigLock === 'function') {
      return store.withRuntimeConfigLock(environment, site.id, syncOnce);
    }

    if (!Array.isArray(snapshot?.vars)) {
      await withRuntimeConfigSyncLock(store, environment, site.id, context.providerTimeoutMs, syncOnce);
      return { appliesTo: 'active_worker' };
    }

    let current = snapshot;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await withRuntimeConfigSyncLock(
        store,
        environment,
        site.id,
        context.providerTimeoutMs,
        async ({ signal } = {}) => {
          const latestTarget = await resolveActiveWfpWorker(store, environment, site);
          if (!latestTarget || latestTarget.workerName !== activeTarget.workerName) throw lockedError();
          await provider.replacePlainTextBindings({
            workerName: latestTarget.workerName,
            vars: runtimeVarsObject(current.vars),
            signal: combineAbortSignals(siteSignal, signal),
          });
        }
      );
      const routeState = await readRuntimeConfigRouteState(store, environment, site.id);
      const generation = Number(routeState?.runtimeConfigGeneration || 0);
      const verifiedTarget = await resolveActiveWfpWorker(store, environment, site);
      if (!verifiedTarget || verifiedTarget.workerName !== activeTarget.workerName) throw lockedError();
      if (generation === Number(current.generation || 0)) return { appliesTo: 'active_worker' };
      current = {
        vars: await store.listEnabledSiteVars(environment, site.id),
        generation,
      };
    }
    throw syncError('RUNTIME_CONFIG_CHANGED', 'provider_sync', 'runtime_config_changed');
  };

  try {
    if (typeof store.withSiteCommitLock === 'function') {
      return await store.withSiteCommitLock(environment, site.id, syncUnderSiteLease, {
        bestEffortRelease: true,
        waitForLockMs: typeof store.withRuntimeConfigLock === 'function' ? context.providerTimeoutMs : 50,
      });
    }
    return await syncUnderSiteLease();
  } catch (error) {
    if (error?.code === 'RUNTIME_CONFIG_CHANGED' || isRuntimeConfigLockError(error)) {
      throw syncError('RUNTIME_CONFIG_CHANGED', 'provider_sync', 'runtime_config_changed');
    }
    if (isSiteCommitLockError(error)) return { appliesTo: 'next_deployment' };
    if (error?.code === 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED') throw error;
    throw syncError('RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED', 'provider_sync', 'provider_request_failed');
  }
}

async function withRuntimeConfigSyncLock(store, environment, siteId, providerTimeoutMs, callback) {
  if (typeof store.withRuntimeConfigLock !== 'function') return withProviderTimeout(callback, providerTimeoutMs);
  return store.withRuntimeConfigLock(environment, siteId, callback);
}

async function withProviderTimeout(callback, timeoutMs) {
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort(new Error('RUNTIME_CONFIG_PROVIDER_TIMEOUT'));
  }, timeoutMs);
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

async function resolveActiveWfpWorker(store, environment, site) {
  const route = await store.getRouteBySiteId(site.id, environment);
  if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;
  const version = await store.getSiteVersion(route.activeVersionId, environment);
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

function syncError(code, stage, reason) {
  const error = new Error(code);
  error.code = code;
  error.stage = stage;
  error.reason = reason;
  return error;
}

function lockedError() {
  return new Error('RUNTIME_CONFIG_LOCKED');
}

function isRuntimeConfigLockError(error) {
  return error instanceof Error && error.message === 'RUNTIME_CONFIG_LOCKED';
}

function isSiteCommitLockError(error) {
  return error?.code === 'SITE_POLICY_LOCKED' || error?.code === 'SITE_COMMIT_TIMEOUT';
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
