import { normalizeWorkerBindings } from '../../../packages/wfp-client/src/index.js';
import {
  createDeploymentProvider as createWfpDeploymentProvider,
  kvGatewayServiceBinding,
  normalizeWorkerBundle,
} from './wfp-provider.js';
import { runtimeBindingsForProvider } from './runtime-config.js';

const EXECUTION_MODES = new Set(['wfp', 'normal-worker-slot']);
const DEFAULT_EXECUTION_MODE = 'wfp';
const DEFAULT_CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const WORKER_SUBDOMAIN_DISABLE_FAILED = 'WORKER_SUBDOMAIN_DISABLE_FAILED';
const ASSETS_WORKER_MODULE = `export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};`;
const PLACEHOLDER_WORKER_MODULE = `export default {
  fetch() {
    return new Response('XD Cell slot is not assigned.', { status: 404 });
  },
};`;

export { normalizeWorkerBundle };

export function readExecutionMode(env = {}, site = {}) {
  const mode = site.executionModeOverride || env.PAGES_EXECUTION_MODE || DEFAULT_EXECUTION_MODE;
  if (!EXECUTION_MODES.has(mode)) throw new Error('PAGES_EXECUTION_MODE_INVALID');
  return mode;
}

export function createDeploymentProvider(env, config, store, site) {
  const mode = readExecutionMode(env, site);
  if (mode === 'normal-worker-slot') return createNormalWorkerSlotProvider(env, config, store);
  return createWfpDeploymentProvider(env, config);
}

function createNormalWorkerSlotProvider(env, config, store) {
  if (!store || typeof store.assignAvailableWorkerSlot !== 'function') throw new Error('WORKER_SLOT_STORE_REQUIRED');
  const injectedProvider = env.NORMAL_WORKER_SLOT_PROVIDER || null;
  let client;

  return {
    executionProvider: 'normal-worker-slot',

    async upload(input) {
      const routeId = input.site?.route?.id || input.site?.routeId || null;
      const slot = await store.assignAvailableWorkerSlot({
        environment: config.environment,
        siteId: input.site.id,
        routeId,
        versionId: input.versionId,
        assignedAt: readNow(env),
      });
      if (!slot) {
        const error = new Error('SLOT_CAPACITY_EXHAUSTED');
        error.code = 'SLOT_CAPACITY_EXHAUSTED';
        throw error;
      }

      try {
        if (injectedProvider?.upload) {
          await injectedProvider.upload({ ...input, workerName: slot.workerName, slot });
        } else {
          await getClient().uploadWorker({
            scriptName: slot.workerName,
            mainModule: input.artifactBundle?.mainModule,
            modules: input.artifactBundle?.modules,
            decision: input.decision,
            assetManifest: input.assetManifest,
            assetFiles: input.assetFiles,
            compatibilityDate: env.WFP_COMPATIBILITY_DATE,
            bindings: [kvGatewayServiceBinding(config.environment), ...runtimeBindingsForProvider(input.runtimeBindings)],
          });
        }
      } catch (error) {
        await cleanupAssignedSlotAfterUploadFailure({
          store,
          slot,
          input: { ...input, errorCode: error?.code },
          env,
          getClient,
          injectedProvider,
        });
        throw error;
      }

      return {
        runtime: 'worker',
        executionProvider: 'normal-worker-slot',
        workerName: slot.workerName,
        artifactRef: `slot://${config.environment}/${slot.id}/${slot.workerName}/${input.versionId}`,
        dispatchType: 'service-binding',
        dispatchBindingName: slot.bindingName,
        slotId: slot.id,
        slot,
        versionId: input.versionId,
      };
    },

    async verify(input) {
      if (injectedProvider?.verify) return injectedProvider.verify(input);
      return getClient().getWorker(input.workerName);
    },

    async delete(input) {
      if (input?.slotId) {
        await cleanupUploadedSlotBeforeReuse({
          store,
          input,
          env,
          getClient,
          injectedProvider,
        });
        return null;
      }
      if (injectedProvider?.delete) return injectedProvider.delete(input);
      return null;
    },

    async cleanupRetainedSlot(input) {
      if (!input?.slotId || !input?.versionId || input.slotId === input.activeSlotId) return null;
      if (
        typeof store.markWorkerSlotCleanupPending !== 'function' ||
        typeof store.releaseCleanupWorkerSlot !== 'function'
      ) {
        return null;
      }
      const slot = await store.markWorkerSlotCleanupPending(input.slotId, {
        expectedVersionId: input.versionId,
        updatedAt: readNow(env),
      });
      if (!slot) return null;

      if (injectedProvider?.cleanupRetainedSlot) {
        await injectedProvider.cleanupRetainedSlot({ ...input, slot });
      } else {
        await getClient().putPlaceholderWorker({
          scriptName: slot.workerName,
          compatibilityDate: env.WFP_COMPATIBILITY_DATE,
        });
      }
      return store.releaseCleanupWorkerSlot(slot.id, {
        expectedVersionId: slot.assignedVersionId || input.versionId,
        updatedAt: readNow(env),
      });
    },
  };

  function getClient() {
    client ||= createOrdinaryWorkerClient(env, config);
    return client;
  }
}

