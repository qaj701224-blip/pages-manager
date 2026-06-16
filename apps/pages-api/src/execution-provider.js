import { normalizeWorkerBindings } from '../../../packages/wfp-client/src/index.js';
import {
  createDeploymentProvider as createWfpDeploymentProvider,
  kvGatewayServiceBinding,
  normalizeArtifactBundle,
} from './wfp-provider.js';

const EXECUTION_MODES = new Set(['wfp', 'normal-worker-slot']);
const DEFAULT_EXECUTION_MODE = 'wfp';
const DEFAULT_CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const WORKER_SUBDOMAIN_DISABLE_FAILED = 'WORKER_SUBDOMAIN_DISABLE_FAILED';

export { normalizeArtifactBundle };

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
            mainModule: input.artifactBundle.mainModule,
            modules: input.artifactBundle.modules,
            compatibilityDate: env.WFP_COMPATIBILITY_DATE,
            bindings: [kvGatewayServiceBinding(config.environment)],
          });
        }
      } catch (error) {
        const releaseStatus = error?.code === WORKER_SUBDOMAIN_DISABLE_FAILED ? 'disabled' : 'available';
        await releaseSlot(store, slot.id, env, releaseStatus);
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
      };
    },

    async verify(input) {
      if (injectedProvider?.verify) return injectedProvider.verify(input);
      return getClient().getWorker(input.workerName);
    },

    async delete(input) {
      if (input?.slotId) await releaseSlot(store, input.slotId, env);
      if (injectedProvider?.delete) return injectedProvider.delete(input);
      return null;
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
    async uploadWorker({ scriptName, mainModule, modules, compatibilityDate, bindings = [] }) {
      const safeBindings = normalizeWorkerBindings(bindings);
      await disableWorkerSubdomain(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName);
      const metadata = {
        main_module: mainModule,
        compatibility_date: compatibilityDate || '2026-06-15',
        tags: ['pages-v2', config.environment, 'normal-worker-slot'],
      };
      if (safeBindings.length > 0) metadata.bindings = safeBindings;
      const form = new FormData();
      form.set(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' })
      );
      for (const module of modules) {
        form.set(module.name, new Blob([module.content], { type: module.type || 'application/javascript+module' }), module.name);
      }
      const result = await requestCloudflare(fetchImpl, apiToken, scriptUrl(apiBaseUrl, accountId, scriptName), {
        method: 'PUT',
        body: form,
      });
      await disableWorkerSubdomain(fetchImpl, apiToken, apiBaseUrl, accountId, scriptName);
      return result;
    },

    async getWorker(scriptName) {
      return requestCloudflare(fetchImpl, apiToken, scriptUrl(apiBaseUrl, accountId, scriptName), { method: 'GET' });
    },
  };
}

async function releaseSlot(store, slotId, env, status = 'available') {
  if (typeof store.releaseWorkerSlot === 'function') {
    await store.releaseWorkerSlot(slotId, { status, updatedAt: readNow(env) });
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
