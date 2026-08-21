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

export function actorHasPublishScope(actor) {
  return actor?.type !== 'access_key' || actor.scopes.includes('deploy:site') || actor.scopes.includes('*');
}
