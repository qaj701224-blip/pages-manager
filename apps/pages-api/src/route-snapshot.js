export function buildRouteSnapshot({ site, route, version, aclEntries = [] }) {
  return {
    schemaVersion: 1,
    routeId: route.id,
    hostname: route.hostname,
    environment: route.environment,
    siteId: site.id,
    siteUuid: site.siteUuid,
    slug: site.slug,
    ownerUserId: site.ownerUserId,
    requiredSessionVersion: site.requiredSessionVersion || 1,
    runtime: route.runtime,
    workerName: route.workerName,
    activeVersionId: route.activeVersionId,
    artifactKind: version.artifactKind,
    contentHash: version.contentHash,
    visibility: route.visibility,
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    routeStatus: route.routeStatus,
    cacheTier: route.cacheTier,
    acl: aclEntries.map(formatAclEntry),
  };
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
      await this.state.storage.put('pointer', result.pointer);
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
