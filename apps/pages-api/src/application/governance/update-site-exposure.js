import { accessModeFromVisibility } from '@xd/pages-access-policy';

import { sitePolicyExpected } from '../../domain/sites/access-policy.js';

const SAFE_FAILURE_CODES = new Set([
  'SITE_POLICY_LOCKED',
  'SITE_POLICY_CONFLICT',
  'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED',
  'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
  'SITE_EXPOSURE_AUDIT_FAILED',
  'ROUTE_POLICY_REPAIR_REQUIRED',
  'ROUTE_SNAPSHOT_WRITE_FAILED',
]);

export function createSiteExposureUpdate({
  preparation,
  leases,
  sites,
  routes,
  versions,
  officeNet,
  policies,
  snapshots,
  audits,
  telemetry,
  clock,
}) {
  if (typeof preparation?.prepare !== 'function') throw new TypeError('preparation.prepare is required');
  if (typeof leases?.run !== 'function') throw new TypeError('leases.run is required');
  if (typeof sites?.get !== 'function') throw new TypeError('sites.get is required');
  if (typeof routes?.get !== 'function') throw new TypeError('routes.get is required');
  if (typeof versions?.get !== 'function') throw new TypeError('versions.get is required');
  if (typeof officeNet?.ensure !== 'function') throw new TypeError('officeNet.ensure is required');
  if (typeof policies?.update !== 'function') throw new TypeError('policies.update is required');
  if (typeof snapshots?.finalize !== 'function') throw new TypeError('snapshots.finalize is required');
  if (typeof audits?.record !== 'function') throw new TypeError('audits.record is required');
  if (typeof telemetry?.auditUnconfirmed !== 'function') {
    throw new TypeError('telemetry.auditUnconfirmed is required');
  }
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { execute };

  async function execute(command) {
    const prepared = await preparation.prepare(command);
    if (!prepared.ok) {
      return { ok: false, reason: 'required_audit_failed', error: prepared.error };
    }

    try {
      return await leases.run(
        { environment: command.environment, siteId: command.site.id },
        (lease) => updateUnderLease(command, prepared.context, lease)
      );
    } catch (error) {
      if (error?.exposureAuditRecorded) {
        return { ok: false, reason: 'repair_required', error: error.cause };
      }
      await recordFailureAudit(command, prepared.context, error);
      return { ok: false, reason: 'operation_failed', error };
    }
  }

  async function updateUnderLease(command, operation, lease) {
    const currentSite = await sites.get(command.site.id, command.environment);
    const currentRoute = await routes.get(command.site.id, command.environment);
    if (!currentSite || !currentRoute) return { ok: false, reason: 'site_not_found' };

    const currentExposure = currentRoute.exposure || currentSite.defaultExposure || 'internal';
    const currentAccessMode = currentRoute.accessMode || accessModeFromVisibility(currentRoute.visibility);
    const activeVersion = currentRoute.activeVersionId
      ? await versions.get(currentRoute.activeVersionId, command.environment)
      : null;
    if (command.exposure === 'public' && (!activeVersion || currentRoute.routeStatus !== 'active')) {
      return { ok: false, reason: 'public_route_inactive' };
    }

    if (command.exposure === 'public') {
      await officeNet.ensure({
        environment: command.environment,
        actorUserId: command.actorUserId,
        site: currentSite,
        route: currentRoute,
        version: activeVersion,
        lease,
        exposure: command.exposure,
        previousExposure: currentExposure,
        operation,
      });
    }

    const mutation = await policies.update({
      environment: command.environment,
      siteId: currentSite.id,
      exposure: command.exposure,
      accessMode: currentAccessMode,
      expected: sitePolicyExpected(currentRoute),
      lease,
      actorUserId: command.actorUserId,
      updatedAt: operation.now,
      auditEvent: policyCommittedAudit({ command, operation, currentSite, currentRoute, currentExposure, currentAccessMode }),
    });

    const finalization = await snapshots.finalize({
      environment: command.environment,
      actorUserId: command.actorUserId,
      currentSite,
      currentRoute,
      currentExposure,
      mutation,
      operation,
    });
    if (!finalization.ok) {
      throw repairRequiredError(finalization.error.cause);
    }

    let auditStatus = 'confirmed';
    try {
      await audits.record(
        effectiveSuccessAudit({
          command,
          operation,
          currentExposure,
          currentAccessMode,
          site: finalization.site,
          route: finalization.route,
        })
      );
    } catch (cause) {
      auditStatus = 'unconfirmed';
      telemetry.auditUnconfirmed({
        operationId: operation.operationId,
        siteId: finalization.site.id,
        environment: command.environment,
        cause,
      });
    }

    return {
      ok: true,
      access: {
        exposure: finalization.route.exposure,
        accessMode: finalization.route.accessMode,
        visibility: finalization.route.visibility,
        aclEntries: mutation.aclEntries || [],
        exposureReason:
          finalization.route.exposure === 'public' && command.reason
            ? { text: command.reason, changedAt: operation.now }
            : null,
      },
      auditStatus,
    };
  }

  async function recordFailureAudit(command, operation, error) {
    const code = safeFailureCode(error);
    const pointerConfirmed = error?.pointerConfirmed === true;
    try {
      const currentRoute = await routes.get(command.site.id, command.environment);
      await audits.record({
        id: `${operation.operationId}:failed`,
        environment: command.environment,
        traceId: operation.operationId,
        eventType: 'admin.site.exposure',
        actorUserId: command.actorUserId,
        actorType: 'platform_admin',
        siteId: command.site.id,
        routeId: currentRoute?.id || command.site.route?.id || null,
        decision: 'deny',
        statusCode: 503,
        metadata: {
          ...operation.auditMetadata,
          authorityExposure: currentRoute?.exposure || null,
          effectiveExposure: pointerConfirmed ? error.effectiveExposure || null : null,
          pointerConfirmed,
          failureCode: code,
          stage: pointerConfirmed ? 'partial_failed' : 'failed',
        },
        createdAt: clock.now(),
      });
    } catch {
      // Failure audit is best-effort and must never mask the operational error.
    }
  }
}

