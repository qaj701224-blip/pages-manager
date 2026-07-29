import { handleSlackEvents } from '../control-plane/slack-event-handlers.js';
import { handleSlackInteractions } from '../control-plane/slack-interaction-handlers.js';

export function registerSlackRoutes(router) {
  router.post('/integrations/slack/events', handleSlackEvents);
  router.post('/integrations/slack/interactions', handleSlackInteractions);
}
