export const SITE_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);

export function isSiteVisibility(value) {
  return SITE_VISIBILITIES.has(value);
}

export function teamOwnerSupportsVisibility(site, visibility) {
  return site?.ownerType !== 'team' || visibility !== 'owner';
}

export function sitePolicyExpected(route) {
  return {
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    activeVersionId: route.activeVersionId,
    runtimeConfigGeneration: route.runtimeConfigGeneration,
  };
}

export function previousRouteExposure(route) {
  return route?.exposure === 'public' ? 'public' : 'internal';
}

export function sitePolicyRouteCanBeCompensated(current, committed) {
  if (!current || !committed) return false;
  return (
    current.id === committed.id &&
    current.environment === committed.environment &&
    current.siteId === committed.siteId &&
    current.exposure === committed.exposure &&
    current.accessMode === committed.accessMode &&
    current.visibility === committed.visibility &&
    current.policyVersion === committed.policyVersion &&
    current.routeGeneration === committed.routeGeneration &&
    current.activeVersionId === committed.activeVersionId &&
    current.routeStatus === committed.routeStatus
  );
}
