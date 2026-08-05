import { handleExecutorCallback, handleReviewGateReconcile } from '../control-plane/executor-callback-handlers.js';

export function registerInternalRoutes(router) {
  router.post('/internal/executor-callback', handleExecutorCallback);
  router.post('/internal/review-gate/reconcile', handleReviewGateReconcile);
}
