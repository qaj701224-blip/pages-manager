export function createDeleteSite({ siteLifecycle, routeSnapshots, enqueueDeletedResources, events, clock, reuseHoldSeconds }) {
  if (!siteLifecycle || typeof siteLifecycle !== 'object') throw new TypeError('siteLifecycle port is required');
  if (typeof routeSnapshots?.refreshCurrent !== 'function') throw new TypeError('routeSnapshots.refreshCurrent is required');
  if (typeof enqueueDeletedResources !== 'function') throw new TypeError('enqueueDeletedResources is required');
  if (typeof events?.siteDeleted !== 'function') throw new TypeError('events.siteDeleted is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return async function deleteSite(command) {
    const deletedAt = clock.now();
    const cleanupAfter = addSecondsIso(deletedAt, reuseHoldSeconds);
    const previousRoute = command.site.route || (await siteLifecycle.getRouteBySiteId(command.site.id, command.environment));
    const previousHostnameClaim = await readPreviousHostnameClaim(siteLifecycle, previousRoute, command);
    const deleted = await siteLifecycle.deleteSite(
      command.site.id,
      { deletedAt, reuseHoldUntil: cleanupAfter, releaseReason: 'site_deleted' },
      command.environment
    );
    if (!deleted) throw applicationError('SITE_NOT_FOUND');

    const route = await siteLifecycle.getRouteBySiteId(command.site.id, command.environment);
    if (routeWasActive(previousRoute)) {
      try {
        await routeSnapshots.refreshCurrent({ site: deleted, route, environment: command.environment });
      } catch (error) {
        if (command.compensateSnapshotFailure) {
          await restoreDelete(siteLifecycle, command.site, previousRoute, previousHostnameClaim, route, command.environment);
        }
        throw error;
      }
    }

    await enqueueDeletedResources({
      environment: command.environment,
      site: command.site,
      previousRoute,
      cleanupAfter,
    });
    await events.siteDeleted({
      actor: command.actor,
      site: deleted,
      previousRoute,
      route,
    });
    return { site: deleted, previousRoute, route, cleanupAfter };
  };
}

async function readPreviousHostnameClaim(siteLifecycle, previousRoute, command) {
  if (!command.compensateSnapshotFailure || !previousRoute?.hostname) return null;
  if (typeof siteLifecycle.getHostnameClaim !== 'function') return null;
  return siteLifecycle.getHostnameClaim(previousRoute.hostname);
}

async function restoreDelete(siteLifecycle, site, previousRoute, previousHostnameClaim, expectedRoute, environment) {
  if (typeof siteLifecycle.restoreSiteDeleteIfCurrent === 'function') {
    return siteLifecycle.restoreSiteDeleteIfCurrent(
      site.id,
      site,
      previousRoute,
      previousHostnameClaim,
      expectedRoute,
      environment
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

function addSecondsIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
