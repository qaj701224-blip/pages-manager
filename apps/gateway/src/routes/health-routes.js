import { handleHealth, handleReady } from '../control-plane/health-handlers.js';

export function registerHealthRoutes(router) {
  router.get('/health', handleHealth);
  router.get('/ready', handleReady);
}
