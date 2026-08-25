import { accessModeFromVisibility, normalizeExposure, visibilityFromAccessMode } from '@xd/pages-access-policy';

const DEPLOYMENT_FAILURE_RECOVERY_STORAGE_PREFIX = 'deployment_failure_recovery:';
const DEPLOYMENT_FAILURE_RECOVERY_VALUE_MAX_BYTES = 32 * 1024;

export function buildRouteSnapshot({ site, route, version, aclEntries = [] }) {
  const accessMode = accessModeFromVisibility(route.visibility);
  if (!accessMode) throw new Error('SITE_POLICY_INVALID');
  return {
    schemaVersion: 4,
    kind: 'serve',
    routeId: route.id,
    hostname: route.hostname,
    environment: route.environment,
    siteId: site.id,
    siteUuid: site.siteUuid,
    slug: site.slug,
    dataNamespace: site.dataNamespace || site.slug,
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

export async function clearRoutePointerIfCurrent(target, expectedPointer) {
  const routeSnapshots = target?.ROUTE_SNAPSHOTS || target;
  if (!routeSnapshots || typeof routeSnapshots.get !== 'function') return false;
  assertRoutePointerShape(expectedPointer);
  const pointerKey = routePointerKey(expectedPointer?.environment, expectedPointer?.hostname);
  if (target?.ROUTE_SNAPSHOTS && target.ROUTE_POINTER_LOCKS) {
    const id = target.ROUTE_POINTER_LOCKS.idFromName(`${expectedPointer.environment}:${expectedPointer.hostname}`);
    const stub = target.ROUTE_POINTER_LOCKS.get(id);
    const response = await stub.fetch(
      new Request('https://route-pointer-do/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointer: expectedPointer }),
      })
    );
    if (response.status === 409) return false;
    if (!response.ok) throw new Error('ROUTE_POINTER_CLEAR_FAILED');
    const result = await response.json();
    return result?.cleared === true;
  }

  const rawPointer = await routeSnapshots.get(pointerKey);
  if (!rawPointer) return hasExpectedPointerIdentity(expectedPointer);
  let pointer;
  try {
    pointer = parseSnapshotValue(rawPointer);
  } catch {
    return false;
  }
  if (
    hasExpectedPointerIdentity(expectedPointer) &&
    !(await pointedSnapshotMatchesIdentity(routeSnapshots, pointer, expectedPointer))
  ) {
    return false;
  }
  if (!routePointerCanBeCleared(pointer, expectedPointer)) {
    if (hasExpectedPointerIdentity(expectedPointer)) return false;
    const publicAhead = await pointedSnapshotIsPublic(routeSnapshots, pointer);
    if (!publicAhead) return false;
  }
  if (typeof routeSnapshots.delete !== 'function') return false;
  await routeSnapshots.delete(pointerKey);
  return !(await routeSnapshots.get(pointerKey));
}

export async function writeDeploymentFailureRecoveryRecord(target, input) {
  const stub = deploymentFailureRecoveryStub(target, input);
  if (!stub) return false;
  const response = await stub.fetch(
    new Request('https://route-pointer-do/deployment-failure-recovery/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deploymentId: input.deploymentId, value: input.value }),
    })
  );
  if (!response.ok) throw new Error('DEPLOYMENT_FAILURE_RECOVERY_WRITE_FAILED');
  return true;
}

