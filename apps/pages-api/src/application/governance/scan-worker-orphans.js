export function createWorkerOrphanScan({ inventory, references, projection, clock }) {
  if (typeof inventory?.list !== 'function') throw new TypeError('inventory.list is required');
  if (typeof references?.list !== 'function') throw new TypeError('references.list is required');
  if (typeof projection?.build !== 'function') throw new TypeError('projection.build is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { scan };

  async function scan(query) {
    let inventoryResult;
    let referenceResult;
    try {
      [inventoryResult, referenceResult] = await Promise.all([
        inventory.list({ maxWorkers: query.limit }),
        references.list({ environment: query.environment, limit: query.limit }),
      ]);
    } catch (error) {
      return { ok: false, reason: 'scan_failed', error };
    }

    const workers = Array.isArray(inventoryResult) ? inventoryResult : inventoryResult?.workers;
    const completeness = Array.isArray(inventoryResult) ? null : inventoryResult?.completeness;
    const scannedCount = Array.isArray(inventoryResult) ? null : inventoryResult?.scannedCount;
    const namespaceScriptCount = Array.isArray(inventoryResult) ? null : inventoryResult?.namespaceScriptCount;
    const observedCount = Math.max(
      Array.isArray(workers) ? workers.length : 0,
      Number.isInteger(scannedCount) ? scannedCount : 0,
      Number.isInteger(namespaceScriptCount) ? namespaceScriptCount : 0
    );
    if (observedCount > query.limit || referenceResult?.scanLimitExceeded) {
      return { ok: false, reason: 'limit_exceeded' };
    }

    return {
      ok: true,
      scan: projection.build({
        workers,
        references: referenceResult,
        environment: query.environment,
        scannedAt: clock.now(),
        completeness,
        scannedCount,
        namespaceScriptCount,
      }),
    };
  }
}
