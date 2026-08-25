import { normalizeSiteMetadataPatch, siteMetadataRoutingStatus } from '../../domain/sites/metadata.js';
import { authorizeSiteMutation } from './authorize-site-mutation.js';

const PASSTHROUGH_ERRORS = new Set([
  'SITE_METADATA_INVALID',
  'SITE_TITLE_INVALID',
  'SITE_SLUG_INVALID',
  'SITE_SLUG_RESERVED',
  'SITE_SLUG_CONFLICT',
]);
const CONFLICT_ERRORS = new Set(['SITE_METADATA_CONFLICT', 'SITE_POLICY_LOCKED', 'SITE_POLICY_CONFLICT', 'SITE_COMMIT_TIMEOUT']);

export function createUpdateSiteMetadata({ siteMetadata, routeSnapshots, hostnameForSlug, ids, clock, reuseHoldSeconds }) {
  assertMetadataDependencies({ siteMetadata, routeSnapshots, clock });
  if (typeof hostnameForSlug !== 'function') throw new TypeError('hostnameForSlug is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');
  assertReuseHoldSeconds(reuseHoldSeconds);

  return async function updateSiteMetadata(command) {
    const patch = normalizeSiteMetadataPatch(command.patch, { environment: command.environment });
    try {
      return await siteMetadata.withSiteCommitLock(
        command.environment,
        command.siteId,
        (lease) =>
          updateUnderLease({
            siteMetadata,
            routeSnapshots,
            hostnameForSlug,
            ids,
            clock,
            reuseHoldSeconds,
            command,
            patch,
            lease,
          }),
        { bestEffortRelease: true }
      );
    } catch (error) {
      throw mapMetadataError(error);
    }
  };
}

export function createReconcileSiteMetadataRouting({ siteMetadata, routeSnapshots, clock, reuseHoldSeconds, telemetry }) {
  assertMetadataDependencies({ siteMetadata, routeSnapshots, clock });
  assertReuseHoldSeconds(reuseHoldSeconds);

  return async function reconcileSiteMetadataRouting({ environment, limit = 50, traceId = null }) {
    const candidates = await siteMetadata.listSitesPendingSlugRouting(environment, { limit });
    const summary = { processed: 0, ready: 0, pending: 0, failed: 0 };
    for (const candidate of candidates) {
      summary.processed += 1;
      try {
        const attemptRecorded = await siteMetadata.markSiteSlugRoutingReconcileAttempted({
          environment,
          siteId: candidate.id,
          slugRevision: candidate.slugRevision,
          expectedAttemptedAt: candidate.slugRoutingReconcileAttemptedAt,
          attemptedAt: nextReconcileAttemptedAt(clock.now(), candidate.slugRoutingReconcileAttemptedAt),
        });
        if (!attemptRecorded) {
          summary.pending += 1;
          recordTelemetry(telemetry, {
            operation: 'reconcile_candidate',
            outcome: 'skipped',
            environment,
            traceId,
            siteId: candidate.id,
            slugRevision: candidate.slugRevision,
          });
          continue;
        }
        const result = await siteMetadata.withSiteCommitLock(
          environment,
          candidate.id,
          async (lease) => {
            const site = await siteMetadata.getSite(candidate.id, environment);
            const route = await siteMetadata.getRouteBySiteId(candidate.id, environment);
            if (!site || site.deletedAt || !route) return { skipped: true };
            const retiringClaims = await siteMetadata.listSiteRetiringHostnameClaims(site.id, { environment });
            return synchronizeRouting({
              siteMetadata,
              routeSnapshots,
              clock,
              reuseHoldSeconds,
              site,
              route,
              retiringClaims,
              environment,
              lease,
            });
          },
          { bestEffortRelease: true }
        );
        const outcome = result?.skipped ? 'skipped' : result?.routingStatus === 'ready' ? 'ready' : 'pending';
        if (outcome === 'ready') summary.ready += 1;
        else summary.pending += 1;
        recordTelemetry(telemetry, {
          operation: 'reconcile_candidate',
          outcome,
          environment,
          traceId,
          siteId: candidate.id,
          slugRevision: candidate.slugRevision,
        });
      } catch (error) {
        summary.failed += 1;
        recordTelemetry(telemetry, {
          operation: 'reconcile_candidate',
          outcome: 'failed',
          environment,
          traceId,
          siteId: candidate.id,
          slugRevision: candidate.slugRevision,
          errorCode: metadataErrorCode(error),
        });
      }
    }
    return summary;
  };
}

