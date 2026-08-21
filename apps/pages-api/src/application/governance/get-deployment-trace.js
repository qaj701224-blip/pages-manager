const TRACE_ID_PATTERN = /^dtr_[A-Za-z0-9_-]{1,128}$/;

export function createDeploymentTraceQuery({ deployments, events, diagnostics }) {
  if (typeof deployments?.get !== 'function') throw new TypeError('deployments.get is required');
  if (typeof events?.listByDeployment !== 'function') {
    throw new TypeError('events.listByDeployment is required');
  }
  if (typeof events?.listByTrace !== 'function') throw new TypeError('events.listByTrace is required');
  if (typeof diagnostics?.sanitize !== 'function') throw new TypeError('diagnostics.sanitize is required');

  return { byDeployment, byTraceId };

  async function byDeployment(query) {
    const deployment = await deployments.get(query.deploymentId, query.environment);
    if (!deployment) return { ok: false, reason: 'deployment_not_found' };

    const timeline = await events.listByDeployment({
      environment: query.environment,
      deploymentId: query.deploymentId,
    });
    return succeeded(projectTrace(deployment, timeline || [], deployment.traceId, diagnostics.sanitize));
  }

  async function byTraceId(query) {
    if (!TRACE_ID_PATTERN.test(query.traceId)) return { ok: false, reason: 'trace_not_found' };

    const timeline = await events.listByTrace({
      environment: query.environment,
      traceId: query.traceId,
    });
    if (!Array.isArray(timeline) || timeline.length === 0) {
      return { ok: false, reason: 'trace_not_found' };
    }

    const deploymentId = timeline.find((event) => event.deploymentId)?.deploymentId || null;
    const deployment = deploymentId ? await deployments.get(deploymentId, query.environment) : null;
    return succeeded(projectTrace(deployment, timeline, query.traceId, diagnostics.sanitize));
  }
}

function projectTrace(deployment, events, traceId, sanitizeDiagnostics) {
  const inboundRayId = events.find((event) => event.inboundRayId)?.inboundRayId || null;
  const deploymentId = deployment?.id || events.find((event) => event.deploymentId)?.deploymentId || null;
  const resolvedTraceId = traceId || deployment?.traceId || events.find((event) => event.traceId)?.traceId || null;
  return {
    trace: {
      traceId: resolvedTraceId,
      inboundRayId,
      deploymentId,
    },
    deployment: deployment
      ? {
          id: deployment.id,
          traceId: resolvedTraceId,
          inboundRayId,
          status: deployment.status,
          failureStage: deployment.failureStage || null,
          errorCode: deployment.errorCode || null,
          errorMessage: deployment.errorMessage || null,
        }
      : null,
    events: events.map((event) => projectEvent(event, sanitizeDiagnostics)),
  };
}

function projectEvent(event, sanitizeDiagnostics) {
  return {
    id: event.id,
    traceId: event.traceId,
    inboundRayId: event.inboundRayId || null,
    deploymentId: event.deploymentId || null,
    siteId: event.siteId || null,
    attempt: event.attempt,
    stage: event.stage,
    operation: event.operation || null,
    status: event.status,
    startedAt: event.startedAt,
    completedAt: event.completedAt || null,
    durationMs: Number.isInteger(event.durationMs) ? event.durationMs : null,
    errorCode: event.errorCode || null,
    errorMessage: event.errorMessage || null,
    diagnostics: sanitizeDiagnostics(event.diagnostics),
  };
}

function succeeded(value) {
  return { ok: true, value };
}
