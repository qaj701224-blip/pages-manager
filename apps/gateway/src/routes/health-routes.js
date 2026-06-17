import { handleHealth, handleReady } from '../control-plane/handlers.js';

export function registerHealthRoutes(router) {
  router.get('/health', handleHealth);
  router.get('/ready', handleReady);
}
