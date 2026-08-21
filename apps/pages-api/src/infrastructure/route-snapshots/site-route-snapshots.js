export function createSiteRouteSnapshots({ store, buildSnapshot, writeSnapshot }) {
  if (!store || typeof store !== 'object') throw new TypeError('route snapshot store is required');
  if (typeof buildSnapshot !== 'function') throw new TypeError('buildSnapshot is required');
  if (typeof writeSnapshot !== 'function') throw new TypeError('writeSnapshot is required');

  return {
    refreshActive: (input) => refreshActive({ store, buildSnapshot, writeSnapshot }, input),
    refreshCurrent: (input) => refreshCurrent({ store, buildSnapshot, writeSnapshot }, input),
  };
}

async function refreshActive(context, { site, route, environment, aclEntries }) {
  if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return;
  const version = await context.store.getSiteVersion(route.activeVersionId, environment);
  if (!version) throw snapshotError('ROUTE_VERSION_NOT_FOUND');
  const resolvedAclEntries = aclEntries || (await context.store.listSiteAclEntries(site.id));
  await writeSnapshot(context, { site, route, version, aclEntries: resolvedAclEntries });
}

async function refreshCurrent(context, { site, route, environment }) {
  if (!route) return;
  const version = route.activeVersionId
    ? await context.store.getSiteVersion(route.activeVersionId, environment)
    : inactiveRouteVersion(route);
  if (!version && route.routeStatus === 'active') throw snapshotError('ROUTE_VERSION_NOT_FOUND');
  const aclEntries = await context.store.listSiteAclEntries(site.id);
  await writeSnapshot(context, { site, route, version, aclEntries });
}

async function writeSnapshot(context, input) {
  try {
    await context.writeSnapshot(context.buildSnapshot(input));
  } catch {
    throw snapshotError('ROUTE_SNAPSHOT_WRITE_FAILED');
  }
}

function inactiveRouteVersion(route) {
  return {
    id: null,
    executionProvider: route.executionProvider,
    dispatchType: route.dispatchType,
    dispatchBindingName: route.dispatchBindingName,
    slotId: route.slotId,
    contentHash: null,
    deploymentShape: 'inactive',
    resolvedFallback: null,
    routingMode: null,
  };
}

function snapshotError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
