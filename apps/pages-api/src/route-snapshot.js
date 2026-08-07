import { accessModeFromVisibility, normalizeExposure, visibilityFromAccessMode } from '@xd/pages-access-policy';

export function buildRouteSnapshot({ site, route, version, aclEntries = [] }) {
  const accessMode = accessModeFromVisibility(route.visibility);
  if (!accessMode) throw new Error('SITE_POLICY_INVALID');
  return {
    schemaVersion: 3,
    routeId: route.id,
    hostname: route.hostname,
    environment: route.environment,
    siteId: site.id,
    siteUuid: site.siteUuid,
    slug: site.slug,
    ownerUserId: site.ownerType === 'team' ? null : site.ownerUserId,
    requiredSessionVersion: site.requiredSessionVersion || 1,
    runtime: route.runtime,
    executionProvider: route.executionProvider || version?.executionProvider || executionProviderFromRuntime(route.runtime),
    workerName: route.workerName,
    dispatch: buildDispatchSnapshot(route, version),
    kv: {
      enabled: true,
      scopes: ['kv:get', 'kv:set', 'kv:delete', 'kv:list'],
    },
    activeVersionId: route.activeVersionId,
    contentHash: version?.contentHash || null,
    deploymentShape: version?.deploymentShape || (route.routeStatus === 'active' ? null : 'inactive'),
    resolvedFallback: version?.resolvedFallback || null,
    routingMode: version?.routingMode || null,
    exposure: normalizeExposure(route.exposure),
    accessMode,
    visibility: visibilityFromAccessMode(accessMode),
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    routeStatus: route.routeStatus,
    cacheTier: route.cacheTier,
    acl: aclEntries.map(formatAclEntry),
  };
}

function buildDispatchSnapshot(route, version) {
  const dispatchType = route.dispatchType || version?.dispatchType || dispatchTypeFromExecutionProvider(route.executionProvider);
  if (dispatchType === 'service-binding') {
    return {
      type: 'service-binding',
      slotId: route.slotId || version?.slotId || null,
      bindingName: route.dispatchBindingName || version?.dispatchBindingName,
    };
  }
  return { type: 'dispatch-namespace' };
}

function executionProviderFromRuntime(runtime) {
  return runtime === 'wfp' ? 'wfp' : null;
}

function dispatchTypeFromExecutionProvider(executionProvider) {
  return executionProvider === 'normal-worker-slot' ? 'service-binding' : 'dispatch-namespace';
}

function formatAclEntry(entry) {
  return {
    effect: entry.effect,
    subjectType: entry.subjectType,
    subjectValue: entry.subjectValue,
  };
}

export async function writeRouteSnapshot(target, snapshot) {
  if (target?.ROUTE_SNAPSHOTS) {
    if (target.ROUTE_POINTER_LOCKS) return writeRouteSnapshotThroughLock(target.ROUTE_POINTER_LOCKS, snapshot);
    return writeRouteSnapshotUnlocked(target.ROUTE_SNAPSHOTS, snapshot);
  }
  return writeRouteSnapshotUnlocked(target, snapshot);
}

export async function writeRouteSnapshotUnlocked(routeSnapshots, snapshot) {
  if (!routeSnapshots || typeof routeSnapshots.put !== 'function') throw new Error('Route snapshot store is required');

  assertSnapshotEnvironment(snapshot.environment);
  const snapshotKey = routeSnapshotKey(snapshot.environment, snapshot.hostname, snapshot.routeGeneration, snapshot.policyVersion);
  await assertRoutePointerIsNotStale(routeSnapshots, snapshot);
  const pointer = routePointer(snapshot, snapshotKey);
  await routeSnapshots.put(snapshotKey, JSON.stringify(snapshot));
  await routeSnapshots.put(routePointerKey(snapshot.environment, snapshot.hostname), JSON.stringify(pointer));
  return { snapshotKey, pointer };
}

export async function readRouteSnapshotState(target, snapshot) {
  const routeSnapshots = target?.ROUTE_SNAPSHOTS || target;
  if (!routeSnapshots || typeof routeSnapshots.get !== 'function') {
    throw new Error('Route snapshot store is required');
  }
  const pointerKey = routePointerKey(snapshot.environment, snapshot.hostname);
  const expectedKey = routeSnapshotKey(snapshot.environment, snapshot.hostname, snapshot.routeGeneration, snapshot.policyVersion);
  const rawPointer = await routeSnapshots.get(pointerKey);
  if (!rawPointer) return { state: 'missing', pointer: null, snapshot: null, snapshotKey: expectedKey };

  let pointer;
  try {
    pointer = parseSnapshotValue(rawPointer);
  } catch {
    return { state: 'invalid', pointer: null, snapshot: null, snapshotKey: expectedKey };
  }
  if (
    pointer?.environment !== snapshot.environment ||
    pointer?.hostname !== snapshot.hostname ||
    !Number.isInteger(pointer?.routeGeneration) ||
    !Number.isInteger(pointer?.policyVersion) ||
    typeof pointer?.snapshotKey !== 'string'
  ) {
    return { state: 'invalid', pointer, snapshot: null, snapshotKey: expectedKey };
  }
  if (
    pointer.routeGeneration > snapshot.routeGeneration ||
    (pointer.routeGeneration === snapshot.routeGeneration && pointer.policyVersion > snapshot.policyVersion)
  ) {
    return { state: 'ahead', pointer, snapshot: null, snapshotKey: expectedKey };
  }

  const rawSnapshot = await routeSnapshots.get(pointer.snapshotKey);
  let currentSnapshot = null;
  if (rawSnapshot) {
    try {
      currentSnapshot = parseSnapshotValue(rawSnapshot);
    } catch {
      return { state: 'invalid', pointer, snapshot: null, snapshotKey: expectedKey };
    }
  }
  const exactPointer =
    pointer.routeGeneration === snapshot.routeGeneration &&
    pointer.policyVersion === snapshot.policyVersion &&
    pointer.snapshotKey === expectedKey;
  const exactSnapshot = currentSnapshot && snapshotTupleMatches(currentSnapshot, snapshot);
  if (exactPointer && exactSnapshot) {
    return { state: 'exact', pointer, snapshot: currentSnapshot, snapshotKey: expectedKey };
  }
  return {
    state: pointer.routeGeneration < snapshot.routeGeneration || pointer.policyVersion < snapshot.policyVersion ? 'lower' : 'missing',
    pointer,
    snapshot: currentSnapshot,
    snapshotKey: expectedKey,
  };
}

