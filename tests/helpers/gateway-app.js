import { Router } from '../../apps/gateway/src/http/router.js';
import {
  handleExecutorCallback,
  handleReviewGateReconcile,
} from '../../apps/gateway/src/control-plane/executor-callback-handlers.js';
import { handleGithubWebhook } from '../../apps/gateway/src/control-plane/github-webhook-handlers.js';
import { handleHealth, handleReady } from '../../apps/gateway/src/control-plane/health-handlers.js';
import { handleSlackEvents } from '../../apps/gateway/src/control-plane/slack-event-handlers.js';
import { handleSlackInteractions } from '../../apps/gateway/src/control-plane/slack-interaction-handlers.js';
import { handleLegacyCreatePublishingJob } from '../../apps/gateway/src/publishing/api-handlers.js';
import {
  handleGetPublishingJob,
  handleGetPublishingJobEvents,
  handleListPublishingJobs,
} from '../../apps/gateway/src/publishing/api-handlers.js';
import { jsonResponse } from '../../packages/worker-kit/src/index.js';

import { GatewayStoreFixture } from './gateway-store-fixture.js';

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

function registerLegacyGatewayRoutesForTests(router) {
  const legacyOptions = { retireSitePublishing: false };

  router.get('/health', handleHealth);
  router.get('/ready', handleReady);
  router.post('/api/publishing-jobs', handleLegacyCreatePublishingJob);
  router.get('/api/publishing-jobs', handleListPublishingJobs);
  router.get('/api/publishing-jobs/:jobId', handleGetPublishingJob);
  router.get('/api/publishing-jobs/:jobId/events', handleGetPublishingJobEvents);
  router.post('/integrations/slack/events', (request, env) => handleSlackEvents(request, env, legacyOptions));
  router.post('/integrations/slack/interactions', (request, env) => handleSlackInteractions(request, env, legacyOptions));
  router.post('/internal/executor-callback', (request, env) => handleExecutorCallback(request, env, legacyOptions));
  router.post('/internal/review-gate/reconcile', (request, env) => handleReviewGateReconcile(request, env, legacyOptions));
  router.post('/integrations/github/webhook', (request, env) => handleGithubWebhook(request, env, legacyOptions));
}

export function createGatewayApp(options = {}) {
  const router = new Router();
  const store = options.store || new GatewayStoreFixture();

  registerLegacyGatewayRoutesForTests(router);

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
        return await match.handler(request, { ...env, waitUntil: ctx.waitUntil?.bind(ctx), store }, match.params);
      } catch (err) {
        logSlackHttpFailure(request, url, err);
        return jsonResponse({ error: err.message }, err.status || 500);
      }
    },
  };
}
