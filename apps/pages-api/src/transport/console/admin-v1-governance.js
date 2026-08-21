import { jsonResponse } from '@xd/worker-kit';

import { createV1SitesQuery } from '../../application/governance/list-v1-sites.js';
import { createV1SiteRetirement } from '../../application/governance/retire-v1-sites.js';
import {
  formatV1SitesInventory,
  formatV1UnregisteredWorkers,
  readV1ReservedWorkerNames,
} from '../../admin-resource-governance.js';
import { jsonError, jsonOk, readJsonBody } from '../../http.js';
import { nextId } from '../../id.js';
import {
  createV1SitesAdminClient as createInfrastructureV1SitesAdminClient,
} from '../../infrastructure/integrations/legacy-v1/sites-admin-client.js';
import {
  cloudflareFailureCause,
  normalizeNullableString,
  normalizeRequiredString,
  readNow,
} from './admin-support.js';

const V1_SITE_BULK_RETIRE_LIMIT = 100;

function createV1SitesAdminClient(env = {}) {
  return createInfrastructureV1SitesAdminClient({
    client: env.V1_SITES_ADMIN_CLIENT,
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_API_TOKEN,
    namespaceId: env.PAGES_V1_SITES_KV_NAMESPACE_ID,
    zoneId: normalizeNullableString(env.PAGES_V1_ZONE_ID) || env.CF_ZONE_ID_NEW,
    environment: env.PUBLIC_ENVIRONMENT || env.PAGES_ENV || 'production',
    fetch: env.fetch || globalThis.fetch,
  });
}

export async function listAdminV1Sites(env, config, store) {
  const client = createV1SitesAdminClient(env);
  if (!client || typeof store.listActiveSiteSlugs !== 'function') {
    return jsonError('V1_SITES_UNSUPPORTED', 'Legacy v1 site inventory is unavailable.', 503, 'Configure v1 inventory access.');
  }
  try {
    const result = await createV1SitesQuery({
      inventory: {
        listSites: () => client.listSites(),
        listWorkers: () => client.listWorkers(),
      },
      sites: { listActiveSlugs: (query) => store.listActiveSiteSlugs(query) },
      projection: {
        formatSites: formatV1SitesInventory,
        formatUnregisteredWorkers: formatV1UnregisteredWorkers,
      },
    }).list({
      environment: config.environment,
      reservedWorkerNames: readV1ReservedWorkerNames(env),
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(
      'V1_SITES_READ_FAILED',
      'Legacy v1 site inventory could not be read.',
      502,
      `Cause: ${cloudflareFailureCause(error)}. Check Cloudflare credentials and retry.`
    );
  }
}

export async function retireAdminV1Site(env, config, store, session, siteName) {
  const client = createV1SitesAdminClient(env);
  if (
    !client ||
    typeof client.listSites !== 'function' ||
    client.retirementSupported === false ||
    typeof store.getHostnameClaim !== 'function' ||
    typeof store.releaseHostnameClaim !== 'function'
  ) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: siteName, workerName: null, hostname: null },
      'capability_check',
      'deny',
      503
    );
    return jsonError('V1_SITES_UNSUPPORTED', 'Legacy v1 site retirement is unavailable.', 503, 'Configure v1 inventory access.');
  }

  const outcome = await createV1SiteRetirementApplication({ env, store, client }).retire({
    name: siteName,
    environment: config.environment,
    actorUserId: session.user?.userId || session.userId || null,
    reservedWorkerNames: readV1ReservedWorkerNames(env),
    reuseHoldSeconds: readReuseHoldSeconds(env),
  });
  if (!outcome.ok) return v1RetireOperationError(outcome.errorCode, outcome.cause);
  const result = outcome.result;
  if (result.status === 'retired') return jsonOk({ result });
  const failure = v1RetireFailureDetails(result.errorCode, result.cause);
  return v1RetireError(result.stage, failure.code, failure.message, failure.status, failure.action, result);
}

