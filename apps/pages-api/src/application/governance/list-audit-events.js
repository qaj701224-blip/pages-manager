const EXPOSURE_STAGE_ORDER = {
  attempted: 10,
  office_net_removed_verified: 20,
  office_net_not_applicable: 20,
  policy_committed: 30,
  effective_success: 40,
  compensated_failure: 80,
  partial_failed: 85,
  compensation_failed: 90,
  failed: 100,
};

export function createAuditEventsQuery({ audits, metadata }) {
  if (typeof audits?.list !== 'function') throw new TypeError('audits.list is required');
  if (typeof metadata?.sanitize !== 'function') throw new TypeError('metadata.sanitize is required');

  return { list };

  async function list(query) {
    const events = await audits.list({ environment: query.environment });
    return [...events].sort(compareAuditEvents).map((event) => projectAuditEvent(event, metadata.sanitize));
  }
}

function compareAuditEvents(left, right) {
  const leftTime = Date.parse(left.createdAt || '');
  const rightTime = Date.parse(right.createdAt || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;

  const leftOperationId = left.metadata?.operationId || '';
  const rightOperationId = right.metadata?.operationId || '';
  if (leftOperationId && leftOperationId === rightOperationId) {
    const leftStage = EXPOSURE_STAGE_ORDER[left.metadata?.stage] || 0;
    const rightStage = EXPOSURE_STAGE_ORDER[right.metadata?.stage] || 0;
    if (leftStage !== rightStage) return rightStage - leftStage;
  }
  return String(right.id || '').localeCompare(String(left.id || ''));
}

function projectAuditEvent(event, sanitizeMetadata) {
  return {
    id: event.id,
    eventType: event.eventType,
    traceId: event.traceId || null,
    actorUserId: event.actorUserId || null,
    actorType: event.actorType,
    actor: {
      type: event.actor?.type || event.actorType || null,
      userId: event.actor?.userId || event.actorUserId || null,
      displayName: event.actor?.displayName || null,
      email: event.actor?.email || null,
    },
    siteId: event.siteId || null,
    routeId: event.routeId || null,
    versionId: event.versionId || null,
    decision: event.decision,
    statusCode: event.statusCode ?? null,
    metadata: event.metadata == null ? null : sanitizeMetadata(event.metadata),
    createdAt: event.createdAt,
  };
}
