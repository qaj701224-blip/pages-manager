export function createExposureUpdatePreparation({ audits, ids, clock }) {
  if (typeof audits?.record !== 'function') throw new TypeError('audits.record is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { prepare };

  async function prepare(command) {
    const operationId = ids.next('op');
    const now = clock.now();
    const previousExposure = command.site.route?.exposure || command.site.defaultExposure || 'internal';
    const auditMetadata = {
      operationId,
      siteSlug: command.site.slug,
      previousExposure,
      requestedExposure: command.exposure,
      reason: command.reason || null,
      source: 'console-admin',
    };
    try {
      await audits.record({
        id: `${operationId}:attempted`,
        environment: command.environment,
        traceId: operationId,
        eventType: 'admin.site.exposure',
        actorUserId: command.actorUserId,
        actorType: 'platform_admin',
        siteId: command.site.id,
        routeId: command.site.route?.id || null,
        decision: 'allow',
        statusCode: 202,
        metadata: { ...auditMetadata, stage: 'attempted' },
        createdAt: now,
      });
    } catch (cause) {
      return { ok: false, error: { reason: 'required_audit_failed', cause } };
    }
    return { ok: true, context: { operationId, now, auditMetadata } };
  }
}
