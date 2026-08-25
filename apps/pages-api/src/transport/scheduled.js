export function createScheduledHandler({ readConfig, createStore, runDueCleanups, runMetadataReconciliation, taskScheduler }) {
  if (typeof taskScheduler?.schedule !== 'function') throw new TypeError('taskScheduler.schedule is required');
  if (typeof runMetadataReconciliation !== 'function') {
    throw new TypeError('runMetadataReconciliation is required');
  }

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
      runMetadataReconciliation(env, config, store, {
        limit: Number(env.SITE_METADATA_RECONCILIATION_CRON_LIMIT || 50),
      }),
    ]);
    void controller;
    return executionContext ? taskScheduler.schedule(executionContext, task) : task;
  };
}
