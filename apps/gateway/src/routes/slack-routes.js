import { handleSlackEvents, handleSlackInteractions } from '../control-plane/handlers.js';

export function registerSlackRoutes(router) {
  router.post('/integrations/slack/events', handleSlackEvents);
  router.post('/integrations/slack/interactions', handleSlackInteractions);
}
