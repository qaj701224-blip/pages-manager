const DEFAULT_CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const EXPECTED_NAMESPACE_BY_ENV = {
  production: 'pages-production',
  staging: 'pages-staging',
};
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class WfpApiError extends Error {
  constructor({ status, code = 'WFP_API_ERROR', message }) {
    super(message || code);
    this.name = 'WfpApiError';
    this.status = status;
    this.code = code;
  }
}

export function readWfpConfig(env = {}, { environment = env.PAGES_ENV } = {}) {
  const accountId = readRequired(env.CF_ACCOUNT_ID, 'CF_ACCOUNT_ID');
  const apiToken = readRequired(env.CF_API_TOKEN, 'CF_API_TOKEN');
  const dispatchNamespace = readRequired(env.WFP_DISPATCH_NAMESPACE, 'WFP_DISPATCH_NAMESPACE');
  const apiBaseUrl = normalizeApiBase(env.CF_API_BASE_URL || DEFAULT_CF_API_BASE_URL);

  const expectedNamespace = EXPECTED_NAMESPACE_BY_ENV[environment];
  if (expectedNamespace && dispatchNamespace !== expectedNamespace) {
    throw new Error(`WFP_DISPATCH_NAMESPACE must be ${expectedNamespace} for ${environment}.`);
  }
  if (expectedNamespace && new URL(apiBaseUrl).hostname !== 'api.cloudflare.com') {
    throw new Error('CF_API_BASE_URL must be api.cloudflare.com for production and staging.');
  }

  return {
    accountId,
    apiToken,
    dispatchNamespace,
    apiBaseUrl,
    environment,
  };
}

export function createWfpClient({
  accountId,
  apiToken,
  dispatchNamespace,
  apiBaseUrl = DEFAULT_CF_API_BASE_URL,
  fetch = globalThis.fetch,
} = {}) {
  if (!accountId) throw new Error('CF_ACCOUNT_ID is required');
  if (!apiToken) throw new Error('CF_API_TOKEN is required');
  if (!dispatchNamespace) throw new Error('WFP_DISPATCH_NAMESPACE is required');
  if (typeof fetch !== 'function') throw new Error('fetch is required');

  const baseUrl = normalizeApiBase(apiBaseUrl);
  const namespace = encodeURIComponent(dispatchNamespace);
  const account = encodeURIComponent(accountId);

  return {
    async uploadUserWorker({ scriptName, mainModule, modules, compatibilityDate, tags = [], bindings = [] }) {
      const safeScriptName = validateScriptName(scriptName);
      validateModules({ mainModule, modules });
      const safeBindings = normalizeWorkerBindings(bindings);
      const form = new FormData();
      const metadata = {
        main_module: mainModule,
        compatibility_date: compatibilityDate || new Date().toISOString().slice(0, 10),
        tags,
      };
      if (safeBindings.length > 0) metadata.bindings = safeBindings;
      form.set(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' })
      );
      for (const module of modules) {
        form.set(module.name, new Blob([module.content], { type: module.type || 'application/javascript+module' }), module.name);
      }

      await requestCloudflare(fetch, apiToken, scriptUrl(baseUrl, account, namespace, safeScriptName), {
        method: 'PUT',
        body: form,
      });
      return {
        scriptName: safeScriptName,
        dispatchNamespace,
        artifactRef: `wfp://${dispatchNamespace}/${safeScriptName}`,
      };
    },

    async getUserWorker(scriptName) {
      return requestCloudflare(fetch, apiToken, scriptUrl(baseUrl, account, namespace, validateScriptName(scriptName)), {
        method: 'GET',
      });
    },

    async deleteUserWorker(scriptName) {
      return requestCloudflare(fetch, apiToken, scriptUrl(baseUrl, account, namespace, validateScriptName(scriptName)), {
        method: 'DELETE',
      });
    },
  };
}

export function validateScriptName(value) {
  const scriptName = String(value || '').trim();
  if (!SCRIPT_NAME_RE.test(scriptName)) throw new Error('WFP_SCRIPT_NAME_INVALID');
  return scriptName;
}

export function normalizeWorkerBindings(bindings = []) {
  if (!Array.isArray(bindings)) throw new Error('WORKER_BINDINGS_INVALID');
  return bindings.map((binding) => normalizeWorkerBinding(binding));
}

function normalizeWorkerBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('WORKER_BINDING_INVALID');
  if (binding.type !== 'service') throw new Error('WORKER_BINDING_TYPE_INVALID');

  const name = String(binding.name || '').trim();
  if (!BINDING_NAME_RE.test(name)) throw new Error('WORKER_BINDING_NAME_INVALID');

  return {
    type: 'service',
    name,
    service: validateScriptName(binding.service),
  };
}

async function requestCloudflare(fetch, apiToken, url, init) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  const response = await fetch(
    new Request(url, {
      ...init,
      headers,
    })
  );
  const payload = await readJson(response);
  if (!response.ok || payload?.success === false) {
    throw new WfpApiError({
      status: response.status,
      message: redactCloudflareError(payload, apiToken),
    });
  }
  return payload?.result ?? payload;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new WfpApiError({
      status: response.status,
      code: 'WFP_API_INVALID_JSON',
      message: 'Cloudflare API returned invalid JSON.',
    });
  }
}

function redactCloudflareError(payload, apiToken) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const message = errors
    .map((error) => `${error.code || 'unknown'} ${error.message || ''}`.trim())
    .filter(Boolean)
    .join('; ');
  return String(message || 'Cloudflare WFP API request failed.').replaceAll(apiToken, '[redacted]');
}

function scriptUrl(baseUrl, accountId, namespace, scriptName) {
  return `${baseUrl}/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${encodeURIComponent(scriptName)}`;
}

function normalizeApiBase(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('CF_API_BASE_URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/client/v4' || url.search || url.hash) {
    throw new Error('CF_API_BASE_URL is invalid');
  }
  return url.toString().replace(/\/$/, '');
}

function readRequired(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function validateModules({ mainModule, modules }) {
  if (typeof mainModule !== 'string' || mainModule === '') throw new Error('WFP_MAIN_MODULE_REQUIRED');
  if (!Array.isArray(modules) || modules.length === 0) throw new Error('WFP_MODULES_REQUIRED');
  if (!modules.some((module) => module.name === mainModule)) throw new Error('WFP_MAIN_MODULE_MISSING');
  for (const module of modules) {
    if (!module || typeof module.name !== 'string' || typeof module.content !== 'string') throw new Error('WFP_MODULE_INVALID');
  }
}
