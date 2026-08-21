const DELETABLE_STATUSES = new Set(['available', 'assigned', 'cleanup_pending', 'disabled', 'delete_pending']);

export function createNormalWorkersQuery({ workers }) {
  if (typeof workers?.list !== 'function') throw new TypeError('workers.list is required');

  return { list };

  async function list(query) {
    const records = await workers.list({ environment: query.environment });
    return records.map(projectNormalWorker);
  }
}

export function projectNormalWorker(worker) {
  const activeRoute = worker.activeRoute || null;
  const lifecycle = activeRoute
    ? 'active'
    : worker.status === 'retired'
      ? 'retired'
      : DELETABLE_STATUSES.has(worker.status)
        ? 'idle'
        : worker.status;
  return {
    id: worker.id,
    environment: worker.environment,
    slotNumber: worker.slotNumber,
    workerName: worker.workerName,
    bindingName: worker.bindingName,
    status: worker.status,
    lifecycle,
    canDelete: lifecycle === 'idle',
    activeRoute: activeRoute
      ? {
          siteId: activeRoute.siteId,
          routeId: activeRoute.routeId,
          activeVersionId: activeRoute.activeVersionId,
          hostname: activeRoute.hostname,
        }
      : null,
    updatedAt: worker.updatedAt,
  };
}
