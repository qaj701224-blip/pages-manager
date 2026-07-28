import { handleGithubWebhook } from '../control-plane/github-webhook-handlers.js';

export function registerGithubRoutes(router) {
  router.post('/integrations/github/webhook', handleGithubWebhook);
}
