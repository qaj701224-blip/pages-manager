import { handleAccessKeysApi, handleConsoleAccessKeysApi } from '../access-keys.js';
import { handleConsoleAdminApi } from './console/admin-handler.js';
import { handleConsoleApi } from '../console.js';
import { handleConsoleUsersApi } from '../console-users.js';
import { createDeploymentTraceContext, recordDeploymentStage, withDeploymentTraceHeader } from '../deployment-trace.js';
import { jsonError, jsonOk } from '../http.js';
import { handleInternalApi } from '../internal.js';
import { buildReadme, buildSkill, markdownResponse } from '../public-docs.js';
import { handlePublicSitesApi } from './public/public-sites-handler.js';
import { handleSitesApi } from './public/sites-handler.js';
import { handleConsoleTeamsApi, handleTeamsApi } from '../teams.js';
import { handleWhoamiApi } from '../whoami.js';

import { createRequestContext } from './shared/request-context.js';
import { handleDeploymentsApi, handleVersionsApi } from './public/deployments-handler.js';

export function createPagesApiRouter({ createStore }) {
  if (typeof createStore !== 'function') throw new TypeError('createStore is required');

  return async function routePagesApiRequest(request, env, executionContext, config) {
    const url = new URL(request.url);
    if (!config) return invalidEnvironmentResponse(request, env, url);

    const transportError = requireHttps(url, config);
    if (transportError) return withDeploymentPreflightTrace(transportError, request, env, config, url);

    if (request.headers.has('X-Pages-Token')) {
      return withDeploymentPreflightTrace(
        jsonError(
          'LEGACY_TOKEN_UNSUPPORTED',
          'Legacy Pages tokens are not supported by XD Cell.',
          400,
          'Run `xd-cell login` or use an XD Cell access key.'
        ),
        request,
        env,
        config,
        url
      );
    }

    if (url.pathname === '/.xd-pages/health') {
      return jsonOk({
        status: 'ok',
        service: 'pages-api',
        environment: config.environment,
      });
    }

    if (url.pathname === '/skill.md') return markdownResponse(buildSkill(config));
    if (url.pathname === '/readme.md') return markdownResponse(buildReadme(config));

    const context = createRequestContext({ request, env, config, executionContext, createStore });

    if (url.pathname.startsWith('/.xd-pages/internal/')) {
      const store = readStore(context);
      if (!store) return storeUnavailableResponse();

      const response = await handleInternalApi(request, env, store);
      if (response) return response;
    }

    if (url.hostname === 'pages-api.internal' && url.pathname.startsWith('/.xd-pages/api/console/')) {
      const store = readStore(context);
      if (!store) return storeUnavailableResponse();

      const response =
        (await handleConsoleAdminApi(request, env, config, store, executionContext)) ||
        (await handleConsoleAccessKeysApi(request, env, config, store)) ||
        (await handleConsoleTeamsApi(request, env, config, store)) ||
        (await handleConsoleUsersApi(request, env, config, store)) ||
        (await handleConsoleApi(request, env, config, store, executionContext));
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/auth/')) {
      const store = readStore(context);
      if (!store) return storeUnavailableResponse();

      const response = await handleWhoamiApi(request, env, config, store);
      if (response) return response;
    }

    if (url.pathname === '/.xd-pages/api/public/sites') {
      const store = readStore(context);
      if (!store) return storeUnavailableResponse();
      return handlePublicSitesApi(request, env, config, store);
    }

    if (url.pathname.startsWith('/.xd-pages/api/sites')) {
      const store = readStore(context);
      if (!store) return storeUnavailableResponse();

      const response = await handleSitesApi(request, env, config, store, executionContext);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/teams')) {
      const store = readStore(context);
      if (!store) return storeUnavailableResponse();

      const response = await handleTeamsApi(request, env, config, store);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/access-keys')) {
      const store = readStore(context);
      if (!store) return storeUnavailableResponse();

      const response = await handleAccessKeysApi(request, env, config, store);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/deployments') || url.pathname.startsWith('/.xd-pages/api/versions')) {
      const store = readStore(context);
      if (!store) return deploymentStoreUnavailableResponse(request, env, config, url);

      const response = url.pathname.startsWith('/.xd-pages/api/deployments')
        ? await handleDeploymentsApi(request, env, config, store, executionContext)
        : await handleVersionsApi(request, env, config, store, executionContext);
      if (response) return response;
    }

    return jsonError('NOT_FOUND', 'Endpoint not found.', 404, 'Check the endpoint path and API version.');
  };
}

function invalidEnvironmentResponse(request, env, url) {
  return withDeploymentPreflightTrace(
    jsonError(
      'API_ENV_INVALID',
      'Pages API environment is invalid.',
      500,
      'Check the pages-api Worker environment configuration.'
    ),
    request,
    env,
    null,
    url
  );
}

function readStore(context) {
  const result = context.getStore();
  return result.ok ? result.store : null;
}

function storeUnavailableResponse() {
  return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
}

async function deploymentStoreUnavailableResponse(request, env, config, url) {
  const response = storeUnavailableResponse();
  const operation = deploymentTraceOperation(request, url.pathname);
  if (!operation) return response;

  const trace = createDeploymentTraceContext(request, env, {
    environment: config.environment,
    operation,
    now: env?.now,
  });
  await recordDeploymentStage(trace, {
    stage: 'deployment_record',
    operation: 'create_store',
    status: 'failed',
    errorCode: 'API_STORE_UNAVAILABLE',
    errorMessage: 'Pages API store is unavailable.',
    diagnostics: { causeClass: 'event_store_error' },
  });
  return withDeploymentTraceHeader(response, trace.traceId);
}

function deploymentTraceOperation(request, pathname) {
  if (request.method !== 'POST') return null;
  if (pathname === '/.xd-pages/api/deployments') return 'deploy';
  if (/^\/\.xd-pages\/api\/versions\/[^/]+\/rollback$/.test(pathname)) return 'rollback';
  return null;
}

function withDeploymentPreflightTrace(response, request, env, config, url) {
  const operation = deploymentTraceOperation(request, url.pathname);
  if (!operation) return response;
  const trace = createDeploymentTraceContext(request, env, {
    environment: config?.environment,
    operation,
    now: env?.now,
  });
  return withDeploymentTraceHeader(response, trace.traceId);
}

function requireHttps(url, config) {
  if (config.environment === 'local' || url.protocol === 'https:') return null;
  return jsonError('HTTPS_REQUIRED', 'HTTPS is required.', 400, 'Use an https:// API URL.');
}
