export function createDeploymentRecord({ deploymentRecords, ids }) {
  if (typeof deploymentRecords?.createForIdempotency !== 'function') {
    throw new TypeError('deploymentRecords.createForIdempotency is required');
  }
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  async function createPending(command) {
    const input = {
      id: ids.next('dep'),
      environment: command.environment,
      actorId: command.actor.actorId,
      actorUserId: command.actor.userId,
      actorType: command.actor.type,
      source: command.source,
      siteId: command.siteId,
      operation: command.operation,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      traceId: command.traceId || null,
      visibility: command.visibility,
      previousVersionId: command.previousVersionId || null,
      status: 'pending',
      ...(command.versionId ? { versionId: command.versionId } : {}),
    };
    return deploymentRecords.createForIdempotency(input);
  }

  return { createPending };
}
