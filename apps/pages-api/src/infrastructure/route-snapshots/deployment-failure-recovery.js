const RECOVERY_KEY_PART = 'deployment_failure_recovery';

export function createDeploymentFailureRecoveryMarkers({ markers, environment, durableRecords, clock }) {
  if (typeof durableRecords?.write !== 'function') throw new TypeError('durableRecords.write is required');
  if (typeof durableRecords?.list !== 'function') throw new TypeError('durableRecords.list is required');
  if (typeof durableRecords?.delete !== 'function') throw new TypeError('durableRecords.delete is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { persist, list };

  async function persist(input) {
    if (!input.siteId || !input.deploymentId) return false;
    const marker = {
      schemaVersion: 1,
      environment,
      siteId: input.siteId,
      deploymentId: input.deploymentId,
      operation: input.operation === 'rollback' ? 'rollback' : 'deploy',
      failedPatch: recoveryMarkerFailedPatch(input.failedPatch, clock.now),
      createdAt: clock.now(),
    };
    const value = JSON.stringify(marker);
    if (typeof markers?.put === 'function') {
      try {
        await markers.put(recoveryKey(environment, input.siteId, input.deploymentId), value);
        return true;
      } catch {
        // Durable RoutePointer state is the independent fallback when KV is unavailable.
      }
    }
    try {
      return await durableRecords.write({
        hostname: input.siteHostname,
        deploymentId: input.deploymentId,
        value,
      });
    } catch {
      return false;
    }
  }

  async function list(site) {
    const records = [];
    let readError = null;
    if (typeof markers?.list === 'function' && typeof markers?.get === 'function') {
      let markerKeys;
      try {
        markerKeys = await listRecoveryKeys(markers, environment, site.id);
      } catch (cause) {
        readError = recoveryReadError('Deployment recovery markers could not be listed.', cause);
        markerKeys = [];
      }
      for (const key of markerKeys) {
        let value;
        try {
          value = await markers.get(key);
        } catch (cause) {
          readError ||= recoveryReadError('Deployment recovery marker could not be read.', cause);
          continue;
        }
        records.push({
          marker: parseRecoveryMarkerBestEffort(value, environment, site.id),
          delete: () => deleteKvMarkerBestEffort(markers, key),
        });
      }
    }

    let durable;
    const hostname = site.route?.hostname || site.hostname;
    try {
      durable = await durableRecords.list({ hostname });
    } catch (cause) {
      readError ||= recoveryReadError('Durable deployment recovery markers could not be listed.', cause);
      durable = [];
    }
    for (const record of durable) {
      records.push({
        marker: parseRecoveryMarkerBestEffort(record?.value, environment, site.id),
        delete: () => deleteDurableMarkerBestEffort(durableRecords, {
          hostname,
          deploymentId: record?.deploymentId,
        }),
      });
    }
    return { records, readError };
  }
}

async function listRecoveryKeys(markers, environment, siteId) {
  const prefix = recoveryPrefix(environment, siteId);
  const keys = [];
  let cursor;
  let hasNextPage = true;
  while (hasNextPage) {
    const page = await markers.list(withoutUndefined({ prefix, cursor }));
    for (const item of page?.keys || []) {
      if (typeof item?.name === 'string' && item.name.startsWith(prefix)) keys.push(item.name);
    }
    hasNextPage = page?.list_complete === false && Boolean(page.cursor);
    cursor = hasNextPage ? page.cursor : undefined;
  }
  return keys;
}

function recoveryPrefix(environment, siteId) {
  return `${environment}:${RECOVERY_KEY_PART}:${siteId}:`;
}

function recoveryKey(environment, siteId, deploymentId) {
  return `${recoveryPrefix(environment, siteId)}${deploymentId}`;
}

function parseRecoveryMarkerBestEffort(raw, environment, siteId) {
  try {
    return parseRecoveryMarker(raw, environment, siteId);
  } catch {
    return null;
  }
}

function parseRecoveryMarker(raw, environment, siteId) {
  if (typeof raw !== 'string' || raw.length > 32 * 1024) return null;
  const marker = JSON.parse(raw);
  if (
    !marker ||
    marker.schemaVersion !== 1 ||
    marker.environment !== environment ||
    marker.siteId !== siteId ||
    !safeId(marker.deploymentId)
  ) {
    return null;
  }
  return {
    deploymentId: marker.deploymentId,
    operation: marker.operation === 'rollback' ? 'rollback' : 'deploy',
    failedPatch: recoveryMarkerFailedPatch(marker.failedPatch, () => new Date().toISOString()),
  };
}

function recoveryMarkerFailedPatch(patch, now) {
  return withoutUndefined({
    versionId: safeId(patch?.versionId),
    previousVersionId: safeId(patch?.previousVersionId),
    errorCode: safeErrorCode(patch?.errorCode) || 'DEPLOYMENT_STATE_WRITE_FAILED',
    errorMessage: safeMessage(patch?.errorMessage) || 'Deployment failure state required recovery.',
    failureStage: safeIdentifier(patch?.failureStage) || 'persist_deployment_state',
    failureDiagnostics: safeDiagnostics(patch?.failureDiagnostics),
    completedAt: safeTimestamp(patch?.completedAt) || now(),
  });
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

function safeErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : undefined;
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : undefined;
}

function safeMessage(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return undefined;
  return /(?:authorization|bearer|cookie|password|secret|token|https?:\/\/)/i.test(value) ? undefined : value;
}

function safeDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 24 * 1024 ? JSON.parse(serialized) : undefined;
  } catch {
    return undefined;
  }
}

function safeTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function recoveryReadError(message, cause) {
  const error = new Error(message, { cause });
  error.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
  return error;
}

async function deleteKvMarkerBestEffort(markers, key) {
  if (typeof markers?.delete !== 'function') return;
  try {
    await markers.delete(key);
  } catch {
    // A retained marker is safe; the next request retries after observing terminal state.
  }
}

async function deleteDurableMarkerBestEffort(durableRecords, input) {
  try {
    await durableRecords.delete(input);
  } catch {
    // A retained marker is safe; the next request retries after observing terminal state.
  }
}

function withoutUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