export async function listDeploymentFailureRecoveryRecords(target, input) {
  const stub = deploymentFailureRecoveryStub(target, input);
  if (!stub) return [];
  const response = await stub.fetch(
    new Request('https://route-pointer-do/deployment-failure-recovery/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  );
  if (!response.ok) throw new Error('DEPLOYMENT_FAILURE_RECOVERY_LIST_FAILED');
  const payload = await response.json();
  return Array.isArray(payload?.records) ? payload.records : [];
}

export async function deleteDeploymentFailureRecoveryRecord(target, input) {
  const stub = deploymentFailureRecoveryStub(target, input);
  if (!stub) return false;
  const response = await stub.fetch(
    new Request('https://route-pointer-do/deployment-failure-recovery/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deploymentId: input.deploymentId }),
    })
  );
  if (!response.ok) throw new Error('DEPLOYMENT_FAILURE_RECOVERY_DELETE_FAILED');
  return true;
}

export async function writeRouteSnapshotUnlocked(routeSnapshots, snapshot) {
  if (!routeSnapshots || typeof routeSnapshots.put !== 'function') throw new Error('Route snapshot store is required');

  assertSnapshotEnvironment(snapshot.environment);
  const snapshotKey = routeSnapshotKeyForSnapshot(snapshot);
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
  const expectedKey = routeSnapshotKeyForSnapshot(snapshot);
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
    state:
      pointer.routeGeneration < snapshot.routeGeneration || pointer.policyVersion < snapshot.policyVersion ? 'lower' : 'missing',
    pointer,
    snapshot: currentSnapshot,
    snapshotKey: expectedKey,
  };
}

