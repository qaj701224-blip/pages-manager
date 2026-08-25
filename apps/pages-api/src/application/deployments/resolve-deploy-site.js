import { validateNewDeploymentSiteSlug } from '../../domain/deployments/site-resolution.js';
import { teamOwnerSupportsVisibility } from '../../domain/sites/access-policy.js';
import { actorCanTransferSiteOwnership } from '../../domain/sites/authorization.js';

export function createDeploySiteResolution({ sites, prepareSite }) {
  if (typeof sites?.getForActor !== 'function') throw new TypeError('sites.getForActor is required');
  if (typeof prepareSite !== 'function') throw new TypeError('prepareSite is required');

  return async function resolveDeploySite(command) {
    if (command.siteId) {
      const site = await sites.getForActor(command.siteId, command.actor.userId, command.actor, command.environment);
      if (!site) return failed('SITE_NOT_FOUND_BY_ID');
      return resolveTransferIfRequested(sites, site, command);
    }

    const bySlug = typeof sites.findBySlug === 'function' ? await sites.findBySlug(command.environment, command.siteSlug) : null;
    if (bySlug) {
      const site = await sites.getForActor(bySlug.id, command.actor.userId, command.actor, command.environment);
      if (!site) return failed('SITE_NOT_FOUND_BY_SLUG_SCOPE');
      return resolveTransferIfRequested(sites, site, command);
    }

    const slugValidation = validateNewDeploymentSiteSlug(command.siteSlug, command.environment);
    if (!slugValidation.ok) return slugValidation;
    return resolvePendingCreation(sites, prepareSite, command);
  };
}

async function resolveTransferIfRequested(sites, site, command) {
  if (!command.teamId) return succeeded(site);
  if (site.ownerType === 'team' && site.ownerId === command.teamId) return succeeded(site);
  if (!actorCanTransferSiteOwnership(command.actor, site)) return failed('DEPLOY_TRANSFER_FORBIDDEN_CURRENT');

  const target = await resolveTransferTeam(sites, command.actor, command.teamId, command.environment);
  if (!target.ok) return target;
  const nextVisibility = command.requestedVisibility || site.route?.visibility || site.defaultVisibility;
  if (!teamOwnerSupportsVisibility({ ownerType: 'team' }, nextVisibility)) {
    return failed('TEAM_OWNER_VISIBILITY_UNSUPPORTED');
  }
  if (!sites.supportsOwnerTransfer) return failed('SITE_TRANSFER_UNSUPPORTED');
  return succeeded({
    ...site,
    pendingOwnerTransfer: {
      ownerId: target.ownerId,
      visibility: command.requestedVisibility,
    },
  });
}

async function resolveTransferTeam(sites, actor, teamId, environment) {
  if (actor.type === 'access_key' && (actor.ownerType || 'user') === 'team') {
    if (actor.ownerId !== teamId || !actor.scopes.includes('deploy:site')) {
      return failed('DEPLOY_TRANSFER_FORBIDDEN_TARGET');
    }
    const team = typeof sites.getTeam === 'function' ? await sites.getTeam(teamId) : null;
    if (!team || team.environment !== environment || team.deletedAt) return failed('TEAM_NOT_FOUND');
    return { ok: true, ownerId: team.id, role: 'publisher' };
  }
  return resolveTeamOwner(sites, actor.userId, teamId, environment);
}

async function resolvePendingCreation(sites, prepareSite, command) {
  const { actor, teamId } = command;
  if (actor.type !== 'access_key' && teamId) return prepareTeamSite(sites, prepareSite, command);
  if (actor.type !== 'access_key') return failed('SITE_NOT_FOUND_BY_SLUG');
  if (actor.siteId) return failed('SITE_NOT_FOUND_BY_SLUG_SCOPE');
  if (!actor.scopes.includes('deploy:site')) return failed('DEPLOY_FORBIDDEN_SCOPE');

  const ownerType = actor.ownerType || 'user';
  const ownerId = actor.ownerId || actor.userId;
  const ownerUserId = ownerType === 'team' ? actor.userId : ownerId;
  if (teamId && ownerType === 'user') return prepareTeamSite(sites, prepareSite, command);
  if (teamId && (ownerType !== 'team' || ownerId !== teamId)) return failed('DEPLOY_FORBIDDEN_TEAM_OWNER');
  if (!ownerId || !ownerUserId) return failed('DEPLOY_FORBIDDEN_INACTIVE_OWNER');
  if (!teamOwnerSupportsVisibility({ ownerType }, command.visibility)) {
    return failed('TEAM_OWNER_VISIBILITY_UNSUPPORTED');
  }
  return succeeded(
    pendingSite(prepareSite, command, {
      ownerType,
      ownerId,
      ownerUserId,
    })
  );
}

async function prepareTeamSite(sites, prepareSite, command) {
  if (!teamOwnerSupportsVisibility({ ownerType: 'team' }, command.visibility)) {
    return failed('TEAM_OWNER_VISIBILITY_UNSUPPORTED');
  }
  const teamOwner = await resolveTeamOwner(sites, command.actor.userId, command.teamId, command.environment);
  if (!teamOwner.ok) return teamOwner;
  return succeeded(
    pendingSite(prepareSite, command, {
      ownerType: 'team',
      ownerId: teamOwner.ownerId,
      ownerUserId: command.actor.userId,
      managementRole: teamOwner.role,
    })
  );
}

async function resolveTeamOwner(sites, userId, teamId, environment) {
  if (!teamId) return failed('TEAM_REQUIRED');
  const team = await sites.getTeam(teamId);
  if (!team || team.environment !== environment) return failed('TEAM_NOT_FOUND');
  const member = await sites.getTeamMember({ teamId, userId });
  if (!member) return failed('TEAM_NOT_FOUND');
  if (member.role !== 'admin' && member.role !== 'publisher') return failed('TEAM_PUBLISHER_REQUIRED');
  return { ok: true, ownerId: team.id, role: member.role };
}

function pendingSite(prepareSite, command, owner) {
  const pendingSiteCreation = prepareSite({
    environment: command.environment,
    slug: command.siteSlug,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    ownerUserId: owner.ownerUserId,
    visibility: command.visibility,
    title: command.title ?? null,
  });
  return {
    id: pendingSiteCreation.id,
    slug: pendingSiteCreation.slug,
    ownerType: pendingSiteCreation.ownerType,
    ownerId: pendingSiteCreation.ownerId,
    ownerUserId: pendingSiteCreation.ownerUserId,
    siteUuid: pendingSiteCreation.siteUuid,
    defaultVisibility: pendingSiteCreation.defaultVisibility,
    environment: pendingSiteCreation.environment,
    managementRole: owner.managementRole || null,
    pendingSiteCreation,
  };
}

function succeeded(site) {
  return { ok: true, site };
}

function failed(code) {
  return { ok: false, error: { code } };
}
