import { jsonResponse } from '@xd/worker-kit';

import { MySqlGatewayStore } from './db/gateway-store.js';
import { Router } from './http/router.js';
import { registerGatewayRoutes } from './routes/register.js';

function logSlackHttpFailure(request, url, err) {
  if (!url.pathname.startsWith('/integrations/slack/')) return;

  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_http_request_failed',
      path: url.pathname,
      status: err.status || 500,
      error: err.message,
      slackSignaturePresent: Boolean(request.headers.get('X-Slack-Signature')),
      slackTimestampPresent: Boolean(request.headers.get('X-Slack-Request-Timestamp')),
      contentType: request.headers.get('Content-Type') || null,
      userAgent: request.headers.get('User-Agent')?.slice(0, 160) || null,
    })
  );
}

async function isStorelessRetirementRoute(request, url) {
  if (request.method !== 'POST') return false;
  if (url.pathname === '/api/publishing-jobs') return true;
  if (url.pathname !== '/integrations/slack/interactions') return false;

  try {
    const rawBody = await request.clone().text();
    const contentType = request.headers.get('Content-Type') || '';
    const body = contentType.includes('application/x-www-form-urlencoded')
      ? JSON.parse(new URLSearchParams(rawBody).get('payload') || '{}')
      : JSON.parse(rawBody);
    return body.actions?.[0]?.action_id === 'pages_confirm_issue';
  } catch {
    return false;
  }
}

function createGatewayAppWithRouteOptions(options = {}) {
  const router = new Router();
  let store = options.store || null;
  let storePromise = store ? Promise.resolve(store) : null;
  const createStore = options.createStore || MySqlGatewayStore.create;

  async function resolveStore(env) {
    if (!storePromise) {
      storePromise = createStore(env).catch((error) => {
        storePromise = null;
        throw error;
      });
    }
    store = await storePromise;
    return store;
  }

  registerGatewayRoutes(router);

  return {
    get store() {
      return store;
    },
    async fetch(request, env = {}, ctx = {}) {
      const url = new URL(request.url);
      const match = router.match(request.method, url.pathname);

      if (!match) {
        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      }

      try {
        const storelessRetirementRoute = await isStorelessRetirementRoute(request, url);
        if ((request.method === 'GET' && url.pathname === '/health') || storelessRetirementRoute) {
          return await match.handler(
            request,
            { ...env, waitUntil: ctx.waitUntil?.bind(ctx), ...(store ? { store } : {}) },
            match.params
          );
        }
        const requestStore = await resolveStore(env);
        return await match.handler(request, { ...env, waitUntil: ctx.waitUntil?.bind(ctx), store: requestStore }, match.params);
      } catch (err) {
        logSlackHttpFailure(request, url, err);
        return jsonResponse({ error: err.message }, err.status || 500);
      }
    },
  };
}

export function createGatewayApp(options = {}) {
  return createGatewayAppWithRouteOptions(options);
}

const defaultApp = createGatewayApp();

export default {
  fetch(request, env, ctx) {
    return defaultApp.fetch(request, env, ctx);
  },
};
