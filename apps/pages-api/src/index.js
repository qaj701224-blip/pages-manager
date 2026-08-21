import { runDueDeploymentCleanups } from './admin.js';
import { readApiConfig } from './infrastructure/config/api-config.js';
import { createPagesStore } from './infrastructure/store/create-store.js';
import { RoutePointerDO } from './route-snapshot.js';
import { createPagesApiRouter } from './transport/router.js';
import { createScheduledHandler } from './transport/scheduled.js';

export { RoutePointerDO };

const routePagesApiRequest = createPagesApiRouter({ createStore: createPagesStore });
const handleScheduled = createScheduledHandler({
  readConfig: readApiConfig,
  createStore: createPagesStore,
  runDueCleanups: runDueDeploymentCleanups,
  taskScheduler: {
    schedule: (executionContext, task) => executionContext.waitUntil(task),
  },
});

export default {
  scheduled(controller, env, executionContext) {
    return handleScheduled(controller, env, executionContext);
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
