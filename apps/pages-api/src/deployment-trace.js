import { nextId } from './id.js';

const DEPLOYMENT_STAGES = new Set([
  'intake',
  'auth_and_site_resolution',
  'payload_validation',
  'deployment_record',
  'runtime_config',
  'provider_upload',
  'provider_verify',
  'runtime_config_commit',
  'version_create',
  'route_policy_lock',
  'office_net',
  'route_activate',
  'route_snapshot',
  'deployment_state_persist',
  'cleanup_or_compensation',
  'webhook_delivery',
]);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'compensated', 'skipped']);
const COMPENSATION_STATUSES = new Set(['succeeded', 'failed', 'compensated', 'skipped', 'not_needed', 'scheduled', 'unknown']);
const SAFE_RAY_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const SAFE_INTERNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_OPERATION_RE = /^[a-z][a-z0-9_]{0,95}$/;
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,95}$/;
const SAFE_CLIENT_CODE_RE = /^WFP_[A-Z0-9_]{1,64}$/;
const SAFE_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,95}$/;
const SENSITIVE_OPERATION_ALLOWLIST = new Set(['worker_secret_put', 'worker_secret_delete']);
const JWT_LIKE_RE = /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?=$|[^A-Za-z0-9_-])/;
const MAX_MESSAGE_LENGTH = 512;
const traceInternals = new WeakMap();

export function createDeploymentTraceContext(request, env, input = {}) {
  const trace = {
    traceId: nextId(env, 'dtr'),
    inboundRayId: normalizeRayId(request?.headers?.get?.('cf-ray')),
    environment: normalizeEnvironment(input.environment),
    operation: normalizeTraceOperation(input.operation),
    attempt: 1,
    deploymentId: null,
    siteId: null,
  };
  traceInternals.set(trace, {
    env,
    store: input.store || null,
    logger: typeof input.logger === 'function' ? input.logger : null,
    now: typeof input.now === 'function' ? input.now : null,
    lastStartedMs: null,
  });
  return trace;
}

export function bindDeploymentTrace(trace, input = {}) {
  assertTraceContext(trace);
  const traceId = tryNormalizeTraceId(input.traceId);
  const deploymentId = normalizeInternalId(input.deploymentId);
  const siteId = normalizeInternalId(input.siteId);
  if (traceId) trace.traceId = traceId;
  if (deploymentId) trace.deploymentId = deploymentId;
  if (siteId) trace.siteId = siteId;
  if (Number.isInteger(input.attempt) && input.attempt > 0) trace.attempt = input.attempt;
  return trace;
}

