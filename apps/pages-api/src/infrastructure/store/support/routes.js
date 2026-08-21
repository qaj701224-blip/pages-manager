import { accessModeFromVisibility, normalizeExposure } from '@xd/pages-access-policy';

export function cacheTierForVisibility(visibility) {
  if (visibility === 'disabled') return 'strict';
  if (visibility === 'acl' || visibility === 'owner') return 'sensitive';
  return 'fast';
}

export function createInitialRoute(input, now) {
  return {
    id: input.routeId,
    hostname: input.hostname,
    siteId: input.id,
    environment: input.environment,
    runtime: 'disabled',
    executionProvider: null,
    workerName: null,
    dispatchType: null,
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: null,
    visibility: input.defaultVisibility,
    exposure: 'internal',
    accessMode: accessModeFromVisibility(input.defaultVisibility),
    policyVersion: 1,
    routeGeneration: 0,
    runtimeConfigGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: cacheTierForVisibility(input.defaultVisibility),
    createdAt: now,
    updatedAt: now,
  };
}

export function routesMatch(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.id === expected.id &&
    actual.activeVersionId === expected.activeVersionId &&
    actual.workerName === expected.workerName &&
    actual.runtime === expected.runtime &&
    actual.executionProvider === expected.executionProvider &&
    actual.dispatchType === expected.dispatchType &&
    actual.dispatchBindingName === expected.dispatchBindingName &&
    actual.slotId === expected.slotId &&
    actual.visibility === expected.visibility &&
    actual.policyVersion === expected.policyVersion &&
    actual.routeGeneration === expected.routeGeneration &&
    (actual.runtimeConfigGeneration || 0) === (expected.runtimeConfigGeneration || 0) &&
    actual.routeStatus === expected.routeStatus
  );
}

export function routesMatchIgnoringRuntimeConfigGeneration(actual, expected) {
  if (!actual || !expected) return false;
  return routesMatch(
    {
      ...actual,
      runtimeConfigGeneration: expected.runtimeConfigGeneration || 0,
    },
    expected
  );
}

export function routesMatchExecutionState(actual, expected) {
  if (!actual || !expected) return false;
  return (
    actual.id === expected.id &&
    actual.activeVersionId === expected.activeVersionId &&
    actual.workerName === expected.workerName &&
    actual.runtime === expected.runtime &&
    actual.executionProvider === expected.executionProvider &&
    actual.dispatchType === expected.dispatchType &&
    actual.dispatchBindingName === expected.dispatchBindingName &&
    actual.slotId === expected.slotId &&
    actual.routeGeneration === expected.routeGeneration &&
    actual.routeStatus === expected.routeStatus
  );
}

export function routeWithLatestRuntimeConfig(route, latestRoute) {
  if (!route || !latestRoute) return route;
  return {
    ...route,
    runtimeConfigGeneration: latestRoute.runtimeConfigGeneration || 0,
    updatedAt: latestRoute.updatedAt,
  };
}

export function routeRestoredAsNewCommit(previousRoute, currentRoute) {
  return {
    ...previousRoute,
    visibility: currentRoute.visibility,
    exposure: normalizeExposure(currentRoute.exposure),
    accessMode: accessModeFromVisibility(currentRoute.visibility),
    policyVersion: currentRoute.policyVersion,
    cacheTier: currentRoute.cacheTier,
    routeGeneration: Math.max(previousRoute.routeGeneration || 0, currentRoute.routeGeneration || 0) + 1,
    runtimeConfigGeneration: currentRoute.runtimeConfigGeneration || 0,
    updatedAt: currentRoute.updatedAt,
  };
}

export function routeRestoredAsNewPolicyCommit(previousRoute, currentRoute) {
  const previousPolicyVersion = previousRoute.policyVersion || 0;
  const currentPolicyVersion = currentRoute.policyVersion || 0;
  return {
    ...previousRoute,
    exposure: normalizeExposure(previousRoute.exposure),
    accessMode: accessModeFromVisibility(previousRoute.visibility),
    policyVersion: Math.max(previousPolicyVersion, currentPolicyVersion) + (currentPolicyVersion > previousPolicyVersion ? 1 : 0),
    routeGeneration: currentRoute.routeGeneration,
    runtimeConfigGeneration: currentRoute.runtimeConfigGeneration || 0,
    cacheTier: cacheTierForVisibility(previousRoute.visibility),
    updatedAt: currentRoute.updatedAt,
  };
}

export function executionProviderFromRuntime(runtime) {
  return runtime === 'wfp' ? 'wfp' : null;
}

export function dispatchTypeFromExecutionProvider(value) {
  const executionProvider = executionProviderFromRuntime(value) || value;
  if (executionProvider === 'normal-worker-slot') return 'service-binding';
  if (executionProvider === 'wfp') return 'dispatch-namespace';
  return null;
}
