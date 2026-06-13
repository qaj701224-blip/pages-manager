import { jsonResponse } from '@xd/worker-kit';

import {
  handleCreatePublishingJob,
  handleExecutorCallback,
  handleGetPublishingJob,
  handleGetPublishingJobEvents,
  handleGithubWebhook,
  handleHealth,
  handleSlackEvents,
} from './handlers.js';
import { Router } from './router.js';
import { MemoryGatewayStore } from './store.js';

export function createGatewayApp(options = {}) {
  const router = new Router();
  const store = options.store || new MemoryGatewayStore();

  router.get('/health', handleHealth);
  router.post('/api/publishing-jobs', handleCreatePublishingJob);
  router.get('/api/publishing-jobs/:jobId', handleGetPublishingJob);
  router.get('/api/publishing-jobs/:jobId/events', handleGetPublishingJobEvents);
  router.post('/integrations/slack/events', handleSlackEvents);
  router.post('/internal/executor-callback', handleExecutorCallback);
  router.post('/integrations/github/webhook', handleGithubWebhook);

  return {
    store,
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const match = router.match(request.method, url.pathname);

      if (!match) {
        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      }

      try {
        return await match.handler(request, { ...env, store }, match.params);
      } catch (err) {
        return jsonResponse({ error: err.message }, err.status || 500);
      }
    },
  };
}

const defaultApp = createGatewayApp();

export default {
  fetch(request, env) {
    return defaultApp.fetch(request, env);
  },
};
