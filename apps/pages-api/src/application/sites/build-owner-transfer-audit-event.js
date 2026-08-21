export function buildSiteOwnerTransferAuditEvent({
  id,
  environment,
  actor,
  site,
  target,
  source = 'api',
  createdAt,
}) {
  if (!id) throw new TypeError('audit event id is required');
  if (!environment) throw new TypeError('environment is required');
  if (!createdAt) throw new TypeError('createdAt is required');

  return {
    id,
    environment,
    traceId: null,
    eventType: 'site.owner.transfer',
    actorUserId: actor.userId || null,
    actorType: actor.type,
    siteId: site.id,
    routeId: site.route?.id || null,
    versionId: null,
    decision: 'allow',
    statusCode: 200,
    ipHash: null,
    userAgentHash: null,
    metadata: {
      siteSlug: site.slug,
      fromOwner: {
        type: site.ownerType || 'user',
        id: site.ownerId || site.ownerUserId,
      },
      toOwner: {
        type: target.ownerType,
        id: target.ownerId,
      },
      source,
    },
    createdAt,
  };
}
