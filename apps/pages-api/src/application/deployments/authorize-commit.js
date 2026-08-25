import { authorizeSiteMutation } from '../sites/authorize-site-mutation.js';
import { authorizeSiteTransferTarget } from '../sites/transfer-owner.js';
import { actorCanTransferSiteOwnership } from '../../domain/sites/authorization.js';

export function createAuthorizeDeploymentCommit({ sites, clock }) {
  if (!sites || typeof sites !== 'object') throw new TypeError('sites port is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { authorize };

  async function authorize(command) {
    const authorization = await authorizeSiteMutation({
      sites,
      environment: command.environment,
      siteId: command.siteId,
      actor: command.actor,
      now: clock.now(),
    });
    assertExpectedSite(authorization.site, command.expectedSite);

    if (command.ownerTransfer) {
      const target = {
        ownerType: 'team',
        ownerId: command.ownerTransfer.ownerId,
        ownerUserId: authorization.actor.userId || authorization.site.ownerUserId,
      };
      if (!actorCanTransferSiteOwnership(authorization.actor, authorization.site)) {
        throw applicationError('SITE_NOT_FOUND');
      }
      await authorizeSiteTransferTarget(
        sites,
        {
          environment: command.environment,
          capability: command.capability,
          target,
        },
        authorization.actor
      );
      return {
        ...authorization,
        authorization: { ...authorization.authorization, operation: 'site_owner_transfer' },
        target,
      };
    }

    return { ...authorization, target: null };
  }
}

function assertExpectedSite(current, expected) {
  if (
    !expected ||
    current.id !== expected.id ||
    current.slug !== expected.slug ||
    current.slugRevision !== expected.slugRevision ||
    ownerType(current) !== ownerType(expected) ||
    ownerId(current) !== ownerId(expected)
  ) {
    throw applicationError('SITE_POLICY_CONFLICT');
  }
}

function ownerType(site) {
  return site.ownerType || 'user';
}

function ownerId(site) {
  return site.ownerId || site.ownerUserId;
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
