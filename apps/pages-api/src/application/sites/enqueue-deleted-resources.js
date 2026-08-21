export function createEnqueueDeletedSiteResources({ cleanupTasks, isManagedResource, ids, clock }) {
  if (!cleanupTasks || typeof cleanupTasks !== 'object') throw new TypeError('cleanupTasks port is required');
  if (typeof isManagedResource !== 'function') throw new TypeError('isManagedResource is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return async function enqueueDeletedSiteResources(command) {
    if (typeof cleanupTasks.createDeploymentResourceCleanupTask !== 'function') return;
    const resourcesByWorker = new Map();
    addManagedResource(resourcesByWorker, command.previousRoute, command, isManagedResource, {
      siteId: command.site.id,
      versionId: command.previousRoute?.activeVersionId || null,
    });

    if (typeof cleanupTasks.listSiteWfpCleanupReferences === 'function') {
      try {
        const references = await cleanupTasks.listSiteWfpCleanupReferences({
          siteId: command.site.id,
          environment: command.environment,
        });
        for (const route of references?.activeRoutes || []) {
          addManagedResource(resourcesByWorker, route, command, isManagedResource, {
            siteId: route.siteId || command.site.id,
            versionId: route.versionId || null,
          });
        }
        for (const version of references?.versions || []) {
          addManagedResource(resourcesByWorker, version, command, isManagedResource, {
            siteId: version.siteId || command.site.id,
            versionId: version.id || null,
          });
        }
      } catch {
        // Site deletion is committed; reference discovery is best-effort maintenance.
      }
    }

    for (const resource of resourcesByWorker.values()) {
      try {
        await cleanupTasks.createDeploymentResourceCleanupTask({
          id: ids.next('cln'),
          environment: command.environment,
          resourceType: 'wfp_user_worker',
          resourceRef: resource.workerName,
          siteId: resource.siteId,
          versionId: resource.versionId,
          deploymentId: null,
          cleanupReason: 'site_deleted',
          status: 'pending',
          cleanupAfter: command.cleanupAfter,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
      } catch {
        // Cleanup task creation must not turn a committed delete into a failure.
      }
    }
  };
}

function addManagedResource(resources, candidate, command, isManagedResource, identity) {
  if (!isManagedResource(candidate, command.environment)) return;
  resources.set(candidate.workerName, {
    workerName: candidate.workerName,
    siteId: identity.siteId,
    versionId: identity.versionId,
  });
}
