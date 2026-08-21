export async function deploymentEnvelope(store, deployment, preloaded = {}, environment) {
  const version =
    preloaded.version || (deployment.versionId ? await store.getSiteVersion(deployment.versionId, environment) : null);
  const route =
    preloaded.route || (deployment.siteId ? await store.getRouteBySiteId(deployment.siteId, environment) : null);
  const envelope = {
    deployment: formatDeployment(deployment),
    version: version ? formatVersion(version) : null,
    route: route ? formatRoute(route) : null,
    decision: preloaded.decision ? formatDecision(preloaded.decision) : formatVersionDecision(version),
  };
  if (preloaded.ownerTransfer) envelope.ownerTransfer = preloaded.ownerTransfer;
  return envelope;
}

export function inactiveRouteVersion(route) {
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

function formatDeployment(deployment) {
  const formatted = {
    id: deployment.id,
    siteId: deployment.siteId,
    versionId: deployment.versionId,
    actorType: deployment.actorType,
    operation: deployment.operation,
    source: deployment.source,
    visibility: deployment.visibility,
    status: deployment.status,
    errorCode: deployment.errorCode || null,
    errorMessage: deployment.errorMessage || null,
    previousVersionId: deployment.previousVersionId,
    createdAt: deployment.createdAt,
    completedAt: deployment.completedAt,
  };
  if (deployment.failureStage) formatted.failureStage = deployment.failureStage;
  return formatted;
}

function formatVersion(version) {
  return {
    id: version.id,
    siteId: version.siteId,
    deploymentId: version.deploymentId,
    runtime: version.runtime,
    contentHash: version.contentHash,
    decision: formatVersionDecision(version),
    workerEntry: version.workerEntry || null,
    createdAt: version.createdAt,
  };
}

function formatDecision(decision) {
  return {
    deploymentShape: decision.deploymentShape,
    requestedFallback: decision.requestedFallback,
    resolvedFallback: decision.resolvedFallback,
    routingMode: decision.routingMode,
  };
}

function formatVersionDecision(version) {
  if (!version) return null;
  if (!version.deploymentShape && !version.routingMode) return null;
  return {
    deploymentShape: version.deploymentShape || null,
    requestedFallback: version.requestedFallback || null,
    resolvedFallback: version.resolvedFallback || null,
    routingMode: version.routingMode || null,
  };
}

function formatRoute(route) {
  return {
    id: route.id,
    hostname: route.hostname,
    siteId: route.siteId,
    runtime: route.runtime,
    activeVersionId: route.activeVersionId,
    visibility: route.visibility,
    policyVersion: route.policyVersion,
    routeGeneration: route.routeGeneration,
    routeStatus: route.routeStatus,
  };
}
