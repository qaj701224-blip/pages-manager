import { createSitePolicyPort } from '../../application/ports/site-policy.js';
import { createUpdateSiteAccessPolicy } from '../../application/sites/update-access-policy.js';
import { jsonError } from '../../http.js';
import { createSiteRouteSnapshotAdapter, routeSnapshotErrorResponse } from './site-route-snapshots.js';

export function createSitePolicyApplication({ store, env }) {
  return createUpdateSiteAccessPolicy({
    sitePolicy: createSitePolicyPort(store),
    routeSnapshots: createSiteRouteSnapshotAdapter({ store, env }),
    clock: { now: () => readNow(env) },
  });
}

export async function mutateUserSiteAccessPolicy({ env, config, store, siteId, actorUserId, visibility, resolveAclEntries }) {
  try {
    return await createSitePolicyApplication({ store, env })({
      environment: config.environment,
      siteId,
      actorUserId,
      visibility,
      resolveAclEntries,
    });
  } catch (error) {
    return sitePolicyErrorResponse(error);
  }
}

export function sitePolicyErrorResponse(error) {
  const code = error?.code || error?.message;
  const aclError = siteAclErrorResponse(error);
  if (aclError) return aclError;
  if (code === 'SITE_NOT_FOUND') return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  if (code === 'SITE_POLICY_CONFLICT') {
    return jsonError(
      'SITE_POLICY_CONFLICT',
      'Site policy changed while the access update was being applied.',
      409,
      'Refresh the site and retry.'
    );
  }
  if (code === 'ROUTE_VERSION_NOT_FOUND' || code === 'ROUTE_SNAPSHOT_WRITE_FAILED') {
    return routeSnapshotErrorResponse(error);
  }
  if (code === 'ROUTE_POLICY_REPAIR_REQUIRED') {
    return jsonError(
      'ROUTE_POLICY_REPAIR_REQUIRED',
      'Route policy could not be confirmed effective.',
      503,
      'Repair the route snapshot before retrying.'
    );
  }
  return jsonError(
    'SITE_POLICY_UPDATE_FAILED',
    'Site access policy could not be updated.',
    503,
    'Retry after refreshing the site.'
  );
}

export function siteAclErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'ACL_ENTRIES_INVALID') {
    const action =
      error?.reason === 'merged_limit'
        ? 'A site can have at most 200 ACL entries.'
        : 'Send an entries array with at most 200 items.';
    return jsonError('ACL_ENTRIES_INVALID', 'ACL entries are invalid.', 400, action);
  }
  if (code === 'ACL_ENTRY_INVALID') {
    return jsonError('ACL_ENTRY_INVALID', 'ACL entry is invalid.', 400, 'Send ACL entry objects.');
  }
  if (code === 'ACL_EFFECT_UNSUPPORTED') {
    return jsonError('ACL_EFFECT_UNSUPPORTED', 'ACL deny entries are not supported.', 400, 'Use allow-only ACL entries.');
  }
  if (code === 'ACL_ROLE_UNSUPPORTED') {
    return jsonError('ACL_ROLE_UNSUPPORTED', 'ACL role is not supported.', 400, 'Use viewer ACL entries.');
  }
  if (code === 'ACL_SUBJECT_TYPE_UNSUPPORTED') {
    return jsonError('ACL_SUBJECT_TYPE_UNSUPPORTED', 'ACL subject type is not supported.', 400, 'Use email or department.');
  }
  if (code === 'ACL_SUBJECT_VALUE_INVALID') {
    return jsonError('ACL_SUBJECT_VALUE_INVALID', 'ACL subject value is invalid.', 400, 'Use a non-empty subject value.');
  }
  return null;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
