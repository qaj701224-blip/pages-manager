export function actorCanManageSite(actor, site) {
  if (!actor || !site) return false;
  if (actor.type === 'access_key') {
    if (actor.siteId && actor.siteId !== site.id) return false;
    if (!actorHasPublishScope(actor)) return false;
    const ownerType = actor.ownerType || 'user';
    const ownerId = actor.ownerId || actor.userId;
    if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === ownerId;
    if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
    return (site.ownerId || site.ownerUserId) === ownerId;
  }
  if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
  return (site.ownerId || site.ownerUserId) === actor.userId;
}

export function actorCanTransferSiteOwnership(actor, site) {
  if (!actor || !site) return false;
  if (actor.type === 'access_key') {
    if (actor.siteId && actor.siteId !== site.id) return false;
    if (!actorHasPublishScope(actor)) return false;
    if ((actor.ownerType || 'user') === 'team') return false;
  }
  if ((site.ownerType || 'user') === 'team') return site.managementRole === 'admin';
  const actorOwnerId = actor.type === 'access_key' ? actor.ownerId || actor.userId : actor.userId;
  return (site.ownerId || site.ownerUserId) === actorOwnerId;
}

export function actorHasPublishScope(actor) {
  return actor?.type !== 'access_key' || actor.scopes.includes('deploy:site') || actor.scopes.includes('*');
}

export function actorCanDeploySite(actor, site, requiredScope) {
  if (!site) return false;
  if (actor.type !== 'access_key') {
    if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
    return site.ownerUserId === actor.userId;
  }
  if (actor.siteId && actor.siteId !== site.id) return false;
  if (!actor.scopes.includes(requiredScope)) return false;
  const ownerType = actor.ownerType || 'user';
  const ownerId = actor.ownerId || actor.userId;
  if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === ownerId;
  if (site.ownerType === 'team') return site.managementRole === 'admin' || site.managementRole === 'publisher';
  return (site.ownerId || site.ownerUserId) === ownerId;
}

export function actorCanReadPublicSites(actor) {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim()) return false;
  if (actor.type === 'user') return true;
  if (actor.type !== 'access_key') return false;
  if ((actor.ownerType != null && actor.ownerType !== 'user') || actor.siteId != null) return false;
  const scopes = Array.isArray(actor.scopes) ? actor.scopes : [];
  return scopes.includes('read:site') || scopes.includes('*');
}

export function actorCanReadSite(actor, site) {
  if (actor.type !== 'access_key') return true;
  if (!actor.scopes.includes('read:site')) return false;
  if (!site || typeof site === 'string') return false;
  if (actor.siteId && actor.siteId !== site.id) return false;
  if (actor.siteId && !actor.ownerType && !actor.ownerId && !actor.userId) return actor.siteId === site.id;

  const ownerType = actor.ownerType || 'user';
  const ownerId = actor.ownerId || actor.userId;
  if (ownerType === 'team') return site.ownerType === 'team' && site.ownerId === ownerId;
  if ((site.ownerType || 'user') === 'user') return (site.ownerId || site.ownerUserId) === ownerId;
  if (site.ownerType === 'team') return Boolean(site.managementRole);
  return false;
}

export function actorCanReadSitesApi(actor, siteId) {
  if (actor.type !== 'access_key') return true;
  if (siteId && actor.siteId && actor.siteId !== siteId) return false;
  return actor.scopes.includes('read:site') || actor.scopes.includes('deploy:site') || actor.scopes.includes('*');
}

export function viewerCanPublishSite(site) {
  if (site.ownerType === 'user') return site.ownerId === site.currentUserId || site.ownerUserId === site.currentUserId;
  return site.managementRole === 'admin' || site.managementRole === 'publisher';
}

export function viewerCanAdminSite(site) {
  if (site.ownerType === 'user') return site.ownerId === site.currentUserId || site.ownerUserId === site.currentUserId;
  return site.managementRole === 'admin';
}
