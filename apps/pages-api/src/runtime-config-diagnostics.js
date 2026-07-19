const OPERATIONS = new Set(['var_put', 'var_delete', 'secret_put', 'secret_delete', 'plain_text_sync', 'secret_sync']);
const ENVIRONMENTS = new Set(['production', 'staging', 'local']);
const STAGES = new Set([
  'capability_check',
  'lock_acquire',
  'route_state_read',
  'bindings_read',
  'revision_read',
  'mutation_batch',
  'post_commit_read',
  'provider_setup',
  'provider_sync',
  'unknown',
]);
const REASONS = new Set([
  'capability_unavailable',
  'schema_missing',
  'constraint_failed',
  'database_busy',
  'store_operation_failed',
  'provider_configuration_failed',
  'provider_request_failed',
  'unknown',
]);
const ERROR_CODES = new Set([
  'RUNTIME_CONFIG_UNSUPPORTED',
  'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
  'SECRET_ACTIVE_WORKER_SYNC_FAILED',
  'unknown',
]);
const SITE_ID_RE = /^site_[a-z0-9]{1,64}$/;
const diagnostics = new WeakMap();

export function logRuntimeConfigFailure(env, input = {}) {
  const payload = {
    event: 'pages_runtime_config_failure',
    operation: allowedValue(OPERATIONS, input.operation),
    environment: allowedValue(ENVIRONMENTS, input.environment),
    siteId: safeSiteId(input.siteId),
    stage: allowedValue(STAGES, input.stage),
    reason: allowedValue(REASONS, input.reason),
    errorCode: allowedValue(ERROR_CODES, input.errorCode),
  };

  try {
    const logger = typeof env?.logRuntimeConfigFailure === 'function' ? env.logRuntimeConfigFailure : globalThis.console?.error;
    if (typeof logger === 'function') logger(JSON.stringify(payload));
  } catch {
    // Diagnostics must never replace the API response.
  }
}

export function markRuntimeConfigError(error, { stage, reason } = {}) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
  const target = error;
  if (!diagnostics.has(target)) {
    diagnostics.set(target, {
      stage: allowedValue(STAGES, stage),
      reason: allowedValue(REASONS, reason || classifyStoreError(error)),
    });
  }
  return target;
}

export function readRuntimeConfigErrorDiagnostic(error, fallback = {}) {
  const diagnostic = error && (typeof error === 'object' || typeof error === 'function') ? diagnostics.get(error) : null;
  return {
    stage: allowedValue(STAGES, diagnostic?.stage || fallback.stage),
    reason: allowedValue(REASONS, diagnostic?.reason || fallback.reason),
  };
}

function classifyStoreError(error) {
  const message = readErrorText(error);
  if (/no such (?:table|column)/i.test(message)) return 'schema_missing';
  if (/constraint failed/i.test(message)) return 'constraint_failed';
  if (/(?:database is locked|database busy|sqlite_busy)/i.test(message)) return 'database_busy';
  return 'store_operation_failed';
}

function readErrorText(error) {
  try {
    const message = typeof error?.message === 'string' ? error.message : '';
    const cause = typeof error?.cause?.message === 'string' ? error.cause.message : '';
    return `${message}\n${cause}`;
  } catch {
    return '';
  }
}

function allowedValue(allowed, value) {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function safeSiteId(value) {
  return typeof value === 'string' && value.length <= 69 && SITE_ID_RE.test(value) ? value : 'unknown';
}
