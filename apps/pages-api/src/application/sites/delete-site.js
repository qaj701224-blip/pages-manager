import { authorizeSiteMutation } from './authorize-site-mutation.js';

export function createDeleteSite({ siteLifecycle, routeSnapshots, enqueueDeletedResources, events, clock, reuseHoldSeconds }) {
  if (!siteLifecycle || typeof siteLifecycle !== 'object') throw new TypeError('siteLifecycle port is required');
  if (typeof siteLifecycle.withSiteCommitLock !== 'function') {
    throw new TypeError('siteLifecycle.withSiteCommitLock is required');
  }
  for (const name of ['getSite', 'getSiteForUser', 'getAccessKeyById', 'getUser', 'getTeam', 'isPlatformAdmin']) {
    if (typeof siteLifecycle[name] !== 'function') throw new TypeError(`siteLifecycle.${name} is required`);
  }
  if (typeof routeSnapshots?.refreshCurrent !== 'function') throw new TypeError('routeSnapshots.refreshCurrent is required');
  if (typeof enqueueDeletedResources !== 'function') throw new TypeError('enqueueDeletedResources is required');
  if (typeof events?.siteDeleted !== 'function') throw new TypeError('events.siteDeleted is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return async function deleteSite(command) {
    const committed = await siteLifecycle.withSiteCommitLock(
      command.environment,
      command.site.id,
      (lease) =>
        deleteSiteUnderLock({
          siteLifecycle,
          routeSnapshots,
          command,
          lease,
          clock,
          reuseHoldSeconds,
        }),
      { bestEffortRelease: true }
    );

    await enqueueDeletedResources({
      environment: command.environment,
      site: committed.currentSite,
      previousRoute: committed.previousRoute,
      cleanupAfter: committed.cleanupAfter,
    });
    await events.siteDeleted({
      actor: command.actor,
      site: committed.deleted,
      previousRoute: committed.previousRoute,
      route: committed.route,
    });
    return {
      site: committed.deleted,
      previousRoute: committed.previousRoute,
      route: committed.route,
      cleanupAfter: committed.cleanupAfter,
    };
  };
}

async function deleteSiteUnderLock({ siteLifecycle, routeSnapshots, command, lease, clock, reuseHoldSeconds }) {
  const { site: currentSite } = await authorizeSiteMutation({
    sites: siteLifecycle,
    environment: command.environment,
    siteId: command.site.id,
    actor: command.actor,
    capability: command.capability,
    now: clock.now(),
  });
  const previousRoute = await siteLifecycle.getRouteBySiteId(currentSite.id, command.environment);
  if (!previousRoute) throw applicationError('SITE_NOT_FOUND');
  const previousHostnameClaims = await readPreviousHostnameClaims(siteLifecycle, previousRoute, currentSite, command.environment);
  const previousRetiringClaims = await readPreviousRetiringClaims(
    siteLifecycle,
    currentSite,
    command.environment,
    previousHostnameClaims
  );
  await clearRetiringRoutePointers(routeSnapshots, {
    site: currentSite,
    route: previousRoute,
    retiringClaims: previousRetiringClaims,
  });
  await reauthorizeDelete(siteLifecycle, command, currentSite, clock.now());
  if (!routeWasActive(previousRoute)) {
    const pointerCleared = await clearDeletedRoutePointer(routeSnapshots, {
      site: currentSite,
      route: previousRoute,
    });
    if (!pointerCleared) throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
    await reauthorizeDelete(siteLifecycle, command, currentSite, clock.now());
  }
  const deletedAt = clock.now();
  const authorization = await reauthorizeDelete(siteLifecycle, command, currentSite, deletedAt);
  const cleanupAfter = addSecondsIso(deletedAt, reuseHoldSeconds);
  const deleted = await siteLifecycle.deleteSite(
    currentSite.id,
    {
      deletedAt,
      reuseHoldUntil: cleanupAfter,
      releaseReason: 'site_deleted',
      authorization: authorization.authorization,
      expectedOwner: ownerAuthority(currentSite),
      lease,
    },
    command.environment
  );
  if (!deleted) throw applicationError('SITE_NOT_FOUND');

  const route = await siteLifecycle.getRouteBySiteId(currentSite.id, command.environment);
  if (routeWasActive(previousRoute)) {
    try {
      await routeSnapshots.refreshCurrent({ site: deleted, route, environment: command.environment });
    } catch (error) {
      const pointerCleared = command.compensateSnapshotFailure
        ? false
        : await clearDeletedRoutePointer(routeSnapshots, { site: deleted, route });
      if (!pointerCleared) {
        await compensateDeleteSnapshotFailure({
          siteLifecycle,
          routeSnapshots,
          site: currentSite,
          previousRoute,
          previousHostnameClaims,
          deletedRoute: route,
          environment: command.environment,
          lease,
        });
      }
      throw error;
    }
    await clearDeletedRoutePointer(routeSnapshots, { site: deleted, route });
  }

  return { currentSite, deleted, previousRoute, route, cleanupAfter };
}