export function withDeploymentTraceHeader(response, traceId) {
  const headers = new Headers(response.headers);
  headers.set('X-Deployment-Trace-Id', normalizeTraceId(traceId));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function startDeploymentStage(trace, input = {}) {
  const internal = assertTraceContext(trace);
  const stage = normalizeStage(input.stage);
  if (!stage) throw new Error('DEPLOYMENT_TRACE_STAGE_INVALID');
  const observedMs = readNowMs(internal);
  const startedMs = Number.isFinite(internal.lastStartedMs) ? Math.max(observedMs, internal.lastStartedMs + 1) : observedMs;
  internal.lastStartedMs = startedMs;
  return {
    trace,
    stage,
    operation: normalizeOperation(input.operation),
    startedMs,
    startedAt: new Date(startedMs).toISOString(),
  };
}

export async function finishDeploymentStage(handle, input = {}) {
  const internal = assertStageHandle(handle);
  const status = normalizeTerminalStatus(input.status);
  if (!status) throw new Error('DEPLOYMENT_TRACE_STATUS_INVALID');

  const completedMs = Math.max(handle.startedMs, readNowMs(internal));
  const automaticDiagnostics = providerDiagnosticsFromError(input.error);
  const diagnostics = sanitizeDiagnostics({
    ...automaticDiagnostics,
    ...(isPlainObject(input.diagnostics) ? input.diagnostics : {}),
  });
  const event = {
    id: nextId(internal.env, 'dpe'),
    environment: handle.trace.environment,
    traceId: handle.trace.traceId,
    inboundRayId: handle.trace.inboundRayId,
    deploymentId: handle.trace.deploymentId,
    siteId: handle.trace.siteId,
    attempt: handle.trace.attempt,
    stage: handle.stage,
    operation: normalizeOperation(input.error?.operation) || normalizeOperation(input.operation) || handle.operation,
    status,
    startedAt: handle.startedAt,
    completedAt: new Date(completedMs).toISOString(),
    durationMs: completedMs - handle.startedMs,
    errorCode: normalizeErrorCode(input.errorCode),
    errorMessage: normalizeMessage(input.errorMessage),
    diagnostics,
    createdAt: new Date(completedMs).toISOString(),
  };

  try {
    if (typeof internal.store?.createDeploymentEvent !== 'function') throw new Error('DEPLOYMENT_EVENT_STORE_UNAVAILABLE');
    await internal.store.createDeploymentEvent(event);
  } catch {
    logTraceWriteFailure(internal, event);
  }
  return event;
}

export async function recordDeploymentStage(trace, input = {}) {
  const handle = startDeploymentStage(trace, input);
  return finishDeploymentStage(handle, input);
}

export function providerDiagnosticsFromError(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return {};
  return omitUndefined({
    causeClass: 'provider_error',
    httpStatus: normalizeHttpStatus(error.status),
    clientCode: normalizeClientCode(error.code),
    providerCode: normalizeProviderCode(error.providerCode),
    providerMessage: normalizeMessage(error.providerMessage) || undefined,
    providerRequestId: normalizeProviderRequestId(error.providerRequestId),
  });
}

function assertTraceContext(trace) {
  const internal = trace && traceInternals.get(trace);
  if (!internal) throw new Error('DEPLOYMENT_TRACE_CONTEXT_INVALID');
  return internal;
}

function assertStageHandle(handle) {
  if (!handle || !DEPLOYMENT_STAGES.has(handle.stage) || !Number.isFinite(handle.startedMs)) {
    throw new Error('DEPLOYMENT_TRACE_HANDLE_INVALID');
  }
  return assertTraceContext(handle.trace);
}

function normalizeRayId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return SAFE_RAY_ID_RE.test(normalized) && !containsUrl(normalized) && !hasCredentialText(normalized) ? normalized : null;
}

function normalizeEnvironment(value) {
  return value === 'production' || value === 'staging' || value === 'local' ? value : 'unknown';
}

function normalizeTraceOperation(value) {
  return value === 'deploy' || value === 'rollback' ? value : 'unknown';
}

function normalizeTraceId(value) {
  if (typeof value !== 'string') throw new Error('DEPLOYMENT_TRACE_ID_INVALID');
  const normalized = value.trim();
  if (!/^dtr_[A-Za-z0-9_-]{1,128}$/.test(normalized)) throw new Error('DEPLOYMENT_TRACE_ID_INVALID');
  return normalized;
}

function tryNormalizeTraceId(value) {
  try {
    return normalizeTraceId(value);
  } catch {
    return null;
  }
}

function normalizeInternalId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return SAFE_INTERNAL_ID_RE.test(normalized) && !hasCredentialText(normalized) ? normalized : null;
}

function normalizeStage(value) {
  return typeof value === 'string' && DEPLOYMENT_STAGES.has(value) ? value : null;
}

function normalizeOperation(value) {
  if (typeof value !== 'string' || !SAFE_OPERATION_RE.test(value)) return null;
  return !hasCredentialText(value) || SENSITIVE_OPERATION_ALLOWLIST.has(value) ? value : null;
}

function normalizeTerminalStatus(value) {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value) ? value : null;
}

function normalizeHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function normalizeClientCode(value) {
  return typeof value === 'string' && SAFE_CLIENT_CODE_RE.test(value) ? value : undefined;
}

function normalizeErrorCode(value) {
  return typeof value === 'string' && SAFE_ERROR_CODE_RE.test(value) && !hasCredentialText(value) ? value : null;
}