export async function repairRouteSnapshot(target, snapshot) {
  const before = await readRouteSnapshotState(target, snapshot);
  if (before.state === 'invalid') throw new Error('ROUTE_POINTER_INVALID');
  const routeSnapshots = target?.ROUTE_SNAPSHOTS || target;
  if (before.state === 'ahead' && !(await deletedRouteAllowsOwnerReplacement(routeSnapshots, before.pointer, snapshot))) {
    return { ...before, repaired: false, pointerConfirmed: false };
  }
  const requiresDurableConfirmation = Boolean(target?.ROUTE_POINTER_LOCKS);
  if (before.state === 'exact' && !requiresDurableConfirmation) {
    return { ...before, repaired: false, pointerConfirmed: true };
  }

  const writeResult = await writeRouteSnapshot(target, snapshot);
  const after = await readRouteSnapshotState(target, snapshot);
  return {
    ...after,
    repaired: before.state !== 'exact',
    pointerConfirmed: after.state === 'exact' && (!requiresDurableConfirmation || writeResult?.durableStateConfirmed === true),
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
    this.pointerOperations = Promise.resolve();
  }

  async fetch(request) {
    if (request.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const pathname = new URL(request.url).pathname;
    const deploymentRecoveryOperation = deploymentFailureRecoveryOperation(pathname);
    if (pathname !== '/write' && pathname !== '/clear' && !deploymentRecoveryOperation) {
      return jsonResponse({ error: 'NOT_FOUND' }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'INVALID_JSON' }, 400);
    }

    const handle = async () => {
      try {
        if (deploymentRecoveryOperation) {
          const response = await handleDeploymentFailureRecoveryRequest(this.state.storage, deploymentRecoveryOperation, body);
          return response;
        }
        if (pathname === '/clear') {
          const expectedPointer = body?.pointer;
          assertRoutePointerShape(expectedPointer);
          const pointerKey = routePointerKey(expectedPointer?.environment, expectedPointer?.hostname);
          const latestPointer = await this.state.storage.get('pointer');
          if (!(await durablePointerCanBeCleared(this.env.ROUTE_SNAPSHOTS, latestPointer, expectedPointer))) {
            return jsonResponse({ cleared: false, reason: 'POINTER_STATE_CHANGED' }, 409);
          }
          const rawPointer = await this.env.ROUTE_SNAPSHOTS.get(pointerKey);
          if (rawPointer) {
            let currentPointer;
            try {
              currentPointer = parseSnapshotValue(rawPointer);
            } catch {
              return jsonResponse({ cleared: false, reason: 'POINTER_INVALID' }, 409);
            }
            if (
              hasExpectedPointerIdentity(expectedPointer) &&
              !(await pointedSnapshotMatchesIdentity(this.env.ROUTE_SNAPSHOTS, currentPointer, expectedPointer))
            ) {
              return jsonResponse({ cleared: false, reason: 'POINTER_OWNER_CHANGED' }, 409);
            }
            if (!routePointerCanBeCleared(currentPointer, expectedPointer)) {
              if (hasExpectedPointerIdentity(expectedPointer)) {
                return jsonResponse({ cleared: false, reason: 'POINTER_CHANGED' }, 409);
              }
              const publicAhead = await pointedSnapshotIsPublic(this.env.ROUTE_SNAPSHOTS, currentPointer);
              if (!publicAhead) {
                return jsonResponse({ cleared: false, reason: 'POINTER_CHANGED' }, 409);
              }
            }
          }
          if (typeof this.env.ROUTE_SNAPSHOTS.delete !== 'function') {
            return jsonResponse({ error: 'ROUTE_POINTER_CLEAR_FAILED' }, 503);
          }
          await this.state.storage.put('pointer', clearedPointerTombstone(expectedPointer));
          await this.env.ROUTE_SNAPSHOTS.delete(pointerKey);
          if (await this.env.ROUTE_SNAPSHOTS.get(pointerKey)) {
            return jsonResponse({ cleared: false, reason: 'POINTER_DELETE_NOT_CONFIRMED' }, 409);
          }
          return jsonResponse({ cleared: true }, 200);
        }
        const snapshot = body?.snapshot;
        assertSnapshotEnvironment(snapshot?.environment);
        const latestPointer = await this.state.storage.get('pointer');
        await assertPointerWriteAllowed(this.env.ROUTE_SNAPSHOTS, latestPointer, snapshot);
        const pointerState = pointerStateForSnapshot(routePointer(snapshot, routeSnapshotKeyForSnapshot(snapshot)), snapshot);
        const ownerFenceRequired = await pointerOwnerFenceRequired(this.env.ROUTE_SNAPSHOTS, latestPointer, snapshot);
        if (ownerFenceRequired) await this.state.storage.put('pointer', pointerState);
        const result = await writeRouteSnapshotUnlocked(this.env.ROUTE_SNAPSHOTS, snapshot);
        if (ownerFenceRequired) {
          result.durableStateConfirmed = true;
        } else {
          try {
            await this.state.storage.put('pointer', pointerStateForSnapshot(result.pointer, snapshot));
            result.durableStateConfirmed = true;
          } catch {
            result.durableStateConfirmed = false;
            result.pointerState = 'durable_state_write_failed_after_kv_commit';
          }
        }
        return jsonResponse(result, 200);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : 'ROUTE_POINTER_WRITE_FAILED' }, 409);
      }
    };
    if (deploymentRecoveryOperation) return handle();
    const result = this.pointerOperations.then(handle, handle);
    this.pointerOperations = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function deploymentFailureRecoveryStub(target, input) {
  if (!target?.ROUTE_POINTER_LOCKS) return null;
  assertSnapshotEnvironment(input?.environment);
  if (typeof input?.hostname !== 'string' || !input.hostname) {
    throw new Error('DEPLOYMENT_FAILURE_RECOVERY_SCOPE_INVALID');
  }
  const id = target.ROUTE_POINTER_LOCKS.idFromName(`${input.environment}:${input.hostname}`);
  return target.ROUTE_POINTER_LOCKS.get(id);
}

function deploymentFailureRecoveryOperation(pathname) {
  const prefix = '/deployment-failure-recovery/';
  if (!pathname.startsWith(prefix)) return null;
  const operation = pathname.slice(prefix.length);
  return operation === 'write' || operation === 'list' || operation === 'delete' ? operation : null;
}

