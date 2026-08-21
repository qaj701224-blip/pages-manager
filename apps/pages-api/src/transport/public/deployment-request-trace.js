import {
  finishDeploymentStage,
  recordDeploymentStage,
  startDeploymentStage,
  withDeploymentTraceHeader,
} from '../../deployment-trace.js';

const requestTraceStates = new WeakMap();

export async function finishRequestAuthStage(handle, input) {
  if (!handle || handle.finished) return null;
  handle.finished = true;
  if (input?.status === 'failed') {
    await flushRequestTraceSuccesses(handle.trace);
    markRequestTraceFailed(handle.trace);
  }
  return finishDeploymentStage(handle, input);
}

export async function finishValidatedRequestTrace(trace, authStage) {
  await flushRequestTraceSuccess(trace, 'intake');
  await finishRequestAuthStage(authStage, { status: 'succeeded' });
  await flushRequestTraceSuccess(trace, 'payload_validation');
}

export function discardReplayRequestTrace(trace, authStage) {
  const state = trace ? requestTraceStates.get(trace) : null;
  if (state?.pendingSuccesses) state.pendingSuccesses.length = 0;
  if (authStage) authStage.finished = true;
}

export async function finishRequestAuthStageFromResponse(handle, response, causeClass) {
  let errorCode = 'AUTH_AND_SITE_RESOLUTION_FAILED';
  let errorMessage = 'Authentication or site resolution failed.';
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.code === 'string') errorCode = body.error.code;
    if (typeof body?.error?.message === 'string') errorMessage = body.error.message;
  } catch {
    // Keep the fixed safe fallback fields.
  }
  return finishRequestAuthStage(handle, {
    status: 'failed',
    errorCode,
    errorMessage,
    diagnostics: { causeClass },
  });
}

export async function traceFailureResponse(
  trace,
  response,
  { stage, operation, errorCode, errorMessage, diagnostics }
) {
  if (trace) {
    await flushRequestTraceSuccesses(trace);
    markRequestTraceFailed(trace);
    await recordDeploymentStage(trace, {
      stage,
      operation,
      status: 'failed',
      errorCode,
      errorMessage,
      diagnostics,
    });
  }
  return response;
}

export function setRequestTraceStage(trace, stage, operation) {
  if (!trace) return;
  const current = requestTraceStates.get(trace);
  requestTraceStates.set(trace, {
    stage,
    operation,
    failed: current?.failed || false,
    pendingSuccesses: current?.pendingSuccesses || [],
  });
}

export function queueRequestTraceSuccess(trace, stage, operation) {
  if (!trace) return;
  const current = requestTraceStates.get(trace) || {
    stage: null,
    operation: null,
    failed: false,
    pendingSuccesses: [],
  };
  current.pendingSuccesses.push({
    stage,
    operation,
    handle: startDeploymentStage(trace, { stage, operation }),
  });
  requestTraceStates.set(trace, current);
}

async function flushRequestTraceSuccesses(trace) {
  const current = trace ? requestTraceStates.get(trace) : null;
  if (!current?.pendingSuccesses?.length) return;
  const pending = current.pendingSuccesses.splice(0);
  for (const item of pending) await finishDeploymentStage(item.handle, { status: 'succeeded' });
}

async function flushRequestTraceSuccess(trace, stage) {
  const current = trace ? requestTraceStates.get(trace) : null;
  if (!current?.pendingSuccesses?.length) return;
  const matching = [];
  const remaining = [];
  for (const item of current.pendingSuccesses) {
    if (item.stage === stage) matching.push(item);
    else remaining.push(item);
  }
  current.pendingSuccesses = remaining;
  for (const item of matching) await finishDeploymentStage(item.handle, { status: 'succeeded' });
}

export function clearRequestTraceStage(trace) {
  if (trace) requestTraceStates.delete(trace);
}

function markRequestTraceFailed(trace) {
  if (!trace) return;
  const current = requestTraceStates.get(trace);
  requestTraceStates.set(trace, {
    stage: current?.stage || null,
    operation: current?.operation || null,
    failed: true,
    pendingSuccesses: current?.pendingSuccesses || [],
  });
}

export async function ensureRequestFailureTraced(trace, response) {
  const state = trace ? requestTraceStates.get(trace) : null;
  if (!state || state.failed || response.status < 400 || !state.stage) return response;

  let errorCode = 'DEPLOYMENT_REQUEST_FAILED';
  let errorMessage = 'Deployment request failed.';
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.code === 'string') errorCode = body.error.code;
    if (typeof body?.error?.message === 'string') errorMessage = body.error.message;
  } catch {
    // Keep the fixed safe fallback fields.
  }
  await flushRequestTraceSuccesses(trace);
  markRequestTraceFailed(trace);
  await recordDeploymentStage(trace, {
    stage: state.stage,
    operation: state.operation,
    status: 'failed',
    errorCode,
    errorMessage,
    diagnostics: { causeClass: 'request_stage_error' },
  });
  return response;
}

export async function traceUnexpectedRequestFailure(trace, { fallbackStage, fallbackOperation }) {
  if (!trace) return;
  const state = requestTraceStates.get(trace);
  if (state?.failed) return;
  await flushRequestTraceSuccesses(trace);
  markRequestTraceFailed(trace);
  await recordDeploymentStage(trace, {
    stage: state?.stage || fallbackStage,
    operation: state?.operation || fallbackOperation,
    status: 'failed',
    errorCode: 'DEPLOYMENT_REQUEST_FAILED',
    errorMessage: 'Deployment request could not be processed.',
    diagnostics: { causeClass: 'unexpected_orchestration_error' },
  });
}

export function withRequestTraceHeader(response, trace) {
  if (!trace) return response;
  return withDeploymentTraceHeader(response, response.headers.get('X-Deployment-Trace-Id') || trace.traceId);
}
