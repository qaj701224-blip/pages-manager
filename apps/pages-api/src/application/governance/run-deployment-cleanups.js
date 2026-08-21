const RUNNABLE_STATUSES = ['pending', 'failed', 'running'];

export function createDeploymentCleanupRunner({ tasks, executor, clock }) {
  if (typeof tasks?.list !== 'function') throw new TypeError('tasks.list is required');
  if (typeof tasks?.get !== 'function') throw new TypeError('tasks.get is required');
  if (typeof executor?.execute !== 'function') throw new TypeError('executor.execute is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { runOne, runDue };

  async function runOne(command) {
    let task;
    try {
      task = await tasks.get(command.id, command.environment);
    } catch {
      return { ok: false, reason: 'task_read_failed' };
    }
    if (!task) return { ok: false, reason: 'task_not_found' };
    return { ok: true, task, execution: await executeSafe(task) };
  }

  async function runDue(command) {
    const limit = normalizeLimit(command.limit);
    const taskGroups = await Promise.all(
      RUNNABLE_STATUSES.map((status) => tasks.list({ environment: command.environment, status, limit }))
    );
    const tasksById = new Map();
    for (const task of taskGroups.flat()) tasksById.set(task.id, task);
    const runnable = [...tasksById.values()]
      .sort(
        (left, right) =>
          left.cleanupAfter.localeCompare(right.cleanupAfter) || left.createdAt.localeCompare(right.createdAt)
      )
      .filter((task) => canRunDeploymentCleanupTask(task, clock.now()))
      .slice(0, limit);

    const summary = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    for (const task of runnable) {
      let execution;
      try {
        const latest = await tasks.get(task.id, command.environment);
        execution = await executeSafe(latest);
      } catch {
        execution = unexpectedExecution();
      }
      summary.processed += 1;
      if (execution.outcome === 'succeeded') summary.succeeded += 1;
      else if (execution.outcome === 'failed') summary.failed += 1;
      else summary.skipped += 1;
    }
    return summary;
  }

  async function executeSafe(task) {
    try {
      return await executor.execute(task);
    } catch {
      return unexpectedExecution();
    }
  }
}

export function canRunDeploymentCleanupTask(task, now) {
  if (!task) return false;
  const nowMs = Date.parse(now);
  if (Date.parse(task.cleanupAfter) > nowMs) return false;
  if (task.status === 'pending' || task.status === 'failed') return true;
  return task.status === 'running' && Boolean(task.lockedUntil) && Date.parse(task.lockedUntil) <= nowMs;
}

function normalizeLimit(value) {
  return Math.max(1, Math.min(Number(value) || 10, 50));
}

function unexpectedExecution() {
  return { ok: false, outcome: 'failed', value: null, unexpected: true };
}
