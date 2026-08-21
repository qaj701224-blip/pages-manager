import { runDueDeploymentCleanups } from './admin.js';
import { readApiConfig } from './config.js';
import { RoutePointerDO } from './route-snapshot.js';
import { createPagesStore } from './store.js';
import { createPagesApiRouter } from './transport/router.js';
import { createScheduledHandler } from './transport/scheduled.js';

export { RoutePointerDO };

const routePagesApiRequest = createPagesApiRouter({ createStore: createPagesStore });
const handleScheduled = createScheduledHandler({
  readConfig: readApiConfig,
  createStore: createPagesStore,
  runDueCleanups: runDueDeploymentCleanups,
});

export default {
  scheduled(controller, env) {
    return handleScheduled(controller, env);
  },

  async fetch(request, env, executionContext) {
    let config;
    try {
      config = readApiConfig(env);
    } catch {
      config = null;
    }
    return routePagesApiRequest(request, env, executionContext, config);
  },
};
