export function createDeploySiteResolutionPort(store) {
  return {
    getForActor: bindRequired(store, 'getSiteForUser'),
    findBySlug: bindOptional(store, 'findSiteBySlug'),
    getTeam: bindOptional(store, 'getTeam'),
    getTeamMember: bindOptional(store, 'getTeamMember'),
    supportsOwnerTransfer: typeof store?.transferSiteOwner === 'function',
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') throw new TypeError(`deploy site resolution port method is required: ${name}`);
  return target[name].bind(target);
}

function bindOptional(target, name) {
  return typeof target?.[name] === 'function' ? target[name].bind(target) : null;
}