async function updateUnderLease({
  siteMetadata,
  routeSnapshots,
  hostnameForSlug,
  ids,
  clock,
  reuseHoldSeconds,
  command,
  patch,
  lease,
}) {
  const updatedAt = clock.now();
  const authorization = await authorizeSiteMutation({
    sites: siteMetadata,
    environment: command.environment,
    siteId: command.siteId,
    actor: command.actor,
    capability: command.capability,
    now: updatedAt,
  });
  const currentSite = authorization.site;
  const currentRoute = await siteMetadata.getRouteBySiteId(command.siteId, command.environment);
  if (!currentRoute) {
    throw applicationError('SITE_NOT_FOUND');
  }

  const mutation = await siteMetadata.commitSiteMetadata({
    environment: command.environment,
    siteId: command.siteId,
    ...patch,
    ...(Object.hasOwn(patch, 'slug') ? { hostname: hostnameForSlug(patch.slug) } : {}),
    expected: metadataExpected(currentSite, currentRoute),
    authorization: authorization.authorization,
    lease,
    auditEvent: buildMetadataAuditEvent({
      ids,
      command: { ...command, actor: authorization.actor },
      patch,
      currentSite,
      currentRoute,
      updatedAt,
    }),
    updatedAt,
  });

  if (!Object.hasOwn(patch, 'slug') || siteMetadataRoutingStatus(mutation.site) === 'ready') {
    return withRoutingStatus(mutation);
  }

  const routing = await synchronizeRouting({
    siteMetadata,
    routeSnapshots,
    clock,
    reuseHoldSeconds,
    site: mutation.site,
    route: mutation.route,
    retiringClaims: mutation.retiringClaims,
    environment: command.environment,
    lease,
  });
  return { ...mutation, site: routing.site, routingStatus: routing.routingStatus };
}

async function synchronizeRouting({
  siteMetadata,
  routeSnapshots,
  clock,
  reuseHoldSeconds,
  site,
  route,
  retiringClaims,
  environment,
  lease,
}) {
  const slugRevision = site.slugRevision;
  try {
    await routeSnapshots.repairCurrent({ site, route, environment });
  } catch {
    return { site, routingStatus: 'pending' };
  }

  let pending = false;
  for (const claim of retiringClaims) {
    try {
      const cleared = await routeSnapshots.clearRetired({ site, route, claim });
      if (!cleared) {
        pending = true;
        continue;
      }
      const completedAt = clock.now();
      const { releasedAt: cleanupToken } = claim;
      const released = await siteMetadata.completeSiteSlugRelease({
        environment,
        siteId: site.id,
        routeId: route.id,
        hostname: claim.hostname,
        slugRevision,
        cleanupToken,
        reuseHoldUntil: addSecondsIso(completedAt, reuseHoldSeconds),
        lease,
        completedAt,
      });
      if (!released) pending = true;
    } catch {
      pending = true;
    }
  }
  if (pending) return { site, routingStatus: 'pending' };

  try {
    const syncedSite = await siteMetadata.markSiteSlugRoutingSynced({
      environment,
      siteId: site.id,
      slugRevision,
      lease,
      syncedAt: clock.now(),
    });
    if (!syncedSite) return { site, routingStatus: 'pending' };
    return { site: syncedSite, routingStatus: 'ready' };
  } catch {
    return { site, routingStatus: 'pending' };
  }
}

