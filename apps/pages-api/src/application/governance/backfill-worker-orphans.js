const ACTIVE_CLEANUP_STATUSES = new Set(['pending', 'failed', 'running']);

export function createWorkerOrphanBackfill({
  inventory,
  references,
  workers,
  cleanupTasks,
  audits,
  ids,
  clock,
}) {
  if (typeof inventory?.list !== 'function') throw new TypeError('inventory.list is required');
  if (typeof references?.list !== 'function') throw new TypeError('references.list is required');
  if (typeof workers?.isManaged !== 'function') throw new TypeError('workers.isManaged is required');
  if (typeof workers?.isResource !== 'function') throw new TypeError('workers.isResource is required');
  if (typeof cleanupTasks?.create !== 'function') throw new TypeError('cleanupTasks.create is required');
  if (typeof audits?.record !== 'function') throw new TypeError('audits.record is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { backfill };

  async function backfill(command) {
    let inventoryResult;
    let referenceResult;
    try {
      [inventoryResult, referenceResult] = await Promise.all([
        inventory.list({ maxWorkers: command.limit }),
        references.list({ environment: command.environment, limit: command.limit }),
      ]);
    } catch (error) {
      return { ok: false, reason: 'revalidation_failed', error };
    }
    if (Array.isArray(inventoryResult) || inventoryResult?.completeness !== 'complete') {
      return { ok: false, reason: 'scan_incomplete' };
    }

    const inventoryWorkers = Array.isArray(inventoryResult?.workers) ? inventoryResult.workers : [];
    if (
      inventoryWorkers.length > command.limit ||
      inventoryResult.scannedCount > command.limit ||
      inventoryResult.namespaceScriptCount > command.limit ||
      referenceResult?.scanLimitExceeded
    ) {
      return { ok: false, reason: 'limit_exceeded' };
    }

    const inventoryNames = new Set(inventoryWorkers.map((worker) => worker?.name).filter(Boolean));
    const activeRoutesByWorker = groupReferences(referenceResult?.activeRoutes, (item) => item.workerName);
    const versionsByWorker = groupReferences(referenceResult?.versions, (item) => item.workerName);
    const cleanupTasksByWorker = groupReferences(
      (referenceResult?.cleanupTasks || []).filter((item) => ACTIVE_CLEANUP_STATUSES.has(item.status)),
      (item) => item.resourceRef
    );
    const results = [];

    for (const workerName of command.workerNames) {
      const skipReason = resolveSkipReason({
        workerName,
        environment: command.environment,
        inventoryNames,
        activeRoutes: activeRoutesByWorker.get(workerName) || [],
        versions: versionsByWorker.get(workerName) || [],
        cleanupTasks: cleanupTasksByWorker.get(workerName) || [],
        workers,
      });
      if (skipReason) {
        const result = { workerName, status: 'skipped', reason: skipReason };
        results.push(result);
        await recordResultAudit(audits, result, {
          decision: 'skip',
          statusCode: 409,
        });
        continue;
      }

      const versionsForWorker = versionsByWorker.get(workerName) || [];
      const latestVersion = latestWorkerVersion(versionsForWorker);
      const rollbackEligible = versionsForWorker.some(
        (version) => !version.siteDeletedAt && version.artifactAvailability === 'active'
      );
      const cleanupReason =
        versionsForWorker.length > 0 && versionsForWorker.every((version) => Boolean(version.siteDeletedAt))
          ? 'site_deleted_backfill'
          : 'orphan_backfill';
      try {
        await cleanupTasks.create({
          id: ids.next('cln'),
          environment: command.environment,
          resourceType: 'wfp_user_worker',
          resourceRef: workerName,
          siteId: latestVersion?.siteId || null,
          versionId: latestVersion?.id || null,
          deploymentId: null,
          cleanupReason,
          status: 'pending',
          cleanupAfter: clock.now(),
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        const result = { workerName, status: 'created', rollbackEligible };
        results.push(result);
        await recordResultAudit(audits, result, {
          decision: 'allow',
          statusCode: 201,
          cleanupReason,
        });
      } catch {
        const result = { workerName, status: 'skipped', reason: 'cleanup_task_create_failed' };
        results.push(result);
        await recordResultAudit(audits, result, {
          decision: 'deny',
          statusCode: 502,
        });
      }
    }

    return {
      ok: true,
      summary: {
        requested: command.workerNames.length,
        created: results.filter((item) => item.status === 'created').length,
        skipped: results.filter((item) => item.status === 'skipped').length,
      },
      results,
    };
  }
}

function resolveSkipReason({ workerName, environment, inventoryNames, activeRoutes, versions, cleanupTasks, workers }) {
  if (!workers.isManaged(workerName, environment)) return 'worker_not_managed';
  if (!inventoryNames.has(workerName)) return 'worker_not_in_complete_inventory';
  if ([...activeRoutes, ...versions].some((record) => !workers.isResource(record, environment))) {
    return 'worker_not_wfp_resource';
  }
  if (activeRoutes.length > 0) return 'active_route_reference';
  if (cleanupTasks.length > 0) return 'cleanup_task_exists';
  return null;
}

function groupReferences(items, keyOf) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyOf(item);
    if (typeof key !== 'string' || key === '') continue;
    const values = grouped.get(key) || [];
    values.push(item);
    grouped.set(key, values);
  }
  return grouped;
}

function latestWorkerVersion(versions) {
  return (
    [...versions].sort(
      (left, right) =>
        String(right.createdAt || '').localeCompare(String(left.createdAt || '')) ||
        String(right.id || '').localeCompare(String(left.id || ''))
    )[0] || null
  );
}

function recordResultAudit(audits, result, { decision, statusCode, cleanupReason }) {
  return audits.record({
    eventType: 'admin.worker_orphan_backfill',
    stage: 'backfill',
    decision,
    statusCode,
    metadata: {
      workerName: result.workerName,
      result: result.status,
      ...(cleanupReason ? { cleanupReason } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    },
  });
}
