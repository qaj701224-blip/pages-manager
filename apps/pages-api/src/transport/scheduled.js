export function createScheduledHandler({ readConfig, createStore, runDueCleanups }) {
  return async function handleScheduled(controller, env) {
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

    await Promise.allSettled([
      runDueCleanups(env, config, store, {
        limit: Number(env.DEPLOYMENT_CLEANUP_CRON_LIMIT || 10),
      }),
    ]);
    void controller;
  };
}
