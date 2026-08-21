import { createRuntimeConfigMutationPort } from '../../application/ports/runtime-config.js';
import { createRuntimeConfigMutations } from '../../application/runtime-config/mutations.js';
import { jsonError } from '../../http.js';
import { nextId } from '../../id.js';
import { createRuntimeConfigSync } from '../../infrastructure/providers/runtime-config-sync.js';
import { logRuntimeConfigFailure } from '../../runtime-config-diagnostics.js';
import { createDeploymentProvider as createWfpDeploymentProvider } from '../../wfp-provider.js';

export function createRuntimeConfigApplication({ store, env, config }) {
  return createRuntimeConfigMutations({
    repository: createRuntimeConfigMutationPort(store),
    sync: createRuntimeConfigSync({
      store,
      environment: config.environment,
      createProvider: () => createWfpDeploymentProvider(env, config),
    }),
    clock: { now: () => readNow(env) },
    ids: { next: (prefix) => nextId(env, prefix) },
  });
}

export async function syncActiveWfpSecret(store, env, config, site, input) {
  try {
    return await createActiveRuntimeConfigSync({ store, env, config }).syncSecret({
      site,
      mutation: input,
    });
  } catch (error) {
    return runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'secret' });
  }
}

export async function syncActiveWfpPlainTextBindings(store, env, config, site, snapshot) {
  try {
    return await createActiveRuntimeConfigSync({ store, env, config }).syncPlainText({
      site,
      snapshot,
    });
  } catch (error) {
    return runtimeConfigSyncErrorResponse(error, { env, config, site, kind: 'var' });
  }
}

export function runtimeConfigSyncErrorResponse(error, { env, config, site, kind }) {
  if (error?.code === 'RUNTIME_CONFIG_CHANGED' && error?.reason === 'runtime_config_changed') {
    const message =
      kind === 'secret' ? 'Runtime config changed while syncing a secret.' : 'Runtime config changed while syncing.';
    return jsonError('RUNTIME_CONFIG_CHANGED', message, 409, 'Retry the runtime config change.');
  }

  const secret = kind === 'secret' && error?.code === 'SECRET_ACTIVE_WORKER_SYNC_FAILED';
  const plainText = kind === 'var' && error?.code === 'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED';
  if (!secret && !plainText) return null;

  logRuntimeConfigFailure(env, {
    operation: secret ? 'secret_sync' : 'plain_text_sync',
    environment: config.environment,
    siteId: site.id,
    stage: error.stage || 'provider_sync',
    reason: error.reason || 'provider_request_failed',
    errorCode: error.code,
  });

  if (secret) {
    const action =
      error.stage === 'provider_setup'
        ? 'Check platform Worker provider configuration and retry the secret command.'
        : 'Retry the secret command before testing the current Worker.';
    return jsonError(
      'SECRET_ACTIVE_WORKER_SYNC_FAILED',
      'Runtime secret was saved but the active Worker could not be updated.',
      502,
      action
    );
  }

  const action =
    error.stage === 'provider_setup'
      ? 'Check platform Worker provider configuration and retry the runtime config change.'
      : 'Retry the runtime config change before testing the current Worker.';
  return jsonError(
    'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
    'Runtime var was saved but the active Worker could not be updated.',
    502,
    action
  );
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function createActiveRuntimeConfigSync({ store, env, config }) {
  return createRuntimeConfigSync({
    store,
    environment: config.environment,
    createProvider: () => createWfpDeploymentProvider(env, config),
  });
}
