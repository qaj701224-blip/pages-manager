export function createRequestContext({ request, env, config, executionContext, createStore }) {
  let storeResult;

  return {
    request,
    env,
    config,
    executionContext,
    getStore() {
      if (!storeResult) storeResult = initializeStore(createStore, env);
      return storeResult;
    },
  };
}

function initializeStore(createStore, env) {
  try {
    return { ok: true, store: createStore(env) };
  } catch {
    return { ok: false, store: null };
  }
}
