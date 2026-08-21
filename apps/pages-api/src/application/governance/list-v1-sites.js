export function createV1SitesQuery({ inventory, sites, projection }) {
  if (typeof inventory?.listSites !== 'function') throw new TypeError('inventory.listSites is required');
  if (typeof inventory?.listWorkers !== 'function') throw new TypeError('inventory.listWorkers is required');
  if (typeof sites?.listActiveSlugs !== 'function') throw new TypeError('sites.listActiveSlugs is required');
  if (typeof projection?.formatSites !== 'function') throw new TypeError('projection.formatSites is required');
  if (typeof projection?.formatUnregisteredWorkers !== 'function') {
    throw new TypeError('projection.formatUnregisteredWorkers is required');
  }

  return { list };

  async function list(query) {
    const [siteKeys, workers, activeV2Sites] = await Promise.all([
      inventory.listSites(),
      inventory.listWorkers(),
      sites.listActiveSlugs({ environment: query.environment }),
    ]);
    const input = {
      siteKeys,
      workers,
      environment: query.environment,
      reservedWorkerNames: query.reservedWorkerNames,
    };
    return {
      sites: projection.formatSites({ ...input, activeV2Sites }),
      unregisteredWorkers: projection.formatUnregisteredWorkers(input),
    };
  }
}