export async function repairRouteSnapshot(target, snapshot) {
  const before = await readRouteSnapshotState(target, snapshot);
  if (before.state === 'invalid') throw new Error('ROUTE_POINTER_INVALID');
  if (before.state === 'ahead') return { ...before, repaired: false, pointerConfirmed: false };
  if (before.state === 'exact') return { ...before, repaired: false, pointerConfirmed: true };

  await writeRouteSnapshot(target, snapshot);
  const after = await readRouteSnapshotState(target, snapshot);
  return {
    ...after,
    repaired: true,
    pointerConfirmed: after.state === 'exact',
  };
}

async function writeRouteSnapshotThroughLock(routePointerLocks, snapshot) {
  const id = routePointerLocks.idFromName(`${snapshot.environment}:${snapshot.hostname}`);
  const stub = routePointerLocks.get(id);
  const response = await stub.fetch(
    new Request('https://route-pointer-do/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    })
  );
  if (!response.ok) throw new Error('ROUTE_POINTER_WRITE_FAILED');
  return response.json();
}

export class RoutePointerDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
    if (new URL(request.url).pathname !== '/write') return jsonResponse({ error: 'NOT_FOUND' }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'INVALID_JSON' }, 400);
    }

    try {
      const snapshot = body?.snapshot;
      assertSnapshotEnvironment(snapshot?.environment);
      const latestPointer = await this.state.storage.get('pointer');
      assertPointerIsNotStale(latestPointer, snapshot);
      const result = await writeRouteSnapshotUnlocked(this.env.ROUTE_SNAPSHOTS, snapshot);
      try {
        await this.state.storage.put('pointer', result.pointer);
      } catch {
        result.pointerState = 'durable_state_write_failed_after_kv_commit';
      }
      return jsonResponse(result, 200);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : 'ROUTE_POINTER_WRITE_FAILED' }, 409);
    }
  }
}

async function assertRoutePointerIsNotStale(routeSnapshots, snapshot) {
  if (typeof routeSnapshots.get !== 'function') return;

  const existingPointer = await readExistingPointer(routeSnapshots, snapshot);
  if (!existingPointer) return;

  assertPointerIsNotStale(existingPointer, snapshot);
}

function assertPointerIsNotStale(existingPointer, snapshot) {
  if (!existingPointer) return;
  if (
    existingPointer.routeGeneration > snapshot.routeGeneration ||
    (existingPointer.routeGeneration === snapshot.routeGeneration && existingPointer.policyVersion > snapshot.policyVersion)
  ) {
    throw new Error('ROUTE_POINTER_STALE');
  }
}

function routePointer(snapshot, snapshotKey) {
  return {
    hostname: snapshot.hostname,
    environment: snapshot.environment,
    routeGeneration: snapshot.routeGeneration,
    policyVersion: snapshot.policyVersion,
    snapshotKey,
  };
}

async function readExistingPointer(routeSnapshots, snapshot) {
  const rawPointer = await routeSnapshots.get(routePointerKeyFromSnapshot(snapshot));
  if (!rawPointer) return null;
  if (typeof rawPointer === 'object') return rawPointer;

  try {
    return JSON.parse(rawPointer);
  } catch {
    throw new Error('ROUTE_POINTER_INVALID');
  }
}

function routePointerKeyFromSnapshot(snapshot) {
  return routePointerKey(snapshot.environment, snapshot.hostname);
}

function parseSnapshotValue(value) {
  if (typeof value === 'object') return value;
  return JSON.parse(value);
}

function snapshotTupleMatches(actual, expected) {
  return (
    actual?.environment === expected.environment &&
    actual?.hostname === expected.hostname &&
    actual?.routeGeneration === expected.routeGeneration &&
    actual?.policyVersion === expected.policyVersion &&
    actual?.schemaVersion === expected.schemaVersion
  );
}

function assertSnapshotEnvironment(environment) {
  if (environment !== 'production' && environment !== 'staging') throw new Error('ROUTE_SNAPSHOT_ENV_INVALID');
}

export function routeSnapshotKey(environment, hostname, routeGeneration, policyVersion) {
  return `${environment}:route_snapshot:${hostname}:${routeGeneration}:${policyVersion}`;
}

export function routePointerKey(environment, hostname) {
  return `${environment}:route_pointer:${hostname}`;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
