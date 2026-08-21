const DEFAULT_CF_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const ASSETS_WORKER_MODULE = `export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};`;
const EXPECTED_NAMESPACE_BY_ENV = {
  production: 'xd-cell-workers-production',
  staging: 'xd-cell-workers-staging',
};
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Termination backstop for cursor pagination when the caller sets no explicit bounds.
const WFP_UNBOUNDED_CURSOR_PAGE_CAP = 1000;
const WFP_PROVIDER_OPERATIONS = new Set([
  'assets_upload_session',
  'assets_upload',
  'worker_put',
  'worker_get',
  'worker_delete',
  'worker_settings_get',
  'worker_settings_patch',
  'worker_secret_put',
  'worker_secret_delete',
  'worker_subdomain_disable',
  'worker_placeholder_put',
]);
const WFP_CLIENT_CODE_RE = /^WFP_[A-Z0-9_]{1,64}$/;
const PROVIDER_REQUEST_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const PROVIDER_CODE_MAX_LENGTH = 64;
const PROVIDER_MESSAGE_MAX_LENGTH = 512;
const NETWORK_ERROR_MESSAGE = 'Cloudflare WFP request failed before receiving a response.';

export class WfpApiError extends Error {
  constructor({ status, code = 'WFP_API_ERROR', message, detail, operation, providerCode, providerMessage, providerRequestId }) {
    const safeCode = normalizeClientCode(code);
    super(message || safeCode);
    this.name = 'WfpApiError';
    const safeStatus = normalizeProviderHttpStatus(status);
    if (safeStatus !== undefined) this.status = safeStatus;
    this.code = safeCode;
    if (detail) this.detail = detail;
    const safeOperation = normalizeProviderOperation(operation);
    const safeProviderCode = normalizeProviderCode(providerCode);
    const safeProviderMessage = normalizeProviderMessage(providerMessage, []);
    const safeProviderRequestId = normalizeProviderRequestId(providerRequestId);
    if (safeOperation) this.operation = safeOperation;
    if (safeProviderCode !== undefined) this.providerCode = safeProviderCode;
    if (safeProviderMessage !== undefined) this.providerMessage = safeProviderMessage;
    if (safeProviderRequestId !== undefined) this.providerRequestId = safeProviderRequestId;
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
    async uploadUserWorker(input) {
      const { scriptName, mainModule, modules, compatibilityDate, tags = [], bindings = [] } = input || {};
      const safeScriptName = validateScriptName(scriptName);
      const safeBindings = normalizeWorkerBindings(bindings);
      const redactionTokens = safeBindings
        .filter((binding) => binding.type === 'secret_text' && typeof binding.text === 'string')
        .map((binding) => binding.text);
      const usesAssets = decisionRequiresAssets(input?.decision);
      const usesUserWorker = decisionRequiresWorker(input?.decision);
      let safeMainModule = mainModule;
      let safeModules = modules;
      let assetMetadata = null;

      if (usesAssets) {
        const completionJwt = await uploadAssets({
          fetch,
          apiToken,
          baseUrl,
          accountId: account,
          scriptResourceUrl: scriptUrl(baseUrl, account, namespace, safeScriptName),
          decision: input.decision,
          assetManifest: input.assetManifest,
          assetFiles: input.assetFiles,
          redactionTokens,
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
        } else {
          validateModules({ mainModule, modules });
        }
        assetMetadata = {
          jwt: completionJwt,
          config: assetConfigForDecision(input.decision),
        };
      } else {
        validateModules({ mainModule, modules });
      }

      const form = new FormData();
      const metadata = {
        main_module: safeMainModule,
        compatibility_date: compatibilityDate || new Date().toISOString().slice(0, 10),
        tags,
      };
      const metadataBindings = assetMetadata ? [{ type: 'assets', name: 'ASSETS' }, ...safeBindings] : safeBindings;
      if (metadataBindings.length > 0) metadata.bindings = metadataBindings;
      if (assetMetadata) metadata.assets = assetMetadata;
      form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      for (const module of safeModules) {
        form.set(module.name, new Blob([module.content], { type: module.type || 'application/javascript+module' }), module.name);
      }

      await requestCloudflare(
        fetch,
        apiToken,
        scriptUrl(baseUrl, account, namespace, safeScriptName),
        {
          method: 'PUT',
          body: form,
        },
        {
          operation: 'worker_put',
          redactionTokens: [...redactionTokens, ...(assetMetadata?.jwt ? [assetMetadata.jwt] : [])],
        }
      );
      return {
        scriptName: safeScriptName,
        dispatchNamespace,
        artifactRef: `wfp://${dispatchNamespace}/${safeScriptName}`,
      };
    },

    async getUserWorker(scriptName) {
      return requestCloudflareOk(
        fetch,
        apiToken,
        scriptUrl(baseUrl, account, namespace, validateScriptName(scriptName)),
        { method: 'GET' },
        { operation: 'worker_get' }
      );
    },

    async listUserWorkers(options = {}) {
      const maxWorkers = normalizePositiveBound(options.maxWorkers);
      const explicitMaxPages = normalizePositiveBound(options.maxPages);
      const readList = async () => {
        const workers = [];
        const workerNames = new Set();
        const firstUrl = scriptsUrl(baseUrl, account, namespace);
        const firstPayload = await requestCloudflarePayload(fetch, apiToken, firstUrl, { method: 'GET' });
        const firstPageWorkers = normalizeListedWorkers(readCloudflareListResult(firstPayload));
        if (maxWorkers && firstPageWorkers.length > maxWorkers) {
          throw invalidCloudflareListResponse('first page above maxWorkers');
        }
        appendUniqueWorkers(workers, workerNames, firstPageWorkers);
        const firstPage = readCloudflarePagination(firstPayload);
        if (firstPage.mode === 'none') return workers;
        if (firstPage.mode === 'cursor' && !firstPage.cursor) return workers;
        if (firstPage.mode === 'page' && firstPage.page !== 1) {
          throw invalidCloudflareListResponse('first response reports a later page');
        }
        if (firstPage.mode === 'page' && firstPage.totalPages <= 1) return workers;
        if (firstPageWorkers.length === 0) throw invalidCloudflareListResponse('empty first page claims more pages');

        const inferredMaxPages = maxWorkers ? Math.max(1, Math.ceil(maxWorkers / firstPageWorkers.length)) : null;
        const pageBounds = [explicitMaxPages, inferredMaxPages].filter(Boolean);
        const maxPages = pageBounds.length > 0 ? Math.min(...pageBounds) : null;

        if (firstPage.mode === 'cursor') {
          let cursor = firstPage.cursor;
          const seenCursors = new Set();
          const cursorPageCap = maxPages || WFP_UNBOUNDED_CURSOR_PAGE_CAP;
          let fetchedPages = 1;
          while (cursor) {
            if (seenCursors.has(cursor)) throw invalidCloudflareListResponse('repeated pagination cursor');
            seenCursors.add(cursor);
            fetchedPages += 1;
            if (fetchedPages > cursorPageCap) {
              throw invalidCloudflareListResponse('cursor page count above configured bound');
            }
            const url = new URL(firstUrl);
            url.searchParams.set('cursor', cursor);
            const payload = await requestCloudflarePayload(fetch, apiToken, url.toString(), { method: 'GET' });
            const pagination = readCloudflarePagination(payload);
            if (pagination.mode === 'page') throw invalidCloudflareListResponse('pagination mode changed mid-scan');
            const pageWorkers = normalizeListedWorkers(readCloudflareListResult(payload));
            appendUniqueWorkers(workers, workerNames, pageWorkers);
            if (maxWorkers && workers.length > maxWorkers) {
              throw invalidCloudflareListResponse('worker count above maxWorkers');
            }
            const nextCursor = pagination.mode === 'cursor' ? pagination.cursor : '';
            if (nextCursor && pageWorkers.length === 0) {
              throw invalidCloudflareListResponse('empty page claims more data');
            }
            cursor = nextCursor;
          }
          return workers;
        }

        if (maxPages && firstPage.totalPages > maxPages) {
          throw invalidCloudflareListResponse('total pages above configured bound');
        }

        for (let page = 2; page <= firstPage.totalPages; page += 1) {
          const url = new URL(firstUrl);
          url.searchParams.set('page', String(page));
          const payload = await requestCloudflarePayload(fetch, apiToken, url.toString(), { method: 'GET' });
          const pagination = readCloudflarePagination(payload);
          if (pagination.mode !== 'page' || pagination.page !== page || pagination.totalPages !== firstPage.totalPages) {
            throw invalidCloudflareListResponse('page sequence mismatch');
          }
          const pageWorkers = normalizeListedWorkers(readCloudflareListResult(payload));
          appendUniqueWorkers(workers, workerNames, pageWorkers);
          if (maxWorkers && workers.length > maxWorkers) throw invalidCloudflareListResponse('worker count above maxWorkers');
        }
        return workers;
      };

      let workers = await readList();
      const namespaceScriptCount = await readNamespaceScriptCount({
        fetch,
        apiToken,
        baseUrl,
        account,
        namespace,
      });
      if (workers.length !== namespaceScriptCount) workers = await readList();
      return {
        workers,
        completeness: workers.length === namespaceScriptCount ? 'complete' : 'incomplete',
        scannedCount: workers.length,
        namespaceScriptCount,
      };
    },

    async deleteUserWorker(scriptName) {
      return requestCloudflare(
        fetch,
        apiToken,
        scriptUrl(baseUrl, account, namespace, validateScriptName(scriptName)),
        { method: 'DELETE' },
        { operation: 'worker_delete' }
      );
    },

    async updateUserWorkerBindings(scriptName, input = {}) {
      const safeScriptName = validateScriptName(scriptName);
      const safeBindings = normalizeWorkerBindings(input.bindings || []);
      const settingsUrl = `${scriptUrl(baseUrl, account, namespace, safeScriptName)}/settings`;
      const currentSettings = await requestCloudflare(
        fetch,
        apiToken,
        settingsUrl,
        {
          method: 'GET',
          signal: input.signal,
        },
        { operation: 'worker_settings_get' }
      );
      if (
        !Array.isArray(currentSettings?.bindings) ||
        currentSettings.bindings.some((binding) => !binding || typeof binding !== 'object' || Array.isArray(binding))
      ) {
        throw new WfpApiError({
          status: 502,
          code: 'WFP_API_SETTINGS_INVALID',
          message: 'Cloudflare WFP settings response did not include bindings.',
          operation: 'worker_settings_get',
        });
      }
      const currentBindings = currentSettings.bindings;
      const bindings = [
        ...currentBindings.filter((binding) => binding?.type !== 'plain_text').map(cloneJsonObject),
        ...safeBindings,
      ];

      const form = new FormData();
      form.set('settings', new Blob([JSON.stringify({ bindings })], { type: 'application/json' }));
      return requestCloudflare(
        fetch,
        apiToken,
        settingsUrl,
        {
          method: 'PATCH',
          body: form,
          signal: input.signal,
        },
        { operation: 'worker_settings_patch' }
      );
    },

    async getUserWorkerSettings(scriptName, options = {}) {
      const safeScriptName = validateScriptName(scriptName);
      const settingsUrl = `${scriptUrl(baseUrl, account, namespace, safeScriptName)}/settings`;
      const currentSettings = await requestCloudflare(
        fetch,
        apiToken,
        settingsUrl,
        {
          method: 'GET',
          signal: options.signal,
        },
        { operation: 'worker_settings_get' }
      );
      if (
        !Array.isArray(currentSettings?.bindings) ||
        currentSettings.bindings.some((binding) => !binding || typeof binding !== 'object' || Array.isArray(binding))
      ) {
        throw new WfpApiError({
          status: 502,
          code: 'WFP_API_SETTINGS_INVALID',
          message: 'Cloudflare WFP settings response did not include bindings.',
          operation: 'worker_settings_get',
        });
      }
      return currentSettings;
    },

    async removeOfficeNetBinding(scriptName, options = {}) {
      const safeScriptName = validateScriptName(scriptName);
      const currentSettings = await this.getUserWorkerSettings(safeScriptName, options);
      const currentBindings = currentSettings.bindings.map(cloneJsonObject);
      const bindings = currentBindings.filter((binding) => !(binding.type === 'vpc_network' && binding.name === 'XD_OFFICE_NET'));
      if (bindings.length === currentBindings.length) return { removed: false, bindings };

      const settingsUrl = `${scriptUrl(baseUrl, account, namespace, safeScriptName)}/settings`;
      const form = new FormData();
      form.set('settings', new Blob([JSON.stringify({ bindings })], { type: 'application/json' }));
      const result = await requestCloudflare(
        fetch,
        apiToken,
        settingsUrl,
        {
          method: 'PATCH',
          body: form,
          signal: options.signal,
        },
        { operation: 'worker_settings_patch' }
      );
      return { removed: true, bindings, result };
    },

    async verifyOfficeNetAbsent(scriptName, options = {}) {
      const currentSettings = await this.getUserWorkerSettings(scriptName, options);
      return !currentSettings.bindings.some((binding) => binding?.type === 'vpc_network' && binding?.name === 'XD_OFFICE_NET');
    },

    async putUserWorkerSecret(scriptName, secret, options = {}) {
      const safeScriptName = validateScriptName(scriptName);
      const body = normalizeUserWorkerSecret(secret);
      return requestCloudflare(
        fetch,
        apiToken,
        `${scriptUrl(baseUrl, account, namespace, safeScriptName)}/secrets`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: options.signal,
        },
        { operation: 'worker_secret_put', redactionTokens: [body.text] }
      );
    },

    async deleteUserWorkerSecret(scriptName, secretName, options = {}) {
      const safeScriptName = validateScriptName(scriptName);
      const name = validateBindingName(secretName);
      return requestCloudflare(
        fetch,
        apiToken,
        `${scriptUrl(baseUrl, account, namespace, safeScriptName)}/secrets/${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
          signal: options.signal,
        },
        { operation: 'worker_secret_delete' }
      );
    },
  };
}

async function uploadAssets({
  fetch,
  apiToken,
  baseUrl,
  accountId,
  scriptResourceUrl,
  decision,
  assetManifest,
  assetFiles,
  redactionTokens = [],
}) {
  validateAssetInput({ decision, assetManifest, assetFiles });
  const session = await requestCloudflare(
    fetch,
    apiToken,
    `${scriptResourceUrl}/assets-upload-session`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: assetManifest }),
    },
    { operation: 'assets_upload_session', redactionTokens }
  );

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
    const result = await requestCloudflare(
      fetch,
      session.jwt,
      assetUploadUrl(baseUrl, accountId),
      {
        method: 'POST',
        body: form,
      },
      { operation: 'assets_upload', redactionTokens: [apiToken, ...redactionTokens] }
    );
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
  return `/${String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')}`;
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

function assetUploadUrl(baseUrl, accountId) {
  return `${baseUrl}/accounts/${accountId}/workers/assets/upload?base64=true`;
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

  const name = validateBindingName(binding.name);

  if (binding.type === 'service') {
    return {
      type: 'service',
      name,
      service: validateScriptName(binding.service),
    };
  }
  if (binding.type === 'plain_text' || binding.type === 'secret_text') {
    if (typeof binding.text !== 'string') throw new Error('WORKER_BINDING_TEXT_INVALID');
    return {
      type: binding.type,
      name,
      text: binding.text,
    };
  }
  if (binding.type === 'vpc_network') {
    const tunnelId = String(binding.tunnel_id || '').trim();
    if (!tunnelId) throw new Error('WORKER_VPC_TUNNEL_ID_INVALID');
    return {
      type: 'vpc_network',
      name,
      tunnel_id: tunnelId,
    };
  }
  throw new Error('WORKER_BINDING_TYPE_INVALID');
}

function normalizeUserWorkerSecret(secret) {
  if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw new Error('WORKER_SECRET_INVALID');
  const name = validateBindingName(secret.name);
  if (typeof secret.value !== 'string') throw new Error('WORKER_SECRET_VALUE_INVALID');
  return {
    name,
    text: secret.value,
    type: 'secret_text',
  };
}

function validateBindingName(value) {
  const name = String(value || '').trim();
  if (!BINDING_NAME_RE.test(name)) throw new Error('WORKER_BINDING_NAME_INVALID');
  return name;
}

function cloneJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKER_BINDING_INVALID');
  return JSON.parse(JSON.stringify(value));
}

async function requestCloudflare(fetch, apiToken, url, init, options = {}) {
  const payload = await requestCloudflarePayload(fetch, apiToken, url, init, options);
  return payload?.result ?? payload;
}

export async function requestCloudflareProvider(fetch, apiToken, url, init, options = {}) {
  return requestCloudflare(fetch, apiToken, url, init, options);
}

async function requestCloudflarePayload(fetch, apiToken, url, init, options = {}) {
  const operation = normalizeProviderOperation(options.operation);
  const redactionTokens = [apiToken, ...(Array.isArray(options.redactionTokens) ? options.redactionTokens : [])];
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  const request = new Request(url, {
    ...init,
    headers,
  });
  let response;
  try {
    response = await fetch(request);
  } catch {
    throw new WfpApiError({
      code: 'WFP_NETWORK_ERROR',
      message: NETWORK_ERROR_MESSAGE,
      operation,
    });
  }
  const providerRequestId = readProviderRequestId(response.headers, redactionTokens);
  const payload = await readJson(response, { operation, providerRequestId });
  if (!response.ok || payload?.success === false) {
    const providerError = readProviderError(payload, redactionTokens);
    throw new WfpApiError({
      status: response.status,
      message: redactCloudflareError(payload, redactionTokens),
      operation,
      providerRequestId,
      ...providerError,
    });
  }
  return payload;
}

function readCloudflareListResult(payload) {
  if (Array.isArray(payload?.result)) return payload.result;
  throw invalidCloudflareListResponse(describeShape('payload', payload));
}

function readCloudflarePagination(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload || {}, 'result_info')) return { mode: 'none' };
  const resultInfo = payload.result_info;
  if (!isPlainObject(resultInfo)) throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
  if (Object.prototype.hasOwnProperty.call(resultInfo, 'page')) {
    const responsePage = resultInfo.page;
    if (!Number.isInteger(responsePage) || responsePage < 1) {
      throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
    }
    const totalPages = readCloudflareTotalPages(resultInfo);
    if (totalPages < 1 || totalPages < responsePage) {
      throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
    }
    return { mode: 'page', page: responsePage, totalPages };
  }
  // Observed live contract: the dispatch scripts list paginates like KV, with
  // result_info carrying only count/cursor and an empty cursor marking the last page.
  if (Object.prototype.hasOwnProperty.call(resultInfo, 'cursor') || Object.prototype.hasOwnProperty.call(resultInfo, 'count')) {
    if (Object.prototype.hasOwnProperty.call(resultInfo, 'count') && !Number.isInteger(resultInfo.count)) {
      throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
    }
    return { mode: 'cursor', cursor: readCloudflareCursor(resultInfo) };
  }
  throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
}

function readCloudflareCursor(resultInfo) {
  const cursor = resultInfo.cursor;
  if (cursor === undefined || cursor === null || cursor === '') return '';
  if (typeof cursor !== 'string' || !cursor.trim()) {
    throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
  }
  return cursor;
}

function readCloudflareTotalPages(resultInfo) {
  if (Object.prototype.hasOwnProperty.call(resultInfo, 'total_pages')) {
    if (!Number.isInteger(resultInfo.total_pages)) throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
    return resultInfo.total_pages;
  }
  // The dispatch scripts list endpoint has no published contract; some Cloudflare list
  // responses only carry per_page/total_count, so total pages must be derived from them.
  const perPage = resultInfo.per_page;
  const totalCount = resultInfo.total_count;
  if (!Number.isInteger(perPage) || perPage < 1 || !Number.isInteger(totalCount) || totalCount < 0) {
    throw invalidCloudflareListResponse(describeShape('result_info', resultInfo));
  }
  return Math.max(1, Math.ceil(totalCount / perPage));
}

function normalizeListedWorkers(workers) {
  return workers.map((worker) => {
    const name = worker?.script?.id || worker?.id || worker?.name;
    if (typeof name !== 'string' || !name.trim()) throw invalidCloudflareListResponse(describeShape('worker item', worker));
    return {
      name: name.trim(),
      created_on: worker?.created_on || null,
      modified_on: worker?.modified_on || null,
    };
  });
}

function appendUniqueWorkers(target, names, workers) {
  for (const worker of workers) {
    if (names.has(worker.name)) throw invalidCloudflareListResponse('duplicate worker name');
    names.add(worker.name);
    target.push(worker);
  }
}

async function readNamespaceScriptCount({ fetch, apiToken, baseUrl, account, namespace }) {
  const payload = await requestCloudflarePayload(fetch, apiToken, namespaceUrl(baseUrl, account, namespace), {
    method: 'GET',
  });
  const scriptCount = payload?.result?.script_count;
  if (!Number.isInteger(scriptCount) || scriptCount < 0) {
    throw invalidCloudflareListResponse(describeShape('namespace result', payload?.result));
  }
  return scriptCount;
}

function invalidCloudflareListResponse(detail) {
  return new WfpApiError({
    status: 502,
    code: 'WFP_API_RESPONSE_INVALID',
    message: 'Cloudflare WFP list response was invalid.',
    detail,
  });
}

// Shape descriptions surface only field names and types, never values, so they stay log-safe.
function describeShape(label, value) {
  if (Array.isArray(value)) return `${label} is array`;
  if (!value || typeof value !== 'object') {
    return `${label} is ${value === null ? 'null' : typeof value}`;
  }
  const keys = Object.keys(value)
    .filter((key) => /^[a-zA-Z0-9_]{1,32}$/.test(key))
    .sort()
    .slice(0, 8);
  return keys.length > 0 ? `${label} keys ${keys.join(',')}` : `${label} has no readable keys`;
}

function normalizePositiveBound(value) {
  if (value === undefined || value === null || value === '') return null;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestCloudflareOk(fetch, apiToken, url, init, options = {}) {
  const operation = normalizeProviderOperation(options.operation);
  const redactionTokens = [apiToken, ...(Array.isArray(options.redactionTokens) ? options.redactionTokens : [])];
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  let response;
  try {
    response = await fetch(
      new Request(url, {
        ...init,
        headers,
      })
    );
  } catch {
    throw new WfpApiError({
      code: 'WFP_NETWORK_ERROR',
      message: NETWORK_ERROR_MESSAGE,
      operation,
    });
  }

  if (response.ok) {
    return {
      status: response.status,
      contentType: response.headers.get('Content-Type') || '',
    };
  }

  const providerRequestId = readProviderRequestId(response.headers, redactionTokens);
  const payload = await readJson(response, { operation, providerRequestId });
  const providerError = readProviderError(payload, redactionTokens);
  throw new WfpApiError({
    status: response.status,
    message: redactCloudflareError(payload, redactionTokens),
    operation,
    providerRequestId,
    ...providerError,
  });
}

export async function requestCloudflareProviderOk(fetch, apiToken, url, init, options = {}) {
  return requestCloudflareOk(fetch, apiToken, url, init, options);
}

async function readJson(response, { operation, providerRequestId } = {}) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new WfpApiError({
      status: response.status,
      code: 'WFP_API_INVALID_JSON',
      message: 'Cloudflare API returned invalid JSON.',
      operation,
      providerRequestId,
    });
  }
}

function readProviderRequestId(headers, redactionTokens = []) {
  for (const name of ['cf-ray', 'x-request-id']) {
    const value = normalizeProviderRequestId(headers?.get(name), redactionTokens);
    if (value) return value;
  }
  return undefined;
}

function readProviderError(payload, redactionTokens) {
  const error = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  return {
    providerCode: normalizeProviderCode(error?.code, redactionTokens),
    providerMessage: normalizeProviderMessage(error?.message, redactionTokens),
  };
}

function normalizeProviderOperation(value) {
  return WFP_PROVIDER_OPERATIONS.has(value) ? value : undefined;
}

function normalizeClientCode(value) {
  return typeof value === 'string' && WFP_CLIENT_CODE_RE.test(value) ? value : 'WFP_API_ERROR';
}

function normalizeProviderHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function normalizeProviderRequestId(value, redactionTokens = []) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !PROVIDER_REQUEST_ID_RE.test(normalized) ||
    containsProviderUrl(normalized) ||
    containsRedactionToken(normalized, redactionTokens)
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeProviderCode(value, redactionTokens = []) {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return undefined;
  const normalized = String(value).trim();
  if (
    !normalized ||
    normalized.length > PROVIDER_CODE_MAX_LENGTH ||
    hasProviderControlCharacters(normalized) ||
    containsProviderUrl(normalized) ||
    containsRedactionToken(normalized, redactionTokens)
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeProviderMessage(value, redactionTokens) {
  if (typeof value !== 'string') return undefined;
  const normalized = redactSensitiveText(value, redactionTokens);
  if (!normalized) return undefined;
  return normalized.slice(0, PROVIDER_MESSAGE_MAX_LENGTH);
}

function redactSensitiveText(value, redactionTokens = []) {
  let normalized = replaceProviderControlCharacters(value).trim();
  for (const token of redactionTokens) {
    if (typeof token === 'string' && token) normalized = normalized.replaceAll(token, '[redacted]');
  }
  return normalized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:["']?)(?:api[-_ ]?key|token|secret|password)(?:["']?)\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[redacted]$2')
    .replace(/((?:["']?)(?:api[-_ ]?key|token|secret|password)(?:["']?)\s*[:=]\s*)(?!["'])[^\s,;}]+/gi, '$1[redacted]')
    .replace(/(\b(?:api[-_ ]?key|token|secret|password)\s+)(["'])(.*?)\2/gi, '$1$2[redacted]$2')
    .replace(/(\b(?:api[-_ ]?key|token|secret|password)\s+)(?!["'])[^\s,;}]+/gi, '$1[redacted]')
    .replace(/\bhttps?:\/\/[^\s,;}"']+/gi, '[redacted-url]');
}

function redactCloudflareError(payload, apiTokenOrTokens) {
  const redactionTokens = Array.isArray(apiTokenOrTokens) ? apiTokenOrTokens : [apiTokenOrTokens];
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const message = errors
    .map((error) => {
      const code = normalizeProviderCode(error?.code, redactionTokens) || 'unknown';
      const detail = typeof error?.message === 'string' ? error.message : '';
      return `${code} ${detail}`.trim();
    })
    .filter(Boolean)
    .join('; ');
  return redactSensitiveText(message || 'Cloudflare WFP API request failed.', redactionTokens);
}

function hasProviderControlCharacters(value) {
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function replaceProviderControlCharacters(value) {
  let result = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    result += code <= 0x1f || code === 0x7f ? ' ' : character;
  }
  return result;
}

function containsRedactionToken(value, redactionTokens) {
  return redactionTokens.some((token) => typeof token === 'string' && token && value.includes(token));
}

function containsProviderUrl(value) {
  return /https?:\/\//i.test(String(value));
}

function scriptUrl(baseUrl, accountId, namespace, scriptName) {
  return `${scriptsUrl(baseUrl, accountId, namespace)}/${encodeURIComponent(scriptName)}`;
}

function scriptsUrl(baseUrl, accountId, namespace) {
  return `${baseUrl}/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts`;
}

function namespaceUrl(baseUrl, accountId, namespace) {
  return `${baseUrl}/accounts/${accountId}/workers/dispatch/namespaces/${namespace}`;
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
