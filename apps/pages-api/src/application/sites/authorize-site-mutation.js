import { actorCanManageSite } from '../../domain/sites/authorization.js';

export async function authorizeSiteMutation({ sites, environment, siteId, actor, capability, now }) {
  if (capability === 'platform_admin') {
    const activeAdmin =
      actor?.userId &&
      (await sites.isPlatformAdmin({ environment, userId: actor.userId })) &&
      (await actorIsActiveUser(sites, actor.userId));
    if (!activeAdmin) throw applicationError('SITE_NOT_FOUND');
    const site = await sites.getSite(siteId, environment);
    if (!isCurrentSite(site, environment)) throw applicationError('SITE_NOT_FOUND');
    return {
      site,
      actor,
      authorization: { kind: 'platform_admin', actorUserId: actor.userId },
    };
  }

  const resolved = await resolveCurrentActor(sites, actor, environment, now);
  const currentActor = resolved.actor;
  const site = await sites.getSiteForUser(siteId, currentActor?.userId, currentActor, environment);
  if (!isCurrentSite(site, environment)) throw applicationError('SITE_NOT_FOUND');
  if (!(await siteOwnerIsActive(sites, site, environment))) throw applicationError('SITE_NOT_FOUND');
  if (!actorCanManageSite(currentActor, site)) throw applicationError('SITE_NOT_FOUND');
  return { site, actor: currentActor, authorization: resolved.authorization };
}

async function resolveCurrentActor(sites, actor, environment, now) {
  if (!actor?.tokenId) {
    if (!actor?.userId || !(await actorIsActiveUser(sites, actor.userId))) {
      throw applicationError('SITE_NOT_FOUND');
    }
    return {
      actor,
      authorization: { kind: 'user', actorUserId: actor.userId },
    };
  }

  const accessKey = await sites.getAccessKeyById(actor.tokenId, environment);
  if (!accessKey || accessKey.revokedAt || isExpired(accessKey, now)) {
    throw applicationError('SITE_NOT_FOUND');
  }

  const ownerType = accessKey.ownerType || 'user';
  const ownerId = accessKey.ownerId || accessKey.ownerUserId;
  const owner = await getActiveAccessKeyOwner(sites, { ownerType, ownerId, environment });
  if (!owner) throw applicationError('SITE_NOT_FOUND');
  if (actor.type !== 'access_key') {
    if (
      accessKey.issuedSource !== 'cli_login' ||
      ownerType !== 'user' ||
      (Number.isInteger(accessKey.issuedSessionVersion) &&
        accessKey.issuedSessionVersion > 0 &&
        accessKey.issuedSessionVersion !== owner.sessionVersion)
    ) {
      throw applicationError('SITE_NOT_FOUND');
    }
    const currentActor = {
      ...actor,
      actorId: ownerId,
      userId: ownerId,
      tokenId: accessKey.id,
      scopes: ['*'],
    };
    return {
      actor: currentActor,
      authorization: {
        kind: 'cli_login',
        actorUserId: ownerId,
        accessKeyId: accessKey.id,
      },
    };
  }
  const currentActor = {
    ...actor,
    actorId: accessKey.id,
    tokenId: accessKey.id,
    userId: ownerType === 'user' ? ownerId : accessKey.createdByUserId || accessKey.ownerUserId || actor.userId || null,
    ownerType,
    ownerId,
    scopes: [...accessKey.scopes],
    siteId: accessKey.siteId || null,
  };
  return {
    actor: currentActor,
    authorization: {
      kind: 'access_key',
      actorUserId: currentActor.userId,
      accessKeyId: accessKey.id,
      ownerType,
      ownerId,
    },
  };
}

async function getActiveAccessKeyOwner(sites, { ownerType, ownerId, environment }) {
  if (!ownerId) return null;
  if (ownerType === 'user') {
    const user = await sites.getUser(ownerId);
    return user?.employeeStatus === 'active' ? user : null;
  }
  if (ownerType === 'team') {
    const team = await sites.getTeam(ownerId);
    return team && team.environment === environment && !team.deletedAt && team.status === 'active' ? team : null;
  }
  return null;
}

async function actorIsActiveUser(sites, userId) {
  const user = await sites.getUser(userId);
  return Boolean(user) && user.employeeStatus === 'active';
}

async function siteOwnerIsActive(sites, site, environment) {
  if ((site.ownerType || 'user') !== 'team') return true;
  const team = await sites.getTeam(site.ownerId);
  return Boolean(team && team.environment === environment && team.status === 'active' && !team.deletedAt);
}

function isCurrentSite(site, environment) {
  return Boolean(site) && !site.deletedAt && site.environment === environment;
}

function isExpired(accessKey, now) {
  return Boolean(accessKey.expiresAt && now && accessKey.expiresAt <= now);
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
