import { newId } from '../id.js';
import {
  cleanupLegacyV1WorkerScript,
  detachLegacyV1CloudflareRoute,
  restoreLegacyV1CloudflareRoute,
} from './cloudflare-cleanup.js';
import { resolveLegacyV1SiteTarget } from './ownership.js';

export async function createSiteWithLegacyV1Takeover({ env, config, store, actor, siteInput }) {
  let originalError;
  try {
    return await store.createSite(siteInput);
  } catch (error) {
    if (errorCode(error) !== 'HOSTNAME_CLAIM_CONFLICT') throw error;
    originalError = error;
  }

  const claim = await store.getHostnameClaim(siteInput.hostname);
  if (!claim || claim.ownerSystem !== 'v1' || claim.status !== 'active') throw originalError;
  if (!env?.V1_SITES || typeof env.V1_SITES.get !== 'function' || typeof env.V1_SITES.delete !== 'function') {
    throw takeoverError('V1_TAKEOVER_CONFIG_UNAVAILABLE');
  }
  if (
    !env.V1_CLOUDFLARE_CLIENT &&
    (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.CF_ZONE_ID_NEW || typeof (env.fetch || globalThis.fetch) !== 'function')
  ) {
    throw takeoverError('V1_TAKEOVER_CONFIG_UNAVAILABLE');
  }

  let target;
  try {
    target = await resolveLegacyV1SiteTarget({
      sites: env.V1_SITES,
      actor,
      claim,
      environment: config.environment,
      slug: siteInput.slug,
      hostname: siteInput.hostname,
    });
  } catch (error) {
    if (errorCode(error) === 'HOSTNAME_CLAIM_CONFLICT') throw error;
    throw takeoverError('V1_TAKEOVER_CONFIG_UNAVAILABLE');
  }

  const cleanupPlan = await detachLegacyV1CloudflareRoute({ env, config, target });

  let latestTarget;
  try {
    latestTarget = await resolveLegacyV1SiteTarget({
      sites: env.V1_SITES,
      actor,
      claim,
      environment: config.environment,
      slug: siteInput.slug,
      hostname: siteInput.hostname,
    });
  } catch (error) {
    const mappedError =
      errorCode(error) === 'HOSTNAME_CLAIM_CONFLICT'
        ? takeoverError('V1_TAKEOVER_STATE_CHANGED')
        : takeoverError('V1_TAKEOVER_CONFIG_UNAVAILABLE');
    await restoreRouteIfClaimUnchanged({ env, config, store, claim, target, cleanupPlan });
    throw mappedError;
  }
  if (!sameTarget(target, latestTarget)) {
    await restoreRouteIfClaimUnchanged({ env, config, store, claim, target, cleanupPlan });
    throw takeoverError('V1_TAKEOVER_STATE_CHANGED');
  }

  const auditEvent = {
    id: nextId(env, 'aud'),
    environment: config.environment,
    traceId: null,
    eventType: 'site.v1_takeover',
    actorUserId: actor?.userId || null,
    actorType: actor?.type || 'user',
    siteId: siteInput.id,
    routeId: siteInput.routeId,
    versionId: null,
    decision: 'allow',
    statusCode: 201,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      source: 'v1_email_takeover',
      previousOwnerSystem: 'v1',
    },
    createdAt: readNow(env),
  };

  let site;
  try {
    site = await store.createSiteByTakingOverV1Claim({ ...siteInput, auditEvent }, claim, config.environment);
  } catch (error) {
    await restoreRouteIfClaimUnchanged({ env, config, store, claim, target, cleanupPlan });
    throw error;
  }

  const cloudflareCleanup = await cleanupLegacyV1WorkerScript({ env, config, target, cleanupPlan });

  if (cloudflareCleanup.workerCleanup !== 'deleted') {
    await deferLegacyV1WorkerCleanup({
      env,
      config,
      store,
      siteInput,
      target,
      workerCleanup: cloudflareCleanup.workerCleanup,
    });
  }

  try {
    await env.V1_SITES.delete(siteInput.slug);
  } catch {
    await deferLegacyV1KvCleanup({ env, config, store, siteInput });
  }

  return site;
}

async function restoreRouteIfClaimUnchanged({ env, config, store, claim, target, cleanupPlan }) {
  if (!cleanupPlan.routeDetached) return;
  let latestClaim;
  try {
    latestClaim = await store.getHostnameClaim(target.hostname);
  } catch {
    throw takeoverError('V1_TAKEOVER_CLEANUP_FAILED');
  }
  if (!sameClaimSnapshot(claim, latestClaim)) return;
  try {
    await restoreLegacyV1CloudflareRoute({ env, config, target, cleanupPlan });
  } catch {
    throw takeoverError('V1_TAKEOVER_CLEANUP_FAILED');
  }
}

async function deferLegacyV1WorkerCleanup({ env, config, store, siteInput, target, workerCleanup }) {
  if (typeof store.createDeploymentResourceCleanupTask !== 'function') return;
  const cleanupReason =
    workerCleanup === 'deferred_shared_route'
      ? 'v1_email_takeover_shared_route'
      : 'v1_email_takeover_worker_delete_failed';
  try {
    await store.createDeploymentResourceCleanupTask({
      id: nextId(env, 'cleanup'),
      environment: config.environment,
      resourceType: 'v1_worker_script',
      resourceRef: target.scriptName,
      siteId: siteInput.id,
      cleanupReason,
      status: 'pending',
      cleanupAfter: readNow(env),
    });
  } catch {
    // The exact v1 route is already removed; operators can reconcile the unreferenced Worker later.
  }
}

async function deferLegacyV1KvCleanup({ env, config, store, siteInput }) {
  if (typeof store.createDeploymentResourceCleanupTask !== 'function') return;
  try {
    await store.createDeploymentResourceCleanupTask({
      id: nextId(env, 'cleanup'),
      environment: config.environment,
      resourceType: 'v1_sites_kv_record',
      resourceRef: siteInput.slug,
      siteId: siteInput.id,
      cleanupReason: 'v1_email_takeover_kv_delete',
      status: 'pending',
      cleanupAfter: readNow(env),
    });
  } catch {
    // The v2 site is already committed; the next operator retry can remove the stale KV record.
  }
}

function errorCode(error) {
  return error?.code || error?.message || '';
}

function takeoverError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sameTarget(left, right) {
  return (
    left.environment === right.environment &&
    left.slug === right.slug &&
    left.hostname === right.hostname &&
    left.routePattern === right.routePattern &&
    left.scriptName === right.scriptName &&
    left.claimOwnerId === right.claimOwnerId &&
    left.claimOwnerRef === right.claimOwnerRef
  );
}

function sameClaimSnapshot(left, right) {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      left.environment === right.environment &&
      left.hostname === right.hostname &&
      left.normalizedSlug === right.normalizedSlug &&
      left.hostnameFamily === right.hostnameFamily &&
      left.ownerSystem === 'v1' &&
      right.ownerSystem === 'v1' &&
      left.ownerId === right.ownerId &&
      (left.ownerRef || null) === (right.ownerRef || null) &&
      left.status === 'active' &&
      right.status === 'active' &&
      (left.createdAt || null) === (right.createdAt || null)
  );
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  return newId(prefix);
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