function createOrdinaryWorkerClient(env, config) {
  const accountId = readRequired(env.CF_ACCOUNT_ID, 'CF_ACCOUNT_ID');
  const apiToken = readRequired(env.CF_API_TOKEN, 'CF_API_TOKEN');
  const apiBaseUrl = normalizeApiBase(env.CF_API_BASE_URL || DEFAULT_CF_API_BASE_URL, config.environment);
  const fetchImpl = env.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');

  return {
    async uploadWorker({
      scriptName,
      mainModule,
      modules,
      decision,
      assetManifest,
      assetFiles,
      compatibilityDate,
      bindings = [],
    }) {
      const safeBindings = normalizeWorkerBindings(bindings);
      await disableWorkerSubdomain(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName);
      const usesAssets = decisionRequiresAssets(decision);
      const usesUserWorker = decisionRequiresWorker(decision);
      let safeMainModule = mainModule;
      let safeModules = modules;
      let assetMetadata = null;

      if (usesAssets) {
        const completionJwt = await uploadAssets({
          fetchImpl,
          apiToken,
          apiBaseUrl,
          accountId,
          scriptResourceUrl: scriptUrl(apiBaseUrl, accountId, scriptName),
          decision,
          assetManifest,
          assetFiles,
        });
        if (!usesUserWorker) {
          safeMainModule = 'worker.mjs';
          safeModules = [
            {
              name: 'worker.mjs',
              content: ASSETS_WORKER_MODULE,
              type: 'application/javascript+module',
            },
          ];
        }
        assetMetadata = {
          jwt: completionJwt,
          config: assetConfigForDecision(decision),
        };
      }

      const metadata = {
        main_module: safeMainModule,
        compatibility_date: compatibilityDate || '2026-06-15',
        tags: ['pages-v2', config.environment, 'normal-worker-slot'],
      };
      const metadataBindings = assetMetadata ? [{ type: 'assets', name: 'ASSETS' }, ...safeBindings] : safeBindings;
      if (metadataBindings.length > 0) metadata.bindings = metadataBindings;
      if (assetMetadata) metadata.assets = assetMetadata;
      const form = new FormData();
      form.set(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' })
      );
      for (const module of safeModules) {
        form.set(module.name, new Blob([module.content], { type: module.type || 'application/javascript+module' }), module.name);
      }
      const result = await requestCloudflare(fetchImpl, apiToken, scriptUrl(apiBaseUrl, accountId, scriptName), {
        method: 'PUT',
        body: form,
      });
      try {
        await disableWorkerSubdomain(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName);
      } catch (error) {
        await deleteWorkerScript(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName);
        throw error;
      }
      return result;
    },

    async getWorker(scriptName) {
      return requestCloudflareOk(fetchImpl, apiToken, scriptUrl(apiBaseUrl, accountId, scriptName), { method: 'GET' });
    },

    async putPlaceholderWorker({ scriptName, compatibilityDate }) {
      await disableWorkerSubdomain(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName);
      const metadata = {
        main_module: 'worker.mjs',
        compatibility_date: compatibilityDate || '2026-06-15',
        tags: ['pages-v2', config.environment, 'normal-worker-slot', 'placeholder'],
      };
      const form = new FormData();
      form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.set('worker.mjs', new Blob([PLACEHOLDER_WORKER_MODULE], { type: 'application/javascript+module' }), 'worker.mjs');
      const result = await requestCloudflare(fetchImpl, apiToken, scriptUrl(apiBaseUrl, accountId, scriptName), {
        method: 'PUT',
        body: form,
      });
      await disableWorkerSubdomain(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName);
      return result;
    },
  };
}

