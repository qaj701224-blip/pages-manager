export function createScheduledHandler({ readConfig, createStore, runDueCleanups, taskScheduler }) {
  if (typeof taskScheduler?.schedule !== 'function') throw new TypeError('taskScheduler.schedule is required');

  return async function handleScheduled(controller, env, executionContext) {
    let config;
    try {
      config = readConfig(env);
    } catch {
      return;
    }

    let store;
    try {
      store = createStore(env);
    } catch {
      return;
    }

    const task = Promise.allSettled([
      runDueCleanups(env, config, store, {
        limit: Number(env.DEPLOYMENT_CLEANUP_CRON_LIMIT || 10),
      }),
    ]);
    void controller;
    return executionContext ? taskScheduler.schedule(executionContext, task) : task;
  };
}
