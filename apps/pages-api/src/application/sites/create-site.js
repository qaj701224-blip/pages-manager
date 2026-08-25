export function createSiteCreation({ siteCreation, legacyV1Takeover, ids, siteUuids, hostnameForSlug }) {
  if (typeof siteCreation?.createSite !== 'function') throw new TypeError('siteCreation.createSite is required');
  if (typeof siteCreation?.getRouteBySiteId !== 'function') {
    throw new TypeError('siteCreation.getRouteBySiteId is required');
  }
  if (typeof legacyV1Takeover !== 'function') throw new TypeError('legacyV1Takeover is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');
  if (typeof siteUuids?.next !== 'function') throw new TypeError('siteUuids.next is required');
  if (typeof hostnameForSlug !== 'function') throw new TypeError('hostnameForSlug is required');

  function prepare(command) {
    return {
      id: ids.next('site'),
      slug: command.slug,
      ownerType: command.ownerType,
      ownerId: command.ownerId,
      ownerUserId: command.ownerUserId,
      title: command.title ?? null,
      siteUuid: siteUuids.next(),
      defaultVisibility: command.visibility,
      environment: command.environment,
      routeId: ids.next('route'),
      hostname: hostnameForSlug(command.slug),
    };
  }

  async function commit(command) {
    if (command.allowLegacyV1Takeover) {
      return legacyV1Takeover({ actor: command.actor, siteInput: command.siteInput });
    }
    return siteCreation.createSite(command.siteInput);
  }

  async function create(command) {
    const siteInput = prepare(command);
    const site = await commit({
      actor: command.actor,
      siteInput,
      allowLegacyV1Takeover: command.allowLegacyV1Takeover,
    });
    const route = command.includeRoute ? await siteCreation.getRouteBySiteId(site.id, command.environment) : null;
    return { site, route, siteInput };
  }

  return { prepare, commit, create };
}