function normalizeProviderCode(value) {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return undefined;
  const normalized = String(value).trim();
  if (
    !normalized ||
    normalized.length > 64 ||
    hasControlCharacters(normalized) ||
    hasCredentialText(normalized) ||
    containsUrl(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeProviderRequestId(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return SAFE_RAY_ID_RE.test(normalized) && !containsUrl(normalized) && !hasCredentialText(normalized) ? normalized : undefined;
}

function normalizeMessage(value) {
  if (typeof value !== 'string') return null;
  if (hasCredentialText(value)) return null;
  const normalized = redactSensitiveText(value);
  return normalized ? normalized.slice(0, MAX_MESSAGE_LENGTH) : null;
}

function sanitizeDiagnostics(input) {
  if (!isPlainObject(input)) return null;
  const diagnostics = omitUndefined({
    causeClass: normalizeIdentifier(input.causeClass),
    httpStatus: normalizeHttpStatus(input.httpStatus),
    clientCode: normalizeClientCode(input.clientCode),
    providerCode: normalizeProviderCode(input.providerCode),
    providerMessage: normalizeMessage(input.providerMessage) || undefined,
    providerRequestId: normalizeProviderRequestId(input.providerRequestId),
    routePointerCommitted: typeof input.routePointerCommitted === 'boolean' ? input.routePointerCommitted : undefined,
    trafficImpact: normalizeIdentifier(input.trafficImpact),
    cleanupStatus: normalizeIdentifier(input.cleanupStatus),
    operatorAction: normalizeIdentifier(input.operatorAction),
    cleanupTaskId: normalizeInternalId(input.cleanupTaskId) || undefined,
    originalFailure: sanitizeOriginalFailure(input.originalFailure),
    compensation: sanitizeCompensation(input.compensation),
  });
  return Object.keys(diagnostics).length > 0 ? diagnostics : null;
}

function sanitizeOriginalFailure(value) {
  if (!isPlainObject(value)) return undefined;
  const result = omitUndefined({
    stage: normalizeStage(value.stage) || undefined,
    code: normalizeErrorCode(value.code) || undefined,
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeCompensation(value) {
  if (!isPlainObject(value)) return undefined;
  const result = omitUndefined({
    status: typeof value.status === 'string' && COMPENSATION_STATUSES.has(value.status) ? value.status : undefined,
    operation: normalizeOperation(value.operation) || undefined,
    httpStatus: normalizeHttpStatus(value.httpStatus),
    clientCode: normalizeClientCode(value.clientCode),
    providerCode: normalizeProviderCode(value.providerCode),
    providerMessage: normalizeMessage(value.providerMessage) || undefined,
    providerRequestId: normalizeProviderRequestId(value.providerRequestId),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER_RE.test(value) && !hasCredentialText(value) ? value : undefined;
}

function redactSensitiveText(value) {
  return replaceControlCharacters(value)
    .trim()
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:["']?)(?:api[-_ ]?key|token|secret|password)(?:["']?)\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[redacted]$2')
    .replace(/((?:["']?)(?:api[-_ ]?key|token|secret|password)(?:["']?)\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]')
    .replace(/(\b(?:api[-_ ]?key|token|secret|password)\s+)(["'])(.*?)\2/gi, '$1$2[redacted]$2')
    .replace(/(\b(?:api[-_ ]?key|token|secret|password)\s+)[^\s,;}]+/gi, '$1[redacted]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[redacted-url]');
}

function containsUrl(value) {
  return /\bhttps?:\/\//i.test(value);
}

function replaceControlCharacters(value) {
  let result = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    result += code <= 0x1f || code === 0x7f ? ' ' : character;
  }
  return result;
}

function hasControlCharacters(value) {
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasCredentialText(value) {
  if (JWT_LIKE_RE.test(String(value))) return true;
  const compact = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return (
    ['authorization', 'bearer', 'apikey', 'token', 'secret', 'password'].some((keyword) => compact.includes(keyword)) ||
    /\bbasic\s+[A-Za-z0-9+/=:-]+/i.test(value)
  );
}

function readNowMs(internal) {
  let value;
  try {
    value = internal.now ? internal.now() : Date.now();
  } catch {
    value = Date.now();
  }
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') value = Date.parse(value);
  return Number.isFinite(value) ? Math.trunc(value) : Date.now();
}

function logTraceWriteFailure(internal, event) {
  const payload = {
    event: 'pages_deployment_trace_write_failed',
    traceId: event.traceId,
    deploymentId: event.deploymentId,
    stage: event.stage,
    operation: event.operation,
    causeClass: 'event_store_error',
  };
  try {
    const logger =
      internal.logger ||
      (typeof internal.env?.logDeploymentTraceWriteFailed === 'function'
        ? internal.env.logDeploymentTraceWriteFailed
        : globalThis.console?.error);
    if (typeof logger === 'function') logger(JSON.stringify(payload));
  } catch {
    // Diagnostics must never replace the deployment result.
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function omitUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
