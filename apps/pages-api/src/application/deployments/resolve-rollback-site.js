import { actorCanDeploySite } from '../../domain/sites/authorization.js';

export function createRollbackSiteResolution({ sites }) {
  if (typeof sites?.getVersion !== 'function') throw new TypeError('sites.getVersion is required');
  if (typeof sites?.getForActor !== 'function') throw new TypeError('sites.getForActor is required');

  return async function resolveRollbackSite(command) {
    const version = await sites.getVersion(command.versionId, command.environment);
    if (!version) return failed('VERSION_NOT_FOUND');

    const requestedSiteId = normalizeOptionalString(command.siteId);
    if (requestedSiteId && requestedSiteId !== version.siteId) return failed('ROLLBACK_SITE_MISMATCH');

    const requestedSiteSlug = normalizeOptionalString(command.siteSlug).toLowerCase();
    if (requestedSiteSlug && typeof sites.findBySlug === 'function') {
      const requestedSite = await sites.findBySlug(command.environment, requestedSiteSlug);
      if (!requestedSite) return failed('SITE_NOT_FOUND');
      if (requestedSite.id !== version.siteId) return failed('ROLLBACK_SITE_MISMATCH');
    }

    const site = await sites.getForActor(version.siteId, command.actor.userId, command.actor, command.environment);
    if (!site || !actorCanDeploySite(command.actor, site, 'rollback:site')) return failed('ROLLBACK_FORBIDDEN');
    return { ok: true, site, version };
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function failed(code) {
  return { ok: false, error: { code } };
}
