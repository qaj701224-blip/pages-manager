export function createDeploymentPreviousResourceCleanup({
  provider,
  cleanupTasks,
  clock,
  ids,
  managedWorkers,
  telemetry,
  config = {},
}) {
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');
  if (typeof managedWorkers?.isManaged !== 'function') throw new TypeError('managedWorkers.isManaged is required');
  if (typeof telemetry?.record !== 'function') throw new TypeError('telemetry.record is required');

  return { cleanup };

  async function cleanup(command) {
    const outcomes = [];
    const slotOutcome = await cleanupPreviousNormalWorkerSlot(
      provider,
      clock,
      command.previousRoute,
      command.activeRoute
    );
    outcomes.push(await telemetry.record(slotOutcome, { trafficImpact: 'new_version_active' }));

    const workerOutcome = await enqueuePreviousWfpWorkerCleanup(
      { cleanupTasks, clock, ids, managedWorkers, config },
      command
    );
    outcomes.push(await telemetry.record(workerOutcome, { trafficImpact: 'new_version_active' }));
    return outcomes;
  }
}

async function cleanupPreviousNormalWorkerSlot(provider, clock, previousRoute, activeRoute) {
  const operation = 'worker_placeholder_put';
  if (typeof provider?.cleanupRetainedSlot !== 'function') return outcome('not_needed', operation);
  if (previousRoute?.executionProvider !== 'normal-worker-slot') return outcome('not_needed', operation);
  if (!previousRoute.slotId || !previousRoute.activeVersionId || previousRoute.slotId === activeRoute?.slotId) {
    return outcome('not_needed', operation);
  }
  try {
    await provider.cleanupRetainedSlot({
      slotId: previousRoute.slotId,
      versionId: previousRoute.activeVersionId,
      activeSlotId: activeRoute?.slotId || null,
      updatedAt: clock.now(),
    });
    return outcome('succeeded', operation);
  } catch (error) {
    return outcome('failed', error?.operation || operation, { error });
  }
}

async function enqueuePreviousWfpWorkerCleanup(context, command) {
  const operation = 'worker_delete';
  const { previousRoute, activeRoute, deployment, environment } = command;
  if (typeof context.cleanupTasks?.create !== 'function') return outcome('not_needed', operation);
  if (!previousRoute || previousRoute.routeStatus !== 'active') return outcome('not_needed', operation);
  if (previousRoute.executionProvider !== 'wfp' && previousRoute.dispatchType !== 'dispatch-namespace') {
    return outcome('not_needed', operation);
  }
  if (!previousRoute.workerName || !previousRoute.activeVersionId) return outcome('not_needed', operation);
  if (previousRoute.workerName === activeRoute?.workerName || previousRoute.activeVersionId === activeRoute?.activeVersionId) {
    return outcome('not_needed', operation);
  }
  if (!context.managedWorkers.isManaged(previousRoute.workerName, environment)) return outcome('not_needed', operation);

  const cleanupTaskId = context.ids.next('cln');
  try {
    await context.cleanupTasks.create({
      id: cleanupTaskId,
      environment,
      resourceType: 'wfp_user_worker',
      resourceRef: previousRoute.workerName,
      siteId: previousRoute.siteId,
      versionId: previousRoute.activeVersionId,
      deploymentId: deployment.id,
      cleanupReason: 'blue_green_previous_worker',
      status: 'pending',
      cleanupAfter: cleanupAfterDrainWindow(context.clock, context.config.cleanupDrainSeconds),
    });
    return outcome('scheduled', operation, { cleanupTaskId });
  } catch {
    return outcome('failed', operation, { cleanupTaskId, causeClass: 'cleanup_task_store_error' });
  }
}

function cleanupAfterDrainWindow(clock, configuredValue) {
  const now = Date.parse(clock.now());
  const configured = Number(configuredValue);
  const seconds = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 24 * 60 * 60) : 300;
  return new Date(now + seconds * 1000).toISOString();
}

function outcome(status, operation, { cleanupTaskId, error, causeClass } = {}) {
  return {
    status,
    operation,
    ...(cleanupTaskId ? { cleanupTaskId } : {}),
    causeClass: causeClass || (status === 'failed' ? 'cleanup_error' : `cleanup_${status}`),
    ...(error ? { error } : {}),
  };
}
