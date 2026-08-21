export function createDeploymentOwnerTransferRestoration({ owners }) {
  if (typeof owners?.restore !== 'function') throw new TypeError('owners.restore is required');

  return { restore };

  async function restore(command) {
    if (!command.enabled || !command.previousSite) return null;
    try {
      const previousSite = command.previousSite;
      return await owners.restore({
        siteId: command.siteId,
        environment: command.environment,
        owner: {
          ownerType: previousSite.ownerType || 'user',
          ownerId: previousSite.ownerId || previousSite.ownerUserId,
          ownerUserId: previousSite.ownerUserId,
          defaultVisibility: previousSite.defaultVisibility,
          updatedAt: previousSite.updatedAt,
        },
      });
    } catch {
      return null;
    }
  }
}
