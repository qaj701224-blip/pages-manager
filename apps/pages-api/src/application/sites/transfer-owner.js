import { teamOwnerSupportsVisibility } from '../../domain/sites/access-policy.js';
import { actorCanTransferSiteOwnership } from '../../domain/sites/authorization.js';
import { authorizeSiteMutation } from './authorize-site-mutation.js';

export function createTransferSiteOwner({ siteOwnership, routeSnapshots, clock }) {
  if (!siteOwnership || typeof siteOwnership !== 'object') throw new TypeError('siteOwnership port is required');
  for (const name of [
    'withSiteCommitLock',
    'getSite',
    'getSiteForUser',
    'getAccessKeyById',
    'getUser',
    'getTeam',
    'isPlatformAdmin',
    'getTeamMember',
    'getRouteBySiteId',
  ]) {
    if (typeof siteOwnership[name] !== 'function') throw new TypeError(`siteOwnership.${name} is required`);
  }
  if (typeof routeSnapshots?.refreshActive !== 'function') throw new TypeError('routeSnapshots.refreshActive is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return async function transferSiteOwner(command) {
    if (typeof siteOwnership.transferSiteOwner !== 'function') throw applicationError('SITE_TRANSFER_UNSUPPORTED');
    return siteOwnership.withSiteCommitLock(
      command.environment,
      command.site.id,
      async (lease) => {
        const updatedAt = clock.now();
        const authorization = await authorizeSiteMutation({
          sites: siteOwnership,
          environment: command.environment,
          siteId: command.site.id,
          actor: command.actor,
          capability: command.capability,
          now: updatedAt,
        });
        const currentSite = authorization.site;

        const expectedOwner = ownerAuthority(command.site);
        const currentOwner = ownerAuthority(currentSite);
        if (expectedOwner.ownerType !== currentOwner.ownerType || expectedOwner.ownerId !== currentOwner.ownerId) {
          throw applicationError('SITE_POLICY_CONFLICT');
        }
        if (command.target.ownerType === currentOwner.ownerType && command.target.ownerId === currentOwner.ownerId) {
          throw applicationError('SITE_TRANSFER_INVALID');
        }
        if (command.capability !== 'platform_admin' && !actorCanTransferSiteOwnership(authorization.actor, currentSite)) {
          throw applicationError('SITE_NOT_FOUND');
        }

        const route = await siteOwnership.getRouteBySiteId(currentSite.id, command.environment);
        if (!route) throw applicationError('SITE_NOT_FOUND');
        if (!teamOwnerSupportsVisibility(command.target, route.visibility || currentSite.defaultVisibility)) {
          throw applicationError('SITE_POLICY_CONFLICT');
        }
        await authorizeSiteTransferTarget(siteOwnership, command, authorization.actor);

        const updated = await siteOwnership.transferSiteOwner(
          command.site.id,
          {
            ownerType: command.target.ownerType,
            ownerId: command.target.ownerId,
            ownerUserId: command.target.ownerUserId,
            updatedAt,
            expected: currentOwner,
            expectedRoute: routeAuthority(route),
            bumpPolicyVersion: true,
            authorization: ownershipTransferAuthorization(authorization.authorization),
            targetUserMustMatchActor: command.targetUserMustMatchActor,
            lease,
            ...(command.buildAuditEvent
              ? { auditEvent: command.buildAuditEvent(updatedAt, { ...command.site, ...currentSite }) }
              : {}),
          },
          command.environment
        );
        if (!updated) throw applicationError('SITE_NOT_FOUND');
        let committedRoute = null;
        try {
          committedRoute = await siteOwnership.getRouteBySiteId(currentSite.id, command.environment);
        } catch {
          // The owner and policy version are already committed. Clear any older pointer so a
          // transient authority read failure cannot keep serving the previous owner's policy.
        }
        if (!committedRoute) {
          await clearCurrentRoutePointer(routeSnapshots, {
            site: updated,
            route: routeAfterOwnerTransfer(route),
          });
          throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
        }

        try {
          await routeSnapshots.refreshActive({ site: updated, route: committedRoute, environment: command.environment });
        } catch (error) {
          if (command.compensateSnapshotFailure) {
            try {
              await compensateSnapshotFailure({
                siteOwnership,
                routeSnapshots,
                previousSite: currentSite,
                updatedSite: updated,
                committedRoute,
                updatedAt,
                environment: command.environment,
                lease,
              });
            } catch (compensationError) {
              throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED', compensationError);
            }
          }
          throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED', error);
        }
        return { site: updated, route: committedRoute };
      },
      { bestEffortRelease: true }
    );
  };
}