export async function bulkRetireAdminV1Sites(request, env, config, store, session) {
  const client = createV1SitesAdminClient(env);
  if (
    !client ||
    typeof client.listSites !== 'function' ||
    client.retirementSupported === false ||
    typeof store.getHostnameClaim !== 'function' ||
    typeof store.releaseHostnameClaim !== 'function'
  ) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: null, workerName: null, hostname: null },
      'capability_check',
      'deny',
      503
    );
    return jsonError('V1_SITES_UNSUPPORTED', 'Legacy v1 site retirement is unavailable.', 503, 'Configure v1 inventory access.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: null, workerName: null, hostname: null },
      'request_validation',
      'deny',
      400
    );
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const names = normalizeV1SiteNames(body.names);
  if (!names || names.length === 0 || names.length > V1_SITE_BULK_RETIRE_LIMIT) {
    await recordV1RetireAuditSafe(
      store,
      env,
      config,
      session,
      { name: null, workerName: null, hostname: null },
      'request_validation',
      'deny',
      400
    );
  }
  if (!names) {
    return jsonError('V1_SITE_NAMES_INVALID', 'Legacy v1 site names are invalid.', 400, 'Send a non-empty names array.');
  }
  if (names.length === 0) {
    return jsonError('V1_SITE_NAMES_REQUIRED', 'Legacy v1 site names are required.', 400, 'Select at least one site.');
  }
  if (names.length > V1_SITE_BULK_RETIRE_LIMIT) {
    return jsonError('V1_SITE_BATCH_TOO_LARGE', 'Too many legacy v1 sites selected.', 400, 'Select at most 100 sites.');
  }

  const outcome = await createV1SiteRetirementApplication({ env, store, client }).retireBatch({
    names,
    environment: config.environment,
    actorUserId: session.user?.userId || session.userId || null,
    reservedWorkerNames: readV1ReservedWorkerNames(env),
    reuseHoldSeconds: readReuseHoldSeconds(env),
  });
  if (!outcome.ok) return v1RetireOperationError(outcome.errorCode, outcome.cause);

  return jsonOk({
    summary: outcome.summary,
    results: outcome.results.map(formatV1RetireResult),
  });
}

function createV1SiteRetirementApplication({ env, store, client }) {
  return createV1SiteRetirement({
    inventory: {
      listSites: () => client.listSites(),
      ...(typeof client.getSiteRecord === 'function'
        ? { getSiteRecord: (name) => client.getSiteRecord(name) }
        : {}),
      ...(typeof client.deleteSite === 'function' ? { deleteSite: (name) => client.deleteSite(name) } : {}),
    },
    workers:
      typeof client.deleteWorker === 'function'
        ? { delete: (command) => client.deleteWorker(command) }
        : {},
    routes:
      typeof client.unbindRoute === 'function'
        ? { unbind: (command) => client.unbindRoute(command) }
        : {},
    claims: {
      get: (hostname) => store.getHostnameClaim(hostname),
      release: (command) => store.releaseHostnameClaim(command),
    },
    audits: {
      record: (event) => writeV1RetireAudit(store, env, event),
    },
    clock: { now: () => readNow(env) },
  });
}

async function recordV1RetireAudit(store, env, config, session, site, stage, decision, statusCode) {
  return writeV1RetireAudit(store, env, {
    environment: config.environment,
    actorUserId: session.user?.userId || session.userId || null,
    site,
    stage,
    decision,
    statusCode,
  });
}

async function writeV1RetireAudit(store, env, event) {
  if (typeof store.recordAuditEvent !== 'function') throw new Error('V1_SITE_AUDIT_UNSUPPORTED');
  return store.recordAuditEvent({
    id: nextId(env, 'audit'),
    environment: event.environment,
    eventType: 'admin.v1_site_retire',
    actorUserId: event.actorUserId,
    actorType: 'platform_admin',
    decision: event.decision,
    statusCode: event.statusCode,
    metadata: {
      siteName: event.site.name,
      workerName: event.site.workerName,
      hostname: event.site.hostname,
      stage: event.stage,
    },
    createdAt: readNow(env),
  });
}

async function recordV1RetireAuditSafe(store, env, config, session, site, stage, decision, statusCode) {
  try {
    await recordV1RetireAudit(store, env, config, session, site, stage, decision, statusCode);
  } catch {}
}

