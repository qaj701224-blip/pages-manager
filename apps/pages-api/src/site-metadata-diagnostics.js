const ENVIRONMENTS = new Set(['production', 'staging', 'local']);
const OPERATIONS = new Set(['update_title', 'update_slug', 'update_title_and_slug', 'reconcile_candidate', 'reconcile_batch']);
const OUTCOMES = new Set(['ready', 'pending', 'conflict', 'failed', 'skipped', 'completed']);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,95}$/;

export function logSiteMetadataEvent(env, input = {}) {
  const payload = {
    event: 'pages_site_metadata_event',
    operation: allowedValue(OPERATIONS, input.operation),
    outcome: allowedValue(OUTCOMES, input.outcome),
    environment: allowedValue(ENVIRONMENTS, input.environment),
    traceId: safeId(input.traceId),
    siteId: safeId(input.siteId),
    slugRevision: safeCount(input.slugRevision),
    errorCode: safeErrorCode(input.errorCode),
    processed: safeCount(input.processed),
    ready: safeCount(input.ready),
    pending: safeCount(input.pending),
    failed: safeCount(input.failed),
  };

  try {
    const logger = typeof env?.logSiteMetadataEvent === 'function' ? env.logSiteMetadataEvent : globalThis.console?.log;
    if (typeof logger === 'function') logger(JSON.stringify(omitNull(payload)));
  } catch {
    // Diagnostics must never replace the metadata mutation or reconciliation result.
  }
}

function allowedValue(allowed, value) {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID_RE.test(value) ? value : null;
}

function safeErrorCode(value) {
  return typeof value === 'string' && SAFE_ERROR_CODE_RE.test(value) ? value : null;
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function omitNull(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}