async function handleDeploymentFailureRecoveryRequest(storage, operation, body) {
  if (operation === 'list') {
    const records = await storage.list({ prefix: DEPLOYMENT_FAILURE_RECOVERY_STORAGE_PREFIX });
    return jsonResponse(
      {
        records: [...records.entries()].map(([key, value]) => ({
          deploymentId: key.slice(DEPLOYMENT_FAILURE_RECOVERY_STORAGE_PREFIX.length),
          value,
        })),
      },
      200
    );
  }

  const storageKey = deploymentFailureRecoveryStorageKey(body?.deploymentId);
  if (operation === 'delete') {
    await storage.delete(storageKey);
    return jsonResponse({ deleted: true }, 200);
  }

  if (
    typeof body?.value !== 'string' ||
    new globalThis.TextEncoder().encode(body.value).byteLength > DEPLOYMENT_FAILURE_RECOVERY_VALUE_MAX_BYTES
  ) {
    throw new Error('DEPLOYMENT_FAILURE_RECOVERY_VALUE_INVALID');
  }
  await storage.put(storageKey, body.value);
  return jsonResponse({ stored: true }, 200);
}

function deploymentFailureRecoveryStorageKey(deploymentId) {
  if (typeof deploymentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deploymentId)) {
    throw new Error('DEPLOYMENT_FAILURE_RECOVERY_ID_INVALID');
  }
  return `${DEPLOYMENT_FAILURE_RECOVERY_STORAGE_PREFIX}${deploymentId}`;
}

async function pointedSnapshotIsPublic(routeSnapshots, pointer) {
  return (await readPointedSnapshot(routeSnapshots, pointer))?.exposure === 'public';
}

async function pointedSnapshotMatchesIdentity(routeSnapshots, pointer, expected) {
  const snapshot = await readPointedSnapshot(routeSnapshots, pointer);
  return (
    pointedSnapshotMatchesPointer(snapshot, pointer) &&
    snapshot.siteId === expected.siteId &&
    snapshot.routeId === expected.routeId
  );
}

async function durablePointerCanBeCleared(routeSnapshots, actual, expected) {
  if (!actual) return true;
  if (actual.cleared === true) {
    if (actual.environment === undefined && actual.hostname === undefined) return true;
    if (!routePointerCanBeCleared(actual, expected)) return false;
    return !hasExpectedPointerIdentity(actual) || !hasExpectedPointerIdentity(expected) || routeIdentityMatches(actual, expected);
  }
  if (hasExpectedPointerIdentity(expected)) {
    if (!(await pointedSnapshotMatchesIdentity(routeSnapshots, actual, expected))) return false;
    return routePointerCanBeCleared(actual, expected);
  }
  if (routePointerCanBeCleared(actual, expected)) return true;
  return pointedSnapshotIsPublic(routeSnapshots, actual);
}

