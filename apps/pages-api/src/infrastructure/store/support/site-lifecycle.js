export function createOwnerMember(siteId, ownerUserId, now) {
  return {
    siteId,
    userId: ownerUserId,
    role: 'owner',
    createdBy: ownerUserId,
    createdAt: now,
  };
}

export function createHostnameClaim(input, now) {
  return {
    id: input.id || `claim_${input.ownerRef || input.ownerId}`,
    environment: input.environment,
    hostname: String(input.hostname || '').toLowerCase(),
    normalizedSlug: input.normalizedSlug,
    hostnameFamily: input.hostnameFamily || hostnameFamilyForHostname(input.hostname),
    ownerSystem: input.ownerSystem,
    ownerId: input.ownerId,
    ownerRef: input.ownerRef || null,
    status: input.status || 'active',
    source: input.source,
    acquiredAt: input.acquiredAt || now,
    leaseExpiresAt: input.leaseExpiresAt || null,
    releasedAt: input.releasedAt || null,
    reuseHoldUntil: input.reuseHoldUntil || null,
    releaseReason: input.releaseReason || null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

export function hostnameFamilyForHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (value.endsWith('.workers.xd.team')) return 'workers';
  if (value.endsWith('.pages.xd.team')) return 'pages';
  return 'custom';
}

export function hostnameClaimOwnerMatches(existing, input) {
  return existing.ownerSystem === input.ownerSystem && existing.ownerId === input.ownerId;
}