function ownershipTransferAuthorization(authorization) {
  return { ...authorization, operation: 'site_owner_transfer' };
}

export async function authorizeSiteTransferTarget(siteOwnership, command, actor) {
  if (command.target.ownerType === 'user') {
    const user = await siteOwnership.getUser(command.target.ownerId);
    if (!user || user.employeeStatus !== 'active') throw applicationError('SITE_POLICY_CONFLICT');
    if (command.targetUserMustMatchActor && command.target.ownerId !== actor?.userId) {
      throw applicationError('SITE_NOT_FOUND');
    }
    if (command.capability !== 'platform_admin' && actor?.type === 'access_key' && actor.ownerType === 'team') {
      throw applicationError('SITE_NOT_FOUND');
    }
    return;
  }

  const team = await siteOwnership.getTeam(command.target.ownerId);
  if (!team || team.environment !== command.environment || team.deletedAt || (team.status && team.status !== 'active')) {
    throw applicationError('SITE_POLICY_CONFLICT');
  }
  if (command.capability === 'platform_admin') return;
  if (actor?.type === 'access_key' && actor.ownerType === 'team') {
    if (actor.ownerId !== team.id) throw applicationError('SITE_NOT_FOUND');
    return;
  }
  const member = actor?.userId ? await siteOwnership.getTeamMember({ teamId: team.id, userId: actor.userId }) : null;
  if (!member || (member.role !== 'admin' && member.role !== 'publisher')) {
    throw applicationError('SITE_NOT_FOUND');
  }
}

async function compensateSnapshotFailure({
  siteOwnership,
  routeSnapshots,
  previousSite,
  updatedSite,
  committedRoute,
  updatedAt,
  environment,
  lease,
}) {
  let restoredSite = null;
  let restoredRoute = committedRoute;
  try {
    restoredSite = await restorePreviousOwner(
      siteOwnership,
      previousSite,
      updatedSite,
      committedRoute,
      updatedAt,
      environment,
      lease
    );
    if (!restoredSite) throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
    restoredRoute = await siteOwnership.getRouteBySiteId(previousSite.id, environment);
    if (!restoredRoute) throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
    await routeSnapshots.refreshActive({ site: restoredSite, route: restoredRoute, environment });
    return;
  } catch {
    await clearCurrentRoutePointer(routeSnapshots, {
      site: restoredSite || updatedSite,
      route: restoredRoute,
    });
    throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
  }
}

async function restorePreviousOwner(siteOwnership, previousSite, updatedSite, committedRoute, updatedAt, environment, lease) {
  const ownerType = previousSite.ownerType || 'user';
  const ownerId = previousSite.ownerId || previousSite.ownerUserId;
  const ownerUserId = previousSite.ownerUserId || (ownerType === 'user' ? ownerId : null);
  if (!ownerId) return null;
  return siteOwnership.transferSiteOwner(
    previousSite.id,
    {
      ownerType,
      ownerId,
      ownerUserId,
      defaultVisibility: previousSite.defaultVisibility,
      updatedAt,
      expected: ownerAuthority(updatedSite),
      expectedRoute: routeAuthority(committedRoute),
      bumpPolicyVersion: true,
      lease,
    },
    environment
  );
}

async function clearCurrentRoutePointer(routeSnapshots, input) {
  if (typeof routeSnapshots?.clearCurrent !== 'function') return false;
  try {
    return (await routeSnapshots.clearCurrent(input)) === true;
  } catch {
    return false;
  }
}

function ownerAuthority(site) {
  return {
    ownerType: site.ownerType || 'user',
    ownerId: site.ownerId || site.ownerUserId,
  };
}

function routeAuthority(route) {
  return {
    id: route.id,
    routeGeneration: route.routeGeneration,
    policyVersion: route.policyVersion,
    activeVersionId: route.activeVersionId,
    runtimeConfigGeneration: route.runtimeConfigGeneration,
    visibility: route.visibility,
  };
}

function routeAfterOwnerTransfer(route) {
  return {
    ...route,
    policyVersion: route.policyVersion + 1,
  };
}

function applicationError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
