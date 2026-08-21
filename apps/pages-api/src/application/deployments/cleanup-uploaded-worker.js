export function createUploadedWorkerCompensation({ routes, workers, diagnostics, telemetry }) {
  if (typeof routes?.get !== 'function') throw new TypeError('routes.get is required');
  if (typeof diagnostics?.fromError !== 'function') throw new TypeError('diagnostics.fromError is required');
  if (typeof telemetry?.record !== 'function') throw new TypeError('telemetry.record is required');

  return { cleanup, cleanupIfInactive };

  async function cleanup(command) {
    const { uploaded, ...context } = command;
    const result = await deleteUploadedWorker(uploaded);
    return telemetry.record(result, context);
  }

  async function cleanupIfInactive(command) {
    const { uploaded, siteId, versionId, environment, ...context } = command;
    let result;
    try {
      const route = await routes.get(siteId, environment);
      result = routeReferencesUploadedWorker(route, uploaded, versionId)
        ? outcome('not_needed', 'worker_delete', { causeClass: 'cleanup_not_needed' })
        : await deleteUploadedWorker(uploaded);
    } catch {
      result = outcome('failed', 'worker_delete', { causeClass: 'cleanup_state_read_error' });
    }
    return telemetry.record(result, context);
  }

  async function deleteUploadedWorker(uploaded) {
    const operation = 'worker_delete';
    if (!uploaded || typeof workers?.delete !== 'function') {
      return outcome('not_needed', operation, { causeClass: 'cleanup_not_needed' });
    }
    try {
      await workers.delete(uploaded);
      return outcome('succeeded', operation, { causeClass: 'cleanup_succeeded' });
    } catch (error) {
      return outcome('failed', error?.operation || operation, { error });
    }
  }

  function outcome(status, operation, { error, causeClass } = {}) {
    const provider = error ? diagnostics.fromError(error) : undefined;
    return {
      status,
      operation,
      causeClass: causeClass || provider?.causeClass || (status === 'failed' ? 'cleanup_error' : 'cleanup_succeeded'),
      ...(provider ? { provider } : {}),
    };
  }
}

function routeReferencesUploadedWorker(route, uploaded, versionId) {
  if (!route || !uploaded) return false;
  return (
    route.activeVersionId === versionId ||
    (uploaded.workerName && route.workerName === uploaded.workerName) ||
    (uploaded.slotId && route.slotId === uploaded.slotId)
  );
}
