import { jsonResponse } from '@xd/worker-kit';

import {
  handleCreatePublishingJob,
  handleExecutorCallback,
  handleGetPublishingJob,
  handleGetPublishingJobEvents,
  handleGithubWebhook,
  handleHealth,
  handleListPublishingJobs,
  handleReady,
  handleReviewGateReconcile,
  handleSlackEvents,
  handleSlackInteractions,
} from './routes/handlers.js';
import { MySqlGatewayStore } from './db/gateway-store.js';
import { Router } from './http/router.js';

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

export function createGatewayApp(options = {}) {
  const router = new Router();
  let store = options.store || null;
  let storePromise = store ? Promise.resolve(store) : null;

  async function resolveStore(env) {
    if (!storePromise) {
      storePromise = MySqlGatewayStore.create(env);
    }
    store = await storePromise;
    return store;
  }

  router.get('/health', handleHealth);
  router.get('/ready', handleReady);
  router.post('/api/publishing-jobs', handleCreatePublishingJob);
  router.get('/api/publishing-jobs', handleListPublishingJobs);
  router.get('/api/publishing-jobs/:jobId', handleGetPublishingJob);
  router.get('/api/publishing-jobs/:jobId/events', handleGetPublishingJobEvents);
  router.post('/integrations/slack/events', handleSlackEvents);
  router.post('/integrations/slack/interactions', handleSlackInteractions);
  router.post('/internal/executor-callback', handleExecutorCallback);
  router.post('/internal/review-gate/reconcile', handleReviewGateReconcile);
  router.post('/integrations/github/webhook', handleGithubWebhook);

  return {
    get store() {
      return store;
    },
    async fetch(request, env = {}, ctx = {}) {
      const requestStore = await resolveStore(env);
      const url = new URL(request.url);
      const match = router.match(request.method, url.pathname);

      if (!match) {
        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      }

      try {
        return await match.handler(request, { ...env, waitUntil: ctx.waitUntil?.bind(ctx), store: requestStore }, match.params);
      } catch (err) {
        logSlackHttpFailure(request, url, err);
        return jsonResponse({ error: err.message }, err.status || 500);
      }
    },
  };
}

const defaultApp = createGatewayApp();

export default {
  fetch(request, env, ctx) {
    return defaultApp.fetch(request, env, ctx);
  },
};