function normalizeV1SiteNames(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const names = [];
  for (const item of value) {
    const name = normalizeRequiredString(item);
    if (!name) return null;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatV1RetireResult(result) {
  const failure = result.errorCode ? v1RetireFailureDetails(result.errorCode, result.cause) : null;
  return {
    name: result.name,
    status: result.status,
    ...(result.workerName ? { workerName: result.workerName } : {}),
    ...(result.hostname ? { hostname: result.hostname } : {}),
    ...(result.stage ? { stage: result.stage } : {}),
    ...(failure ? { error: { code: failure.code, message: failure.message, action: failure.action } } : {}),
  };
}

function v1RetireOperationError(code, cause) {
  if (code === 'V1_SITES_READ_FAILED') {
    return jsonError(
      code,
      'Legacy v1 site inventory could not be read.',
      502,
      'Check Cloudflare credentials and retry.'
    );
  }
  const failure = v1RetireFailureDetails(code, cause);
  return v1RetireError('metadata_read', failure.code, failure.message, failure.status, failure.action);
}

function v1RetireFailureDetails(code, cause) {
  if (code === 'V1_SITE_METADATA_READ_FAILED') {
    return failure(code, 'Legacy v1 site record could not be read.', 502, 'Check Cloudflare KV credentials and retry.');
  }
  if (code === 'V1_SITE_NOT_FOUND') {
    return failure(code, 'Legacy v1 site was not found.', 404, 'Refresh the v1 site inventory.');
  }
  if (code === 'V1_SITE_PLATFORM_RESERVED') {
    return failure(code, 'Platform-reserved Worker cannot be retired.', 409, 'Choose a user-owned v1 site.');
  }
  if (code === 'V1_SITE_SCRIPT_INVALID') {
    return failure(code, 'Legacy v1 site script metadata is invalid.', 409, 'Refresh the v1 site inventory.');
  }
  if (code === 'V1_SITE_ROUTE_UNSAFE') {
    return failure(
      code,
      'Legacy v1 hostname is missing or unsafe.',
      409,
      'Refresh the v1 site inventory and verify the hostname.'
    );
  }
  if (code === 'V1_SITES_UNSUPPORTED') {
    return failure(
      code,
      'Legacy v1 site retirement is unavailable.',
      503,
      'Configure Cloudflare account, zone, and KV access.'
    );
  }
  if (code === 'V1_SITE_HOSTNAME_CLAIM_READ_FAILED') {
    return failure(code, 'Legacy v1 hostname claim could not be read.', 502, 'Check hostname claims and retry.');
  }
  if (code === 'V1_SITE_HOSTNAME_CLAIM_UNSAFE') {
    return failure(
      code,
      'Legacy v1 hostname claim belongs to another resource.',
      409,
      'Review the hostname claim before retrying.'
    );
  }
  if (code === 'V1_SITE_AUDIT_FAILED') {
    return failure(code, 'V1 site retirement audit could not be written.', 500, 'Retry after checking the audit store.');
  }
  if (code === 'V1_SITE_WORKER_DELETE_FAILED') {
    return failure(
      code,
      'Legacy v1 Worker could not be deleted.',
      502,
      `Cause: ${cloudflareFailureCause(cause)}. Check Cloudflare credentials and retry.`
    );
  }
  if (code === 'V1_SITE_ROUTE_UNBIND_FAILED') {
    return failure(
      code,
      'Legacy v1 hostname route could not be unbound.',
      502,
      `Cause: ${cloudflareFailureCause(cause)}. Verify the exact route and retry.`
    );
  }
  if (code === 'V1_SITE_HOSTNAME_CLAIM_RELEASE_FAILED') {
    return failure(code, 'Legacy v1 hostname claim could not be released.', 502, 'Check hostname claims and retry.');
  }
  if (code === 'V1_SITE_KV_DELETE_FAILED') {
    return failure(
      code,
      'Legacy v1 site metadata could not be deleted.',
      502,
      `Cause: ${cloudflareFailureCause(cause)}. Check Cloudflare KV credentials and retry.`
    );
  }
  throw new Error('V1_SITE_RETIRE_RESULT_INVALID');
}

function failure(code, message, status, action) {
  return { code, message, status, action };
}

function v1RetireError(stage, code, message, status, action, result = null) {
  return jsonResponse(
    {
      error: { code, message, stage, ...(action ? { action } : {}) },
      ...(result ? { result: formatV1RetireResult(result) } : {}),
    },
    status,
    { 'Cache-Control': 'no-store' }
  );
}

function readReuseHoldSeconds(env) {
  const value = Number(env?.HOSTNAME_REUSE_HOLD_SECONDS || 300);
  return Number.isInteger(value) && value >= 0 && value <= 86_400 ? value : 300;
}
