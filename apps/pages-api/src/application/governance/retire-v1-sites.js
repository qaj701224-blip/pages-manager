import {
  expectedV1WorkerName,
  isManagedV1WorkerName,
  isValidV1SiteScriptName,
  readV1Hostname,
  readV1SiteRecord,
  v1HostnameClaimMatches,
} from '../../domain/governance/v1-sites.js';

const BATCH_CONCURRENCY = 5;

export function createV1SiteRetirement({ inventory, workers, routes, claims, audits, clock }) {
  if (typeof inventory?.listSites !== 'function') throw new TypeError('inventory.listSites is required');
  if (typeof claims?.get !== 'function') throw new TypeError('claims.get is required');
  if (typeof claims?.release !== 'function') throw new TypeError('claims.release is required');
  if (typeof audits?.record !== 'function') throw new TypeError('audits.record is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { retire, retireBatch };

  async function retire(command) {
    let siteKeys;
    try {
      siteKeys = await inventory.listSites();
    } catch (cause) {
      await recordSafe(command, siteRef(command.name), 'metadata_read', 'deny', 502);
      return { ok: false, errorCode: 'V1_SITES_READ_FAILED', cause };
    }
    const record = findRecord(siteKeys, command.name);
    if (!record) {
      await recordSafe(command, siteRef(command.name), 'metadata_read', 'deny', 404);
      return { ok: false, errorCode: 'V1_SITE_NOT_FOUND' };
    }
    return { ok: true, result: await retireRecord(command, record) };
  }

  async function retireBatch(command) {
    let siteKeys;
    try {
      siteKeys = await inventory.listSites();
    } catch (cause) {
      await recordSafe(command, siteRef(null), 'metadata_read', 'deny', 502);
      return { ok: false, errorCode: 'V1_SITES_READ_FAILED', cause };
    }
    const records = new Map(
      (siteKeys || [])
        .map(readV1SiteRecord)
        .filter(Boolean)
        .map((record) => [record.name, record])
    );
    const results = await mapBatch(command.names, async (name) => {
      const record = records.get(name);
      if (!record) {
        await recordSafe(command, siteRef(name), 'metadata_read', 'deny', 404);
        return failed(name, 'metadata_read', 'V1_SITE_NOT_FOUND');
      }
      return retireRecord(command, record);
    });
    return {
      ok: true,
      summary: {
        requested: command.names.length,
        retired: results.filter((result) => result.status === 'retired').length,
        failed: results.filter((result) => result.status === 'failed').length,
      },
      results,
    };
  }

  async function retireRecord(command, record) {
    const resolved = await resolveScriptName(record, command.environment);
    if (!resolved.ok) {
      await recordSafe(command, siteRef(record.name), 'metadata_read', 'deny', resolved.statusCode);
      return failed(record.name, 'metadata_read', resolved.errorCode, { cause: resolved.cause });
    }

    const workerName = resolved.workerName;
    const expectedWorker = expectedV1WorkerName(record.name, command.environment);
    const earlySite = siteRef(record.name, expectedWorker);
    if (command.reservedWorkerNames.has(expectedWorker) || command.reservedWorkerNames.has(String(workerName).toLowerCase())) {
      await recordSafe(command, earlySite, 'platform_reserved', 'deny', 409);
      return failed(record.name, 'platform_reserved', 'V1_SITE_PLATFORM_RESERVED');
    }
    if (
      !isValidV1SiteScriptName(record.name, workerName, command.environment) ||
      !isManagedV1WorkerName(workerName, command.environment)
    ) {
      await recordSafe(command, earlySite, 'metadata_read', 'deny', 409);
      return failed(record.name, 'metadata_read', 'V1_SITE_SCRIPT_INVALID');
    }

    const hostname = readV1Hostname(record.url);
    if (!hostname) {
      await recordSafe(command, earlySite, 'route_unbind', 'deny', 409);
      return failed(record.name, 'route_unbind', 'V1_SITE_ROUTE_UNSAFE');
    }
    const site = siteRef(record.name, workerName, hostname);
    if (
      typeof workers?.delete !== 'function' ||
      typeof routes?.unbind !== 'function' ||
      typeof inventory.deleteSite !== 'function'
    ) {
      await recordSafe(command, site, 'capability_check', 'deny', 503);
      return failed(record.name, 'capability_check', 'V1_SITES_UNSUPPORTED');
    }

    let existingClaim;
    try {
      existingClaim = await claims.get(hostname);
    } catch {
      await recordSafe(command, site, 'hostname_claim_validation', 'deny', 502);
      return failed(record.name, 'hostname_claim_validation', 'V1_SITE_HOSTNAME_CLAIM_READ_FAILED');
    }
    if (
      existingClaim &&
      !v1HostnameClaimMatches(existingClaim, {
        environment: command.environment,
        siteName: record.name,
        workerName,
      })
    ) {
      await recordSafe(command, site, 'hostname_claim_validation', 'deny', 409);
      return failed(record.name, 'hostname_claim_validation', 'V1_SITE_HOSTNAME_CLAIM_UNSAFE');
    }

    try {
      await recordAudit(command, site, 'validation', 'allow', 200);
    } catch {
      return failed(record.name, 'audit', 'V1_SITE_AUDIT_FAILED');
    }

    try {
      await workers.delete({ workerName });
    } catch (cause) {
      await recordSafe(command, site, 'worker_delete', 'deny', 502);
      return failed(record.name, 'worker_delete', 'V1_SITE_WORKER_DELETE_FAILED', { cause });
    }
    await recordSafe(command, site, 'worker_delete', 'allow', 200);

    try {
      await routes.unbind({ hostname, expectedScriptName: workerName, environment: command.environment });
    } catch (cause) {
      await recordSafe(command, site, 'route_unbind', 'deny', 502);
      return failed(record.name, 'route_unbind', 'V1_SITE_ROUTE_UNBIND_FAILED', { cause });
    }
    await recordSafe(command, site, 'route_unbind', 'allow', 200);

    if (existingClaim && !['released', 'held'].includes(existingClaim.status)) {
      let released;
      try {
        released = await claims.release({
          environment: command.environment,
          hostname,
          normalizedSlug: record.name,
          hostnameFamily: 'workers',
          ownerSystem: 'v1',
          ownerId: `v1:${command.environment}:${record.name}`,
          ownerRef: workerName,
          source: 'v1_delete',
          status: 'active',
          releaseReason: 'site_retired',
          reuseHoldUntil: addSecondsIso(clock.now(), command.reuseHoldSeconds),
          releasedAt: clock.now(),
        });
      } catch {
        released = null;
      }
      if (!released?.ok) {
        await recordSafe(command, site, 'hostname_claim_release', 'deny', 502);
        return failed(record.name, 'hostname_claim_release', 'V1_SITE_HOSTNAME_CLAIM_RELEASE_FAILED');
      }
    }
    await recordSafe(command, site, 'hostname_claim_release', 'allow', 200);

    try {
      await inventory.deleteSite(record.name);
    } catch (cause) {
      await recordSafe(command, site, 'kv_delete', 'deny', 502);
      return failed(record.name, 'kv_delete', 'V1_SITE_KV_DELETE_FAILED', { cause });
    }
    await recordSafe(command, site, 'kv_delete', 'allow', 200);
    return { ...site, status: 'retired' };
  }

  async function resolveScriptName(record, environment) {
    if (record.scriptName) return { ok: true, workerName: record.scriptName };
    if (typeof inventory.getSiteRecord === 'function') {
      let value;
      try {
        value = await inventory.getSiteRecord(record.name);
      } catch (cause) {
        return { ok: false, errorCode: 'V1_SITE_METADATA_READ_FAILED', statusCode: 502, cause };
      }
      if (!value) return { ok: false, errorCode: 'V1_SITE_NOT_FOUND', statusCode: 404 };
      if (value.scriptName) return { ok: true, workerName: value.scriptName };
    }
    return { ok: true, workerName: expectedV1WorkerName(record.name, environment) };
  }

  function recordAudit(command, site, stage, decision, statusCode) {
    return audits.record({
      environment: command.environment,
      actorUserId: command.actorUserId,
      site,
      stage,
      decision,
      statusCode,
    });
  }

  async function recordSafe(command, site, stage, decision, statusCode) {
    try {
      await recordAudit(command, site, stage, decision, statusCode);
    } catch {
      // Stage audits after the required validation audit remain best-effort.
    }
  }
}

async function mapBatch(names, mapper) {
  const results = new Array(names.length);
  let nextIndex = 0;
  const consumers = Array.from({ length: Math.min(BATCH_CONCURRENCY, names.length) }, async () => {
    while (nextIndex < names.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(names[index]);
    }
  });
  await Promise.all(consumers);
  return results;
}

function findRecord(siteKeys, name) {
  const normalizedName = normalizeRequiredString(name);
  if (!normalizedName) return null;
  return (siteKeys || []).map(readV1SiteRecord).find((record) => record?.name === normalizedName) || null;
}

function siteRef(name, workerName = null, hostname = null) {
  return { name, workerName, hostname };
}

function failed(name, stage, errorCode, { cause } = {}) {
  return {
    name,
    status: 'failed',
    stage,
    errorCode,
    ...(cause ? { cause } : {}),
  };
}

function addSecondsIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