async function deleteWorkerScript(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName) {
  try {
    await requestCloudflare(fetchImpl, apiToken, scriptUrl(apiBaseUrl, accountId, scriptName), { method: 'DELETE' });
  } catch {
    // The caller still fails closed by disabling the slot record; manual cleanup can retry by worker name.
  }
}

async function uploadAssets({
  fetchImpl,
  apiToken,
  apiBaseUrl,
  accountId,
  scriptResourceUrl,
  decision,
  assetManifest,
  assetFiles,
}) {
  validateAssetInput({ decision, assetManifest, assetFiles });
  const session = await requestCloudflare(fetchImpl, apiToken, `${scriptResourceUrl}/assets-upload-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: assetManifest }),
  });

  if (!Array.isArray(session?.buckets) || session.buckets.length === 0) return session.jwt;

  let completionJwt = session.jwt;
  const fileMap = assetFileMap(assetManifest, assetFiles);
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = fileMap.get(hash);
      if (!file) continue;
      form.set(hash, new Blob([bytesToBase64(file.bytes)], { type: file.contentType || 'application/octet-stream' }), hash);
    }
    const result = await requestCloudflare(fetchImpl, session.jwt, assetUploadUrl(apiBaseUrl, accountId), {
      method: 'POST',
      body: form,
    });
    if (result?.jwt) completionJwt = result.jwt;
  }
  return completionJwt;
}

function validateAssetInput({ decision, assetManifest, assetFiles }) {
  if (!decisionRequiresAssets(decision)) throw new Error('ASSET_UPLOAD_PLAN_INVALID');
  if (!assetManifest || typeof assetManifest !== 'object' || Array.isArray(assetManifest)) {
    throw new Error('ASSET_MANIFEST_INVALID');
  }
  if (!Array.isArray(assetFiles) || assetFiles.length === 0) throw new Error('ASSET_FILES_REQUIRED');
}

function assetFileMap(assetManifest, assetFiles) {
  const map = new Map();
  for (const file of assetFiles) {
    const path = normalizeAssetPath(file.path);
    const hash = assetManifest[path]?.hash;
    if (!hash) continue;
    map.set(hash, file);
  }
  return map;
}

function normalizeAssetPath(value) {
  return `/${String(value || '').replaceAll('\\', '/').replace(/^\/+/, '')}`;
}

function assetConfigForDecision(decision) {
  if (!decisionRequiresAssets(decision)) throw new Error('ASSET_UPLOAD_PLAN_INVALID');
  return {
    not_found_handling:
      decision.resolvedFallback === 'index'
        ? 'single-page-application'
        : decision.resolvedFallback === 'not-found'
          ? '404-page'
          : 'none',
    ...(decision.routingMode === 'worker-first' ? { run_worker_first: true } : {}),
  };
}

function decisionRequiresAssets(decision) {
  return decision?.deploymentShape === 'assets-only' || decision?.deploymentShape === 'worker-with-assets';
}

function decisionRequiresWorker(decision) {
  return decision?.deploymentShape === 'worker-only' || decision?.deploymentShape === 'worker-with-assets';
}

function assetUploadUrl(apiBaseUrl, accountId) {
  return `${apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/workers/assets/upload?base64=true`;
}

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < u8.length; index += chunkSize) {
    binary += String.fromCharCode(...u8.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function releaseSlot(store, slotId, env, status = 'available') {
  if (typeof store.releaseWorkerSlot === 'function') {
    await store.releaseWorkerSlot(slotId, { status, updatedAt: readNow(env) });
  }
}

async function cleanupUploadedSlotBeforeReuse({ store, input, env, getClient, injectedProvider }) {
  if (!input?.versionId) {
    await releaseSlot(store, input.slotId, env, 'disabled');
    return;
  }
  await cleanupAssignedSlotAfterUploadFailure({
    store,
    slot: input.slot || { id: input.slotId },
    input,
    env,
    getClient,
    injectedProvider,
  });
}

async function cleanupAssignedSlotAfterUploadFailure({ store, slot, input, env, getClient, injectedProvider }) {
  if (input?.errorCode === WORKER_SUBDOMAIN_DISABLE_FAILED) {
    await releaseSlot(store, slot.id, env, 'disabled');
    return;
  }
  if (
    typeof store.markWorkerSlotCleanupPending !== 'function' ||
    typeof store.releaseCleanupWorkerSlot !== 'function'
  ) {
    await releaseSlot(store, slot.id, env, 'disabled');
    return;
  }
  const cleanupSlot = await store.markWorkerSlotCleanupPending(slot.id, {
    expectedVersionId: input.versionId,
    updatedAt: readNow(env),
  });
  if (!cleanupSlot) {
    await releaseSlot(store, slot.id, env, 'disabled');
    return;
  }
  try {
    if (injectedProvider?.cleanupRetainedSlot) {
      await injectedProvider.cleanupRetainedSlot({ ...input, slot: cleanupSlot });
    } else {
      await getClient().putPlaceholderWorker({
        scriptName: cleanupSlot.workerName,
        compatibilityDate: env.WFP_COMPATIBILITY_DATE,
      });
    }
    const released = await store.releaseCleanupWorkerSlot(cleanupSlot.id, {
      expectedVersionId: cleanupSlot.assignedVersionId || input.versionId,
      updatedAt: readNow(env),
    });
    if (!released) await releaseSlot(store, cleanupSlot.id, env, 'disabled');
  } catch {
    await releaseSlot(store, cleanupSlot.id, env, 'disabled');
  }
}

async function requestCloudflare(fetchImpl, apiToken, url, init) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  const response = await fetchImpl(new Request(url, { ...init, headers }));
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok || payload?.success === false) throw new Error('CLOUDFLARE_WORKER_API_ERROR');
  return payload?.result ?? payload;
}

async function requestCloudflareOk(fetchImpl, apiToken, url, init) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  const response = await fetchImpl(new Request(url, { ...init, headers }));
  if (!response.ok) throw new Error('CLOUDFLARE_WORKER_API_ERROR');
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type') || '',
  };
}

function scriptUrl(apiBaseUrl, accountId, scriptName) {
  return `${apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`;
}

function subdomainUrl(apiBaseUrl, accountId, scriptName) {
  const account = encodeURIComponent(accountId);
  const script = encodeURIComponent(scriptName);
  return `${apiBaseUrl}/accounts/${account}/workers/services/${script}/environments/production/subdomain`;
}

async function disableWorkerSubdomain(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName) {
  try {
    return await requestCloudflare(fetchImpl, apiToken, subdomainUrl(apiBaseUrl, accountId, scriptName), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
  } catch {
    const error = new Error(WORKER_SUBDOMAIN_DISABLE_FAILED);
    error.code = WORKER_SUBDOMAIN_DISABLE_FAILED;
    throw error;
  }
}

function normalizeApiBase(value, environment) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('CF_API_BASE_URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/client/v4' || url.search || url.hash) {
    throw new Error('CF_API_BASE_URL is invalid');
  }
  if ((environment === 'production' || environment === 'staging') && url.hostname !== 'api.cloudflare.com') {
    throw new Error('CF_API_BASE_URL must be api.cloudflare.com for production and staging.');
  }
  return url.toString().replace(/\/$/, '');
}

function readRequired(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
