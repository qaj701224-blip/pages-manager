export function buildRouteSnapshot({ site, route, version }) {
  return {
    schemaVersion: 1,
    routeId: route.id,
    hostname: route.hostname,
    environment: route.environment,
    siteId: site.id,
    siteUuid: site.siteUuid,
    slug: site.slug,
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
  };
}

export async function writeRouteSnapshot(routeSnapshots, snapshot) {
  if (!routeSnapshots || typeof routeSnapshots.put !== 'function') throw new Error('Route snapshot store is required');

  const snapshotKey = routeSnapshotKey(snapshot.hostname, snapshot.routeGeneration);
  await routeSnapshots.put(snapshotKey, JSON.stringify(snapshot));
  await routeSnapshots.put(
    routePointerKey(snapshot.hostname),
    JSON.stringify({
      hostname: snapshot.hostname,
      routeGeneration: snapshot.routeGeneration,
      snapshotKey,
    })
  );
  return { snapshotKey };
}

export function routeSnapshotKey(hostname, routeGeneration) {
  return `route_snapshot:${hostname}:${routeGeneration}`;
}

export function routePointerKey(hostname) {
  return `route_pointer:${hostname}`;
}
