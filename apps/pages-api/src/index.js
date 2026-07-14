import { handleAccessKeysApi, handleConsoleAccessKeysApi } from './access-keys.js';
import { handleConsoleAdminApi, runDueDeploymentCleanups } from './admin.js';
import { handleConsoleApi } from './console.js';
import { readApiConfig } from './config.js';
import { handleDeploymentsApi, handleVersionsApi } from './deployments.js';
import { jsonError, jsonOk } from './http.js';
import { handleInternalApi } from './internal.js';
import { handleConsoleUsersApi } from './console-users.js';
import { buildReadme, buildSkill, markdownResponse } from './public-docs.js';
import { handleSitesApi } from './sites.js';
import { handleS2STokensApi } from './s2s-tokens.js';
import { createPagesStore } from './store.js';
import { handleConsoleTeamsApi, handleTeamsApi } from './teams.js';
import { handleWhoamiApi } from './whoami.js';
import { isAllowedIP } from '../../../packages/ip-guard/src/index.js';

export { RoutePointerDO } from './route-snapshot.js';

export default {
  async scheduled(controller, env) {
    let config;
    try {
      config = readApiConfig(env);
    } catch {
      return;
    }

    let store;
    try {
      store = createPagesStore(env);
    } catch {
      return;
    }

    await Promise.allSettled([
      runDueDeploymentCleanups(env, config, store, {
        limit: Number(env.DEPLOYMENT_CLEANUP_CRON_LIMIT || 10),
      }),
      typeof store.cleanupExpiredS2SGuards === 'function'
        ? store.cleanupExpiredS2SGuards(typeof env.now === 'function' ? env.now() : new Date().toISOString())
        : Promise.resolve(),
    ]);
    void controller;
  },

  async fetch(request, env, ctx) {
    if (request.headers.has('X-Pages-Token')) {
      return jsonError(
        'LEGACY_TOKEN_UNSUPPORTED',
        'Legacy Pages tokens are not supported by XD Cell.',
        400,
        'Run `xd-cell login` or use an XD Cell access key.'
      );
    }

    let config;
    try {
      config = readApiConfig(env);
    } catch {
      return jsonError(
        'API_ENV_INVALID',
        'Pages API environment is invalid.',
        500,
        'Check the pages-api Worker environment configuration.'
      );
    }

    const url = new URL(request.url);
    if (url.pathname === '/.xd-pages/health') {
      return jsonOk({
        status: 'ok',
        service: 'pages-api',
        environment: config.environment,
      });
    }

    if (url.pathname === '/skill.md') return markdownResponse(buildSkill(config));
    if (url.pathname === '/readme.md') return markdownResponse(buildReadme(config));

    if (requiresIpAllowlist(url)) {
      const ipError = checkIpAllowlist(request, env, config);
      if (ipError) return ipError;
    }

    if (url.pathname.startsWith('/.xd-pages/api/s2s/')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }
      const response = await handleS2STokensApi(request, env, config, store, ctx);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/internal/')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }

      const response = await handleInternalApi(request, env, store);
      if (response) return response;
    }

    if (url.hostname === 'pages-api.internal' && url.pathname.startsWith('/.xd-pages/api/console/')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }

      const response =
        (await handleConsoleAdminApi(request, env, config, store)) ||
        (await handleConsoleAccessKeysApi(request, env, config, store)) ||
        (await handleConsoleTeamsApi(request, env, config, store)) ||
        (await handleConsoleUsersApi(request, env, config, store)) ||
        (await handleConsoleApi(request, env, config, store));
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/auth/')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }

      const response = await handleWhoamiApi(request, env, config, store);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/sites')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }

      const response = await handleSitesApi(request, env, config, store);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/teams')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }

      const response = await handleTeamsApi(request, env, config, store);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/access-keys')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }

      const response = await handleAccessKeysApi(request, env, config, store);
      if (response) return response;
    }

    if (url.pathname.startsWith('/.xd-pages/api/deployments') || url.pathname.startsWith('/.xd-pages/api/versions')) {
      let store;
      try {
        store = createPagesStore(env);
      } catch {
        return jsonError('API_STORE_UNAVAILABLE', 'Pages API store is unavailable.', 500, 'Check the pages-api D1 binding.');
      }

      const response = url.pathname.startsWith('/.xd-pages/api/deployments')
        ? await handleDeploymentsApi(request, env, config, store, ctx)
        : await handleVersionsApi(request, env, config, store);
      if (response) return response;
    }

    return jsonError('NOT_FOUND', 'Endpoint not found.', 404, 'Check the endpoint path and API version.');
  },
};

function requiresIpAllowlist(url) {
  if (url.hostname.endsWith('.internal')) return false;
  const pathname = url.pathname;
  if (pathname === '/.xd-pages/health') return false;
  if (pathname === '/skill.md' || pathname === '/readme.md') return false;
  return true;
}

function checkIpAllowlist(request, env, config) {
  if (config.environment === 'local') return null;
  const allowlist = String(env.IP_ALLOWLIST || '').trim();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (isAllowedIP(ip, allowlist)) return null;
  return jsonError('IP_NOT_ALLOWED', 'Source IP is not allowed.', 403, 'Connect from the company network or VPN.');
}
