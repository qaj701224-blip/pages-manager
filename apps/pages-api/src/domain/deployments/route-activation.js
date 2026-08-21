export function resolveDeploymentRouteActivation({
  site,
  routeBeforeActivation,
  latestRoute,
  uploadExposure,
  ownerTransferApplied,
}) {
  if (!latestRoute) return conflict('route_missing');

  const exposure = normalizeDeploymentExposure(latestRoute.exposure);
  if (exposure !== uploadExposure) return conflict('exposure_changed');

  const visibility =
    ownerTransferApplied || latestRoute.visibility === routeBeforeActivation?.visibility
      ? site.defaultVisibility
      : latestRoute.visibility;
  return {
    ok: true,
    activation: {
      exposure,
      visibility,
      expectedRoute: { ...latestRoute, exposure },
    },
  };
}

function normalizeDeploymentExposure(value) {
  return value === 'public' ? 'public' : 'internal';
}

function conflict(reason) {
  return { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason } };
}