async function reauthorizeDelete(siteLifecycle, command, expectedSite, now) {
  const authorization = await authorizeSiteMutation({
    sites: siteLifecycle,
    environment: command.environment,
    siteId: expectedSite.id,
    actor: command.actor,
    capability: command.capability,
    now,
  });
  const { site } = authorization;
  if (!sameOwnerAuthority(site, expectedSite)) throw applicationError('SITE_POLICY_CONFLICT');
  return authorization;
}

async function readPreviousRetiringClaims(siteLifecycle, site, environment, previousHostnameClaims) {
  if (Array.isArray(previousHostnameClaims)) {
    return previousHostnameClaims.filter(
      (claim) =>
        claim.status === 'held' && claim.releaseReason === 'site_slug_renamed_pending_cleanup' && claim.reuseHoldUntil === null
    );
  }
  if (typeof siteLifecycle.listSiteRetiringHostnameClaims !== 'function') return [];
  return siteLifecycle.listSiteRetiringHostnameClaims(site.id, { environment });
}

async function clearRetiringRoutePointers(routeSnapshots, { site, route, retiringClaims }) {
  for (const claim of retiringClaims) {
    try {
      const cleared = await routeSnapshots.clearRetired({ site, route, claim });
      if (!cleared) throw new Error('ROUTE_POINTER_NOT_CLEARED');
    } catch {
      throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
    }
  }
}

async function clearDeletedRoutePointer(routeSnapshots, input) {
  if (typeof routeSnapshots.clearCurrent !== 'function') return false;
  try {
    return (await routeSnapshots.clearCurrent(input)) === true;
  } catch {
    return false;
  }
}

async function readPreviousHostnameClaims(siteLifecycle, previousRoute, site, environment) {
  if (typeof siteLifecycle.listSiteHostnameClaims === 'function') {
    return siteLifecycle.listSiteHostnameClaims(site.id, { environment });
  }
  if (!previousRoute?.hostname) return [];
  if (typeof siteLifecycle.getHostnameClaim !== 'function') return [];
  const claim = await siteLifecycle.getHostnameClaim(previousRoute.hostname);
  return claim ? [claim] : [];
}

async function compensateDeleteSnapshotFailure({
  siteLifecycle,
  routeSnapshots,
  site,
  previousRoute,
  previousHostnameClaims,
  deletedRoute,
  environment,
  lease,
}) {
  let restoredSite = null;
  let restoredRoute = deletedRoute;
  try {
    restoredRoute = await restoreDelete(
      siteLifecycle,
      site,
      previousRoute,
      previousHostnameClaims,
      deletedRoute,
      environment,
      lease
    );
    restoredSite = await siteLifecycle.getSite(site.id, environment);
    if (!restoredRoute || !restoredSite || restoredSite.deletedAt) {
      throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
    }
    await routeSnapshots.refreshCurrent({ site: restoredSite, route: restoredRoute, environment });
    return;
  } catch {
    await clearDeletedRoutePointer(routeSnapshots, {
      site: restoredSite || site,
      route: restoredRoute || deletedRoute,
    });
    throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
  }
}

async function restoreDelete(siteLifecycle, site, previousRoute, previousHostnameClaims, expectedRoute, environment, lease) {
  if (typeof siteLifecycle.restoreSiteDeleteIfCurrent === 'function') {
    return siteLifecycle.restoreSiteDeleteIfCurrent(
      site.id,
      site,
      previousRoute,
      previousHostnameClaims,
      expectedRoute,
      environment,
      lease
    );
  }
  if (typeof siteLifecycle.restoreSiteRouteIfCurrent === 'function') {
    return siteLifecycle.restoreSiteRouteIfCurrent(site.id, previousRoute, expectedRoute, environment);
  }
  if (typeof siteLifecycle.restoreSiteRoute === 'function') {
    return siteLifecycle.restoreSiteRoute(site.id, previousRoute, environment);
  }
  return null;
}

function routeWasActive(route) {
  return route?.routeStatus === 'active' && Boolean(route.activeVersionId);
}

function sameOwnerAuthority(left, right) {
  return (
    (left.ownerType || 'user') === (right.ownerType || 'user') &&
    (left.ownerId || left.ownerUserId) === (right.ownerId || right.ownerUserId)
  );
}

function ownerAuthority(site) {
  return {
    ownerType: site.ownerType || 'user',
    ownerId: site.ownerId || site.ownerUserId,
  };
}

function addSecondsIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