function buildMetadataAuditEvent({ ids, command, patch, currentSite, currentRoute, updatedAt }) {
  const titleChanged = Object.hasOwn(patch, 'title') && patch.title !== currentSite.title;
  const slugChanged = Object.hasOwn(patch, 'slug') && patch.slug !== currentSite.slug;
  return {
    id: ids.next('audit'),
    environment: command.environment,
    traceId: command.traceId || null,
    eventType: 'site_metadata_updated',
    actorUserId: command.actor?.userId || null,
    actorType: command.actor?.type || 'user',
    siteId: currentSite.id,
    routeId: currentRoute.id,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: command.ipHash || null,
    userAgentHash: command.userAgentHash || null,
    metadata: {
      changedFields: [titleChanged ? 'title' : null, slugChanged ? 'slug' : null].filter(Boolean),
      oldSlug: currentSite.slug,
      newSlug: slugChanged ? patch.slug : currentSite.slug,
      titleCleared: titleChanged && patch.title === null,
      source: command.source || 'api',
      slugRevision: currentSite.slugRevision + (slugChanged ? 1 : 0),
    },
    createdAt: updatedAt,
  };
}

function metadataExpected(site, route) {
  return {
    slugRevision: site.slugRevision,
    routeGeneration: route.routeGeneration,
    policyVersion: route.policyVersion,
    activeVersionId: route.activeVersionId,
    runtimeConfigGeneration: route.runtimeConfigGeneration,
  };
}

function withRoutingStatus(mutation) {
  return { ...mutation, routingStatus: siteMetadataRoutingStatus(mutation.site) };
}

function assertMetadataDependencies({ siteMetadata, routeSnapshots, clock }) {
  if (!siteMetadata || typeof siteMetadata !== 'object') throw new TypeError('siteMetadata port is required');
  for (const name of [
    'withSiteCommitLock',
    'getSite',
    'getSiteForUser',
    'getAccessKeyById',
    'getUser',
    'getTeam',
    'isPlatformAdmin',
    'getRouteBySiteId',
    'listSiteRetiringHostnameClaims',
    'listSitesPendingSlugRouting',
    'markSiteSlugRoutingReconcileAttempted',
    'commitSiteMetadata',
    'completeSiteSlugRelease',
    'markSiteSlugRoutingSynced',
  ]) {
    if (typeof siteMetadata[name] !== 'function') throw new TypeError(`siteMetadata.${name} is required`);
  }
  if (typeof routeSnapshots?.repairCurrent !== 'function') throw new TypeError('routeSnapshots.repairCurrent is required');
  if (typeof routeSnapshots?.clearRetired !== 'function') throw new TypeError('routeSnapshots.clearRetired is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');
}

function assertReuseHoldSeconds(value) {
  if (!Number.isInteger(value) || value < 0 || value > 86_400) {
    throw new TypeError('reuseHoldSeconds must be an integer between 0 and 86400');
  }
}

function addSecondsIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function nextReconcileAttemptedAt(now, previous) {
  const nowMillis = Date.parse(now);
  const previousMillis = Date.parse(previous || '');
  if (!Number.isFinite(previousMillis) || previousMillis < nowMillis) return now;
  return new Date(previousMillis + 1).toISOString();
}

function mapMetadataError(error) {
  const code = error?.code || error?.message;
  if (PASSTHROUGH_ERRORS.has(code) || code === 'SITE_NOT_FOUND') return error;
  if (code === 'SITE_METADATA_NOT_FOUND') return applicationError('SITE_NOT_FOUND');
  if (CONFLICT_ERRORS.has(code)) return applicationError('SITE_METADATA_CONFLICT');
  return applicationError('SITE_METADATA_UPDATE_FAILED');
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function recordTelemetry(telemetry, event) {
  try {
    telemetry?.record?.(event);
  } catch {
    // Telemetry must never replace the reconciliation result.
  }
}

function metadataErrorCode(error) {
  const code = error?.code || error?.message;
  return typeof code === 'string' ? code : 'SITE_METADATA_UPDATE_FAILED';
}
