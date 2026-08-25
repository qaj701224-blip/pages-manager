export function createSiteRouteSnapshots({ store, buildSnapshot, writeSnapshot, repairSnapshot, clearPointer }) {
  if (!store || typeof store !== 'object') throw new TypeError('route snapshot store is required');
  if (typeof buildSnapshot !== 'function') throw new TypeError('buildSnapshot is required');
  if (typeof writeSnapshot !== 'function') throw new TypeError('writeSnapshot is required');

  return {
    commitDeployment: (input) => commitDeployment({ store, buildSnapshot, writeSnapshot }, input),
    refreshActive: (input) => refreshActive({ store, buildSnapshot, writeSnapshot }, input),
    refreshCurrent: (input) => refreshCurrent({ store, buildSnapshot, writeSnapshot }, input),
    repairCurrent: (input) => repairCurrent({ store, buildSnapshot, repairSnapshot }, input),
    clearCurrent: (input) => clearCurrent({ clearPointer }, input),
    clearRetired: (input) => clearRetired({ clearPointer }, input),
  };
}

async function commitDeployment(context, { site, route, version }) {
  const aclEntries = await context.store.listSiteAclEntries(site.id);
  const latestSite = await context.store.getSite(site.id);
  return writeSnapshot(context, { site: latestSite, route, version, aclEntries });
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

async function repairCurrent(context, { site, route, environment }) {
  if (typeof context.repairSnapshot !== 'function') throw snapshotError('ROUTE_SNAPSHOT_WRITE_FAILED');
  const version = route.activeVersionId
    ? await context.store.getSiteVersion(route.activeVersionId, environment)
    : inactiveRouteVersion(route);
  if (!version && route.routeStatus === 'active') throw snapshotError('ROUTE_VERSION_NOT_FOUND');
  const aclEntries = await context.store.listSiteAclEntries(site.id);
  const snapshot = context.buildSnapshot({ site, route, version, aclEntries });
  await confirmSnapshot(context, snapshot);
  return snapshot;
}

async function clearCurrent(context, { site, route }) {
  const identity = site?.id && route?.id ? { siteId: site.id, routeId: route.id } : {};
  return clearRoutePointer(context, route?.hostname, route, identity);
}

async function clearRetired(context, { site, route, claim }) {
  if (
    !site?.id ||
    !route?.id ||
    !claim?.hostname ||
    claim.ownerSystem !== 'v2' ||
    claim.ownerId !== site.id ||
    claim.ownerRef !== route.id ||
    claim.environment !== route.environment ||
    claim.hostname === route.hostname
  ) {
    return false;
  }
  return clearRoutePointer(context, claim.hostname, route, { siteId: site.id, routeId: route.id });
}

async function clearRoutePointer(context, hostname, route, identity = {}) {
  if (typeof context.clearPointer !== 'function' || !hostname || !route) return false;
  return context.clearPointer({
    hostname,
    environment: route.environment,
    routeGeneration: route.routeGeneration,
    policyVersion: route.policyVersion,
    ...identity,
  });
}

async function confirmSnapshot(context, snapshot) {
  try {
    const result = await context.repairSnapshot(snapshot);
    if (!result?.pointerConfirmed) throw new Error('ROUTE_POINTER_NOT_CONFIRMED');
  } catch {
    throw snapshotError('ROUTE_SNAPSHOT_WRITE_FAILED');
  }
}

async function writeSnapshot(context, input) {
  try {
    const snapshot = context.buildSnapshot(input);
    await context.writeSnapshot(snapshot);
    return snapshot;
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
