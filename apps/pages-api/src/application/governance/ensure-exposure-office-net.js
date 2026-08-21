export function createExposureOfficeNetVerification({ officeNet, audits, telemetry }) {
  if (typeof officeNet?.ensure !== 'function') throw new TypeError('officeNet.ensure is required');
  if (typeof audits?.record !== 'function') throw new TypeError('audits.record is required');
  if (typeof telemetry?.auditUnconfirmed !== 'function') {
    throw new TypeError('telemetry.auditUnconfirmed is required');
  }

  return { ensure };

  async function ensure(command) {
    if (command.exposure !== 'public') return null;

    const evidence = await officeNet.ensure({
      environment: command.environment,
      siteId: command.site.id,
      workerName: command.route.workerName || command.version?.workerName,
      executionProvider: command.route.executionProvider || command.version?.executionProvider,
      deploymentShape: command.version?.deploymentShape || 'inactive',
      exposure: command.exposure,
      signal: command.lease?.signal,
    });
    const verified = evidence?.status === 'verified';
    const stage = verified ? 'office_net_removed_verified' : 'office_net_not_applicable';
    try {
      await audits.record({
        id: `${command.operation.operationId}:${stage}`,
        environment: command.environment,
        traceId: command.operation.operationId,
        eventType: 'admin.site.exposure',
        actorUserId: command.actorUserId,
        actorType: 'platform_admin',
        siteId: command.site.id,
        routeId: command.route.id,
        versionId: command.version.id,
        decision: 'allow',
        statusCode: 200,
        metadata: {
          ...command.operation.auditMetadata,
          previousExposure: command.previousExposure,
          authorityExposure: command.previousExposure,
          effectiveExposure: null,
          officeNetBindingRemoved: verified,
          officeNetBindingVerified: verified,
          officeNetBindingNotApplicable: !verified,
          officeNetCheckReason: evidence?.reason || null,
          stage,
        },
        createdAt: command.operation.now,
      });
    } catch (cause) {
      telemetry.auditUnconfirmed({
        operationId: command.operation.operationId,
        siteId: command.site.id,
        environment: command.environment,
        stage,
        cause,
      });
    }
    return evidence;
  }
}
