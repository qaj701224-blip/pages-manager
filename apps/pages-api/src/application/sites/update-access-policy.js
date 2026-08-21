import { accessModeFromVisibility } from '@xd/pages-access-policy';

import {
  previousRouteExposure,
  sitePolicyExpected,
  sitePolicyRouteCanBeCompensated,
} from '../../domain/sites/access-policy.js';

const PASSTHROUGH_ERRORS = new Set([
  'SITE_NOT_FOUND',
  'ROUTE_VERSION_NOT_FOUND',
  'ROUTE_SNAPSHOT_WRITE_FAILED',
  'ACL_ENTRIES_INVALID',
]);
const CONFLICT_ERRORS = new Set(['SITE_POLICY_LOCKED', 'SITE_POLICY_CONFLICT', 'SITE_COMMIT_TIMEOUT']);

export function createUpdateSiteAccessPolicy({ sitePolicy, routeSnapshots, clock }) {
  if (!sitePolicy || typeof sitePolicy !== 'object') throw new TypeError('sitePolicy port is required');
  if (typeof routeSnapshots?.refreshActive !== 'function') throw new TypeError('routeSnapshots.refreshActive is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return async function updateSiteAccessPolicy(command) {
    try {
      return await sitePolicy.withSiteCommitLock(
        command.environment,
        command.siteId,
        (lease) => updateUnderLease({ sitePolicy, routeSnapshots, clock, command, lease }),
        { bestEffortRelease: true }
      );
    } catch (error) {
      const code = error?.code || error?.message;
      if (PASSTHROUGH_ERRORS.has(code)) throw error;
      if (CONFLICT_ERRORS.has(code)) throw applicationError('SITE_POLICY_CONFLICT');
      if (code === 'ROUTE_POLICY_REPAIR_REQUIRED') throw error;
      throw applicationError('SITE_POLICY_UPDATE_FAILED');
    }
  };
}

async function updateUnderLease({ sitePolicy, routeSnapshots, clock, command, lease }) {
  const currentSite = await sitePolicy.getSite(command.siteId, command.environment);
  const currentRoute = await sitePolicy.getRouteBySiteId(command.siteId, command.environment);
  if (!currentSite || !currentRoute) throw applicationError('SITE_NOT_FOUND');

  const previousAclEntries = await sitePolicy.listSiteAclEntries(command.siteId);
  const nextAclEntries = command.resolveAclEntries ? command.resolveAclEntries(previousAclEntries) : undefined;
  const updatedAt = clock.now();
  const mutation = await sitePolicy.updateSiteAccessPolicy({
    environment: command.environment,
    siteId: command.siteId,
    actorUserId: command.actorUserId,
    ...(command.visibility === undefined ? {} : { accessMode: accessModeFromVisibility(command.visibility) }),
    ...(command.resolveAclEntries ? { aclEntries: nextAclEntries } : {}),
    expected: sitePolicyExpected(currentRoute),
    lease,
    updatedAt,
  });

  try {
    await routeSnapshots.refreshActive({
      site: mutation.site,
      route: mutation.route,
      environment: command.environment,
      aclEntries: mutation.aclEntries,
    });
    return mutation;
  } catch (snapshotError) {
    await compensatePolicy({
      sitePolicy,
      routeSnapshots,
      command,
      lease,
      updatedAt,
      currentRoute,
      previousAclEntries,
      mutation,
    });
    throw snapshotError;
  }
}

async function compensatePolicy({
  sitePolicy,
  routeSnapshots,
  command,
  lease,
  updatedAt,
  currentRoute,
  previousAclEntries,
  mutation,
}) {
  let compensation;
  try {
    const latestRoute = await sitePolicy.getRouteBySiteId(command.siteId, command.environment);
    if (!sitePolicyRouteCanBeCompensated(latestRoute, mutation.route)) throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
    compensation = await sitePolicy.updateSiteAccessPolicy({
      environment: command.environment,
      siteId: command.siteId,
      actorUserId: command.actorUserId,
      exposure: previousRouteExposure(currentRoute),
      accessMode: accessModeFromVisibility(currentRoute.visibility),
      aclEntries: previousAclEntries,
      expected: sitePolicyExpected(latestRoute),
      lease,
      updatedAt,
    });
  } catch {
    throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
  }

  try {
    await routeSnapshots.refreshActive({
      site: compensation.site,
      route: compensation.route,
      environment: command.environment,
      aclEntries: compensation.aclEntries,
    });
  } catch {
    throw applicationError('ROUTE_POLICY_REPAIR_REQUIRED');
  }
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
