import { projectNormalWorker } from './list-normal-workers.js';

const BATCH_CONCURRENCY = 5;

export function createNormalWorkerRetirement({ workers, provider, clock }) {
  if (typeof workers?.list !== 'function') throw new TypeError('workers.list is required');
  if (typeof workers?.retire !== 'function') throw new TypeError('workers.retire is required');
  if (typeof provider?.deleteWorker !== 'function') throw new TypeError('provider.deleteWorker is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { retire, retireBatch };

  async function retire(command) {
    const records = await workers.list({ environment: command.environment });
    const worker = records.find((item) => item.id === command.id);
    if (!worker) return failed(command.id, 'NORMAL_WORKER_NOT_FOUND');
    return retireRecord(command, worker);
  }

  async function retireBatch(command) {
    const records = await workers.list({ environment: command.environment });
    const workerById = new Map(records.map((worker) => [worker.id, worker]));
    const results = await mapBatch(command.ids, async (id) => {
      const worker = workerById.get(id);
      if (!worker) return failed(id, 'NORMAL_WORKER_NOT_FOUND');
      return retireRecord({ ...command, id }, worker);
    });
    return {
      summary: {
        requested: command.ids.length,
        retired: countStatus(results, 'retired'),
        pending: countStatus(results, 'delete_pending'),
        failed: countStatus(results, 'failed'),
      },
      results,
    };
  }

  async function retireRecord(command, worker) {
    const projected = projectNormalWorker(worker);
    if (!projected.canDelete) {
      return failed(worker.id, 'NORMAL_WORKER_ACTIVE', projected);
    }

    try {
      await provider.deleteWorker({ workerName: worker.workerName });
    } catch (error) {
      if (!isDeleteBlocked(error)) {
        return failed(worker.id, 'NORMAL_WORKER_DELETE_FAILED', projected);
      }
      const pending =
        typeof workers.markDeletePending === 'function'
          ? await workers.markDeletePending(mutationInput(command, worker.id))
          : null;
      if (!pending) return failed(worker.id, 'NORMAL_WORKER_ACTIVE', projected);
      return {
        id: worker.id,
        status: 'delete_pending',
        worker: projectNormalWorker(pending),
      };
    }

    let retired;
    try {
      retired = await workers.retire(mutationInput(command, worker.id));
    } catch {
      return failed(worker.id, 'NORMAL_WORKER_STATE_INCONSISTENT', projected);
    }
    if (!retired) return failed(worker.id, 'NORMAL_WORKER_STATE_INCONSISTENT', projected);
    return {
      id: worker.id,
      status: 'retired',
      worker: projectNormalWorker(retired),
    };
  }

  function mutationInput(command, id) {
    return {
      id,
      environment: command.environment,
      actorUserId: command.actorUserId,
      reason: command.reason,
      updatedAt: clock.now(),
    };
  }
}

async function mapBatch(ids, mapper) {
  const results = new Array(ids.length);
  let nextIndex = 0;
  const consumers = Array.from({ length: Math.min(BATCH_CONCURRENCY, ids.length) }, async () => {
    while (nextIndex < ids.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(ids[index]);
    }
  });
  await Promise.all(consumers);
  return results;
}

function failed(id, errorCode, worker) {
  return {
    id,
    status: 'failed',
    errorCode,
    ...(worker ? { worker } : {}),
  };
}

function isDeleteBlocked(error) {
  return error?.code === 'NORMAL_WORKER_DELETE_BLOCKED' || error?.status === 409;
}

function countStatus(results, status) {
  return results.filter((result) => result.status === status).length;
}
