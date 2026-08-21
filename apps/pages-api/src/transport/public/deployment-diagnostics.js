import { providerDiagnosticsFromError, recordDeploymentStage } from '../../deployment-trace.js';

const PROVIDER_DIAGNOSTIC_CLIENT_CODES = new Set(['WFP_API_ERROR', 'WFP_API_INVALID_JSON', 'WFP_NETWORK_ERROR']);
const PROVIDER_DIAGNOSTIC_OPERATIONS = new Set(['assets_upload_session', 'assets_upload', 'worker_put', 'worker_get']);

export async function recordCleanupOutcome(trace, outcome, { originalFailure, trafficImpact } = {}) {
  if (!trace || !outcome) return outcome;
  const provider = outcome.provider || (outcome.error ? providerDiagnosticsFromError(outcome.error) : undefined);
  const eventStatus =
    outcome.status === 'failed'
      ? 'failed'
      : outcome.status === 'not_needed'
        ? 'skipped'
        : outcome.status === 'succeeded'
          ? 'compensated'
          : 'succeeded';
  await recordDeploymentStage(trace, {
    stage: 'cleanup_or_compensation',
    operation: outcome.operation,
    status: eventStatus,
    diagnostics: {
      causeClass: outcome.error ? provider?.causeClass || outcome.causeClass : outcome.causeClass,
      trafficImpact,
      cleanupStatus: outcome.status,
      cleanupTaskId: outcome.cleanupTaskId,
      originalFailure,
      compensation: {
        status: outcome.status,
        operation: outcome.operation,
        ...provider,
      },
    },
  });
  return outcome;
}

export function buildDeploymentFailureDiagnostics({
  stage,
  executionProvider,
  deploymentShape,
  plannedVersionId,
  plannedWorkerName,
  uploadCompleted = false,
  verifyCompleted = false,
  routeActivatedInD1,
  routePointerCommitted = false,
  routePointerCleared,
  previousRouteRestored,
  uploadedWorkerCleanup,
  trafficImpact = 'old_version_retained',
  retryable = true,
  operatorAction = 'retry_deploy',
  cause,
  provider,
}) {
  return omitUndefined({
    schemaVersion: 1,
    stage,
    executionProvider,
    deploymentShape,
    plannedVersionId,
    plannedWorkerName,
    uploadCompleted,
    verifyCompleted,
    routeActivatedInD1,
    routePointerCommitted,
    routePointerCleared,
    previousRouteRestored,
    uploadedWorkerCleanup,
    trafficImpact,
    retryable,
    operatorAction,
    cause,
    provider,
  });
}

export function buildProviderFailureDiagnostics(error, executionProvider) {
  if (executionProvider !== 'wfp') return undefined;
  const operation = error?.operation;
  const clientCode = error?.code;
  if (!PROVIDER_DIAGNOSTIC_OPERATIONS.has(operation) || !PROVIDER_DIAGNOSTIC_CLIENT_CODES.has(clientCode)) {
    return undefined;
  }
  const diagnostics = providerDiagnosticsFromError(error);

  return omitUndefined({
    name: 'cloudflare_wfp',
    operation,
    httpStatus: diagnostics.httpStatus,
    clientCode,
    providerCode: diagnostics.providerCode,
    providerMessage: diagnostics.providerMessage,
    providerRequestId: diagnostics.providerRequestId,
  });
}

export function deploymentStoreErrorCause() {
  return {
    code: 'DEPLOYMENT_STATE_WRITE_FAILED',
    class: 'deployment_store_error',
  };
}

export function logDeploymentRepairRequired(env, input) {
  const payload = {
    event: 'pages_deployment_repair_required',
    environment: input.environment,
    siteId: input.siteId,
    deploymentId: input.deploymentId,
    reason: input.reason,
  };
  try {
    const logger =
      typeof env?.logDeploymentRepairRequired === 'function' ? env.logDeploymentRepairRequired : globalThis.console?.error;
    if (typeof logger === 'function') logger(JSON.stringify(payload));
  } catch {
    // Diagnostics must never replace the deployment response.
  }
}

export function logDeploymentStateWriteFailed(env, { traceId, deploymentId, operation }) {
  const payload = {
    event: 'pages_deployment_state_write_failed',
    traceId,
    deploymentId,
    stage: 'deployment_state_persist',
    operation,
    causeClass: 'deployment_store_error',
  };
  try {
    const logger =
      typeof env?.logDeploymentStateWriteFailed === 'function'
        ? env.logDeploymentStateWriteFailed
        : globalThis.console?.error;
    if (typeof logger === 'function') logger(JSON.stringify(payload));
  } catch {
    // Diagnostics must never replace the deployment response.
  }
}

export function publicProviderErrorCode(error, step) {
  if (error?.code === 'SLOT_CAPACITY_EXHAUSTED') return 'DEPLOYMENT_CAPACITY_EXHAUSTED';
  return step === 'upload' ? 'DEPLOYMENT_UPLOAD_FAILED' : 'DEPLOYMENT_VERIFY_FAILED';
}

export function providerFailureDisposition(error, step, providerDiagnostics) {
  if (step === 'upload' && isWorkerSourceCompilationFailure(error)) {
    const providerMessage = providerDiagnostics?.providerMessage;
    return {
      retryable: false,
      operatorAction: 'fix_worker_source',
      responseStatus: 400,
      responseMessage: 'Worker source compilation failed.',
      responseAction: providerMessage
        ? `Fix the Worker source and deploy again: ${providerMessage}`
        : 'Fix the Worker source compilation error, then deploy again.',
    };
  }

  return {
    retryable: true,
    operatorAction: 'retry_deploy',
    responseStatus: 502,
    responseMessage: step === 'verify' ? 'Deployment verification failed.' : 'Deployment upload failed.',
    responseAction: 'Retry the deployment with a new Idempotency-Key.',
  };
}

export function workerNameFor(site, deploymentId, environment) {
  const prefix = environment === 'staging' ? 'pages-v2-staging' : 'pages-v2';
  const suffix = boundedNamePart(deploymentId, 16);
  const maxSlugLength = Math.max(4, 63 - prefix.length - suffix.length - 2);
  const slug = boundedNamePart(site.slug, maxSlugLength);
  return `${prefix}-${slug}-${suffix}`;
}

function isWorkerSourceCompilationFailure(error) {
  if (error?.operation !== 'worker_put' || Number(error?.status) !== 400) return false;
  const providerCode = error?.providerCode === undefined || error?.providerCode === null ? '' : String(error.providerCode);
  if (providerCode === '10021') return true;
  const providerMessage = typeof error?.providerMessage === 'string' ? error.providerMessage : '';
  return /(?:SyntaxError|syntax error|Unexpected end of input)/i.test(providerMessage);
}

function boundedNamePart(value, maxLength) {
  const normalized = String(value || '')
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (normalized.length <= maxLength) return normalized || 'x';
  return normalized.slice(0, maxLength).replace(/-+$/g, '') || normalized.slice(-maxLength);
}

function omitUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
