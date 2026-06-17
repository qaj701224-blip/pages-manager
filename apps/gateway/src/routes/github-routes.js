import { handleGithubWebhook } from '../control-plane/handlers.js';

export function registerGithubRoutes(router) {
  router.post('/integrations/github/webhook', handleGithubWebhook);
}