async function assertRoutePointerIsNotStale(routeSnapshots, snapshot) {
  if (typeof routeSnapshots.get !== 'function') return;

  const existingPointer = await readExistingPointer(routeSnapshots, snapshot);
  if (!existingPointer) return;

  const ownerReplacementAllowed = await deletedRouteAllowsOwnerReplacement(routeSnapshots, existingPointer, snapshot);
  if (ownerReplacementAllowed) return;

  assertPointerIsNotStale(existingPointer, snapshot);
  await assertKvPointerOwnerMatches(routeSnapshots, existingPointer, snapshot);
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

async function assertPointerWriteAllowed(routeSnapshots, existingPointer, snapshot) {
  const ownerReplacementAllowed = await deletedRouteAllowsOwnerReplacement(routeSnapshots, existingPointer, snapshot);
  const currentPointer = await readExistingPointer(routeSnapshots, snapshot);
  if (!ownerReplacementAllowed && currentPointer) {
    assertPointerIsNotStale(currentPointer, snapshot);
    await assertKvPointerOwnerMatches(routeSnapshots, currentPointer, snapshot);
  }
  if (!existingPointer) return;
  if (existingPointer.cleared === true) {
    if (routeIdentityMatches(existingPointer, snapshot) && !routeTupleIsAhead(snapshot, existingPointer)) {
      throw new Error('ROUTE_POINTER_STALE');
    }
    return;
  }
  const persistedState = await readRouteSnapshotState(routeSnapshots, snapshot);
  if (persistedState.state === 'exact') {
    if (
      hasExpectedPointerIdentity(existingPointer) &&
      hasExpectedPointerIdentity(snapshot) &&
      !routeIdentityMatches(existingPointer, snapshot) &&
      !(await pointerStateRepresentsDeletedRoute(routeSnapshots, existingPointer))
    ) {
      throw new Error('ROUTE_POINTER_OWNER_CHANGED');
    }
    return;
  }
  if (ownerReplacementAllowed) return;
  if (hasExpectedPointerIdentity(existingPointer) && hasExpectedPointerIdentity(snapshot)) {
    if (!routeIdentityMatches(existingPointer, snapshot)) {
      throw new Error('ROUTE_POINTER_OWNER_CHANGED');
    }
  }
  assertPointerIsNotStale(existingPointer, snapshot);
}

async function deletedRouteAllowsOwnerReplacement(routeSnapshots, existingPointer, candidate) {
  if (!hasExpectedPointerIdentity(candidate)) return false;
  const currentPointer = await readExistingPointer(routeSnapshots, candidate);
  if (!currentPointer?.snapshotKey) return false;

  const currentSnapshot = await readPointedSnapshot(routeSnapshots, currentPointer);

  if (
    !pointedSnapshotMatchesPointer(currentSnapshot, currentPointer) ||
    currentSnapshot.environment !== candidate.environment ||
    currentSnapshot.hostname !== candidate.hostname ||
    currentSnapshot?.routeStatus !== 'deleted' ||
    currentSnapshot?.runtime !== 'disabled' ||
    !hasExpectedPointerIdentity(currentSnapshot) ||
    routeIdentityMatches(currentSnapshot, candidate)
  ) {
    return false;
  }
  if (!hasExpectedPointerIdentity(existingPointer) || routeIdentityMatches(existingPointer, currentSnapshot)) {
    return true;
  }
  return routeIdentityMatches(existingPointer, candidate) && !routeTupleIsAhead(existingPointer, candidate);
}

async function assertKvPointerOwnerMatches(routeSnapshots, pointer, candidate) {
  if (!hasExpectedPointerIdentity(candidate)) return;
  const currentSnapshot = await readPointedSnapshot(routeSnapshots, pointer);
  if (!pointedSnapshotMatchesPointer(currentSnapshot, pointer) || !hasExpectedPointerIdentity(currentSnapshot)) {
    throw new Error('ROUTE_POINTER_OWNER_UNCONFIRMED');
  }
  if (!routeIdentityMatches(currentSnapshot, candidate)) {
    throw new Error('ROUTE_POINTER_OWNER_CHANGED');
  }
}

async function pointerOwnerFenceRequired(routeSnapshots, existingPointer, candidate) {
  if (!hasExpectedPointerIdentity(candidate)) return false;
  if (existingPointer?.cleared === true) return true;
  if (hasExpectedPointerIdentity(existingPointer)) {
    return !routeIdentityMatches(existingPointer, candidate);
  }
  const currentPointer = await readExistingPointer(routeSnapshots, candidate);
  if (!currentPointer) return false;
  const currentSnapshot = await readPointedSnapshot(routeSnapshots, currentPointer);
  return hasExpectedPointerIdentity(currentSnapshot) && !routeIdentityMatches(currentSnapshot, candidate);
}

async function pointerStateRepresentsDeletedRoute(routeSnapshots, pointer) {
  const snapshot = await readPointedSnapshot(routeSnapshots, pointer);
  return (
    pointedSnapshotMatchesPointer(snapshot, pointer) &&
    hasExpectedPointerIdentity(snapshot) &&
    routeIdentityMatches(snapshot, pointer) &&
    snapshot.routeStatus === 'deleted' &&
    snapshot.runtime === 'disabled'
  );
}

async function readPointedSnapshot(routeSnapshots, pointer) {
  if (!pointer?.snapshotKey || typeof routeSnapshots?.get !== 'function') return null;
  const rawSnapshot = await routeSnapshots.get(pointer.snapshotKey);
  if (!rawSnapshot) return null;
  try {
    return parseSnapshotValue(rawSnapshot);
  } catch {
    return null;
  }
}

function pointedSnapshotMatchesPointer(snapshot, pointer) {
  return (
    snapshot?.environment === pointer?.environment &&
    snapshot?.hostname === pointer?.hostname &&
    snapshot?.routeGeneration === pointer?.routeGeneration &&
    snapshot?.policyVersion === pointer?.policyVersion
  );
}

function routeTupleIsAhead(candidate, current) {
  return (
    candidate.routeGeneration > current.routeGeneration ||
    (candidate.routeGeneration === current.routeGeneration && candidate.policyVersion > current.policyVersion)
  );
}

function routeIdentityMatches(left, right) {
  return left.siteId === right.siteId && left.routeId === right.routeId;
}

function pointerStateForSnapshot(pointer, snapshot) {
  return {
    ...pointer,
    ...(hasExpectedPointerIdentity(snapshot) ? { siteId: snapshot.siteId, routeId: snapshot.routeId } : {}),
  };
}

function clearedPointerTombstone(pointer) {
  return {
    cleared: true,
    hostname: pointer.hostname,
    environment: pointer.environment,
    routeGeneration: pointer.routeGeneration,
    policyVersion: pointer.policyVersion,
    ...(hasExpectedPointerIdentity(pointer) ? { siteId: pointer.siteId, routeId: pointer.routeId } : {}),
  };
}

function routePointerCanBeCleared(actual, expected) {
  return (
    actual?.environment === expected?.environment &&
    actual?.hostname === expected?.hostname &&
    Number.isInteger(actual?.routeGeneration) &&
    Number.isInteger(actual?.policyVersion) &&
    Number.isInteger(expected?.routeGeneration) &&
    Number.isInteger(expected?.policyVersion) &&
    (actual.routeGeneration < expected.routeGeneration ||
      (actual.routeGeneration === expected.routeGeneration && actual.policyVersion <= expected.policyVersion))
  );
}

function assertRoutePointerShape(pointer) {
  assertSnapshotEnvironment(pointer?.environment);
  const identityProvided = pointer?.siteId !== undefined || pointer?.routeId !== undefined;
  if (
    typeof pointer?.hostname !== 'string' ||
    pointer.hostname.length === 0 ||
    !Number.isInteger(pointer.routeGeneration) ||
    !Number.isInteger(pointer.policyVersion) ||
    typeof pointer.snapshotKey !== 'string' ||
    pointer.snapshotKey.length === 0 ||
    (identityProvided &&
      (typeof pointer.siteId !== 'string' ||
        pointer.siteId.length === 0 ||
        typeof pointer.routeId !== 'string' ||
        !pointer.routeId))
  ) {
    throw new Error('ROUTE_POINTER_INVALID');
  }
}

function hasExpectedPointerIdentity(pointer) {
  return (
    typeof pointer?.siteId === 'string' &&
    pointer.siteId.length > 0 &&
    typeof pointer?.routeId === 'string' &&
    pointer.routeId.length > 0
  );
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
  return stableJson(actual) === stableJson(expected);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSnapshotEnvironment(environment) {
  if (environment !== 'production' && environment !== 'staging') throw new Error('ROUTE_SNAPSHOT_ENV_INVALID');
}

export function routeSnapshotKey(environment, hostname, routeGeneration, policyVersion, siteId = null) {
  const identity = typeof siteId === 'string' && siteId ? `:${siteId}` : '';
  return `${environment}:route_snapshot:${hostname}${identity}:${routeGeneration}:${policyVersion}`;
}

function routeSnapshotKeyForSnapshot(snapshot) {
  return routeSnapshotKey(
    snapshot.environment,
    snapshot.hostname,
    snapshot.routeGeneration,
    snapshot.policyVersion,
    snapshot.schemaVersion === 4 ? snapshot.siteId : null
  );
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