function policyCommittedAudit({ command, operation, currentSite, currentRoute, currentExposure, currentAccessMode }) {
  return {
    id: `${operation.operationId}:policy_committed`,
    environment: command.environment,
    traceId: operation.operationId,
    eventType: 'admin.site.exposure',
    actorUserId: command.actorUserId,
    actorType: 'platform_admin',
    siteId: currentSite.id,
    routeId: currentRoute.id,
    decision: 'allow',
    statusCode: 200,
    metadata: {
      ...operation.auditMetadata,
      previousExposure: currentExposure,
      authorityExposure: command.exposure,
      accessMode: currentAccessMode,
      activationState: 'pending_activation',
      stage: 'policy_committed',
    },
    createdAt: operation.now,
  };
}

function effectiveSuccessAudit({ command, operation, currentExposure, currentAccessMode, site, route }) {
  return {
    id: `${operation.operationId}:effective_success`,
    environment: command.environment,
    traceId: operation.operationId,
    eventType: 'admin.site.exposure',
    actorUserId: command.actorUserId,
    actorType: 'platform_admin',
    siteId: site.id,
    routeId: route.id,
    decision: 'allow',
    statusCode: 200,
    metadata: {
      ...operation.auditMetadata,
      previousExposure: currentExposure,
      authorityExposure: command.exposure,
      effectiveExposure: command.exposure,
      accessMode: currentAccessMode,
      pointerConfirmed: false,
      pointerWriteCommitted: true,
      stage: 'effective_success',
    },
    createdAt: operation.now,
  };
}

function safeFailureCode(error) {
  const code = error?.code || error?.message;
  return SAFE_FAILURE_CODES.has(code) ? code : 'SITE_EXPOSURE_UPDATE_FAILED';
}

function repairRequiredError(cause) {
  const error = new Error('ROUTE_POLICY_REPAIR_REQUIRED');
  error.code = 'ROUTE_POLICY_REPAIR_REQUIRED';
  error.exposureAuditRecorded = true;
  error.cause = cause;
  return error;
}
