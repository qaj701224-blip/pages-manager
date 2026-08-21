export function createTransferSiteOwner({ siteOwnership, routeSnapshots, clock }) {
  if (!siteOwnership || typeof siteOwnership !== 'object') throw new TypeError('siteOwnership port is required');
  if (typeof routeSnapshots?.refreshActive !== 'function') throw new TypeError('routeSnapshots.refreshActive is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return async function transferSiteOwner(command) {
    if (typeof siteOwnership.transferSiteOwner !== 'function') throw applicationError('SITE_TRANSFER_UNSUPPORTED');
    const updatedAt = clock.now();
    const updated = await siteOwnership.transferSiteOwner(
      command.site.id,
      {
        ownerType: command.target.ownerType,
        ownerId: command.target.ownerId,
        ownerUserId: command.target.ownerUserId,
        updatedAt,
        ...(command.buildAuditEvent ? { auditEvent: command.buildAuditEvent(updatedAt) } : {}),
      },
      command.environment
    );
    if (!updated) throw applicationError('SITE_NOT_FOUND');

    const route = await siteOwnership.getRouteBySiteId(updated.id, command.environment);
    try {
      await routeSnapshots.refreshActive({ site: updated, route, environment: command.environment });
    } catch (error) {
      if (command.compensateSnapshotFailure) {
        await restorePreviousOwner(siteOwnership, command.site, updatedAt, command.environment);
      }
      throw error;
    }
    return { site: updated, route };
  };
}

async function restorePreviousOwner(siteOwnership, previousSite, updatedAt, environment) {
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
    },
    environment
  );
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
