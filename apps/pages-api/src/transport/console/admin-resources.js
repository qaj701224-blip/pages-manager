import { sanitizeAuditMetadata } from '../../audit-sanitizer.js';
import { createAuditEventsQuery } from '../../application/governance/list-audit-events.js';
import { createDeploymentTraceQuery } from '../../application/governance/get-deployment-trace.js';
import { createExposureOfficeNetVerification } from '../../application/governance/ensure-exposure-office-net.js';
import { createExposureSnapshotFinalization } from '../../application/governance/finalize-exposure-snapshot.js';
import {
  createAdminSitesQuery,
  createAdminTeamsQuery,
  createAdminUsersQuery,
  projectAdminSiteDetail as formatAdminSiteDetail,
  projectAdminTeam as formatAdminTeam,
  projectAdminTeamMember as formatAdminTeamMember,
} from '../../application/governance/list-admin-resources.js';
import { createPlatformAdminManagement } from '../../application/governance/manage-platform-admins.js';
import { createExposureUpdatePreparation } from '../../application/governance/prepare-exposure-update.js';
import { createSiteExposureUpdate } from '../../application/governance/update-site-exposure.js';
import { buildSiteOwnerTransferAuditEvent } from '../../application/sites/build-owner-transfer-audit-event.js';
import { createDepartmentTeamMerge } from '../../application/teams/merge-department-teams.js';
import { createTeamMemberManagement } from '../../application/teams/manage-team-members.js';
import { createTeamManagement } from '../../application/teams/manage-team.js';
import { sanitizeDeploymentTraceDiagnostics } from '../../deployment-trace.js';
import { createDeploymentProvider } from '../../execution-provider.js';
import { jsonError, jsonOk, readJsonBody } from '../../http.js';
import { newId, nextId } from '../../id.js';
import { buildRouteSnapshot, clearRoutePointerIfCurrent, readRouteSnapshotState } from '../../route-snapshot.js';
import { formatAclEntry } from './site-projections.js';
import { createSiteOwnershipApplication, siteTransferErrorResponse } from '../shared/site-ownership-application.js';
import { refreshCurrentRouteSnapshot, restoreSiteVisibilityAfterSnapshotFailure } from '../shared/site-route-snapshots.js';
import { ensurePublicWorkerOfficeNetAbsent } from '../shared/public-office-net-application.js';
import { normalizeNullableString, normalizeRequiredString, readNow } from './admin-support.js';

const TEAM_ROLES = new Set(['viewer', 'publisher', 'admin']);

export async function listAdminUsers(url, config, store) {
  const result = await createAdminUsersQuery({
    users: { list: (query) => store.listAdminUsers(query) },
  }).list({
    environment: config.environment,
    query: normalizeNullableString(url.searchParams.get('query')),
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
    admin: url.searchParams.get('admin'),
    status: url.searchParams.get('status'),
  });
  return jsonOk(result);
}

export async function listAdminSites(url, config, store) {
  const exposure = normalizeNullableString(url.searchParams.get('exposure'));
  if (exposure && exposure !== 'public' && exposure !== 'internal') {
    return jsonError('SITE_EXPOSURE_INVALID', 'Site exposure filter is invalid.', 400, 'Use public or internal.');
  }
  const sites = await createAdminSitesQuery({
    sites: { list: (query) => store.listAdminSites(query) },
  }).list({ environment: config.environment, exposure });
  return jsonOk({ sites });
}

export async function updateAdminSiteExposure(request, env, config, store, session, site) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const exposure = typeof body?.exposure === 'string' ? body.exposure.trim() : '';
  if (exposure !== 'public' && exposure !== 'internal') {
    return jsonError('SITE_EXPOSURE_INVALID', 'Site exposure is invalid.', 400, 'Use internal or public.');
  }
  const reason = normalizeNullableString(body?.reason);
  if (exposure === 'public' && !reason) {
    return jsonError(
      'SITE_EXPOSURE_REASON_REQUIRED',
      'A reason is required to enable public exposure.',
      400,
      'Provide a reason.'
    );
  }
  if (reason && reason.length > 500) {
    return jsonError('SITE_EXPOSURE_REASON_INVALID', 'Exposure reason is too long.', 400, 'Use at most 500 characters.');
  }

  const result = await createSiteExposureUpdateApplication({ store, env, config }).execute({
    environment: config.environment,
    actorUserId: session.userId,
    site,
    exposure,
    reason,
  });
  if (result.ok) {
    return jsonOk({
      access: {
        ...result.access,
        aclEntries: result.access.aclEntries.map(formatAclEntry),
      },
      auditStatus: result.auditStatus,
    });
  }
  if (result.reason === 'required_audit_failed') {
    return jsonError(
      'SITE_EXPOSURE_AUDIT_REQUIRED',
      'Exposure operation was not started because its required audit record could not be written.',
      503,
      'Retry after checking the audit store.'
    );
  }
  if (result.reason === 'site_not_found') {
    return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  }
  if (result.reason === 'public_route_inactive') {
    return jsonError(
      'SITE_PUBLIC_ROUTE_INACTIVE',
      'The site has no active route to expose publicly.',
      409,
      'Deploy an active version before enabling public exposure.'
    );
  }
  if (result.reason === 'repair_required') {
    return adminExposureErrorResponse(
      Object.assign(new Error('ROUTE_POLICY_REPAIR_REQUIRED'), {
        code: 'ROUTE_POLICY_REPAIR_REQUIRED',
        cause: result.error,
      })
    );
  }
  return adminExposureErrorResponse(result.error);
}

function createExposureUpdatePreparationApplication({ store, env }) {
  return createExposureUpdatePreparation({
    audits: { record: (event) => store.recordAuditEvent(event) },
    ids: { next: newId },
    clock: { now: () => readNow(env) },
  });
}

function createSiteExposureUpdateApplication({ store, env, config }) {
  return createSiteExposureUpdate({
    preparation: createExposureUpdatePreparationApplication({ store, env }),
    leases: {
      run: ({ environment, siteId }, work) => store.withSiteCommitLock(environment, siteId, work),
    },
    sites: { get: (siteId, environment) => store.getAdminSiteById(siteId, environment) },
    routes: { get: (siteId, environment) => store.getRouteBySiteId(siteId, environment) },
    versions: { get: (versionId, environment) => store.getSiteVersion(versionId, environment) },
    officeNet: {
      ensure: (command) =>
        createExposureOfficeNetVerificationApplication({ env, config, store, site: command.site }).ensure(command),
    },
    policies: { update: (command) => store.updateSiteAccessPolicy(command) },
    snapshots: {
      finalize: (command) => createExposureSnapshotFinalizationApplication({ store, env }).finalize(command),
    },
    audits: { record: (event) => store.recordAuditEvent(event) },
    telemetry: {
      auditUnconfirmed: ({ operationId, siteId, environment, cause }) =>
        globalThis.console?.warn?.(
          'SITE_EXPOSURE_AUDIT_UNCONFIRMED',
          JSON.stringify({
            operationId,
            siteId,
            environment,
            errorCode: safeAdminExposureAuditWarningCode(cause),
          })
        ),
    },
    clock: { now: () => readNow(env) },
  });
}

function createExposureOfficeNetVerificationApplication({ env, config, store, site }) {
  let provider = null;
  return createExposureOfficeNetVerification({
    officeNet: {
      ensure: (command) => {
        provider ||= createDeploymentProvider(env, config, store, site);
        return ensurePublicWorkerOfficeNetAbsent(provider, { store, ...command });
      },
    },
    audits: { record: (event) => store.recordAuditEvent(event) },
    telemetry: {
      auditUnconfirmed: ({ operationId, siteId, environment, stage, cause }) =>
        globalThis.console?.warn?.(
          'SITE_EXPOSURE_STAGE_AUDIT_UNCONFIRMED',
          JSON.stringify({
            operationId,
            siteId,
            environment,
            stage,
            errorCode: safeAdminExposureAuditWarningCode(cause),
          })
        ),
    },
  });
}

function createExposureSnapshotFinalizationApplication({ store, env }) {
  return createExposureSnapshotFinalization({
    snapshots: {
      commit: ({ site, route, environment }) => writeAdminExposureSnapshot(env, store, site, route, environment),
      clearFailed: async ({ site, route, version, aclEntries }) => {
        const state = await readRouteSnapshotState(env, buildRouteSnapshot({ site, route, version, aclEntries }));
        if (state.pointer) {
          await clearRoutePointerIfCurrent(env, {
            ...state.pointer,
            siteId: site.id,
            routeId: route.id,
          });
        }
      },
    },
    policies: {
      restore: ({ siteId, currentSite, currentRoute, committedRoute, environment }) =>
        restoreSiteVisibilityAfterSnapshotFailure(store, siteId, currentSite, currentRoute, committedRoute, environment),
    },
    sites: { get: (siteId, environment) => store.getAdminSiteById(siteId, environment) },
    routes: { get: (siteId, environment) => store.getRouteBySiteId(siteId, environment) },
    versions: { get: (versionId, environment) => store.getSiteVersion(versionId, environment) },
    aclEntries: { list: (siteId) => store.listSiteAclEntries(siteId) },
    audits: { record: (event) => store.recordAuditEvent(event) },
  });
}

async function writeAdminExposureSnapshot(env, store, site, route, environment) {
  let writeResult;
  try {
    writeResult = await refreshCurrentRouteSnapshot(env, store, site, route, environment);
  } catch (error) {
    return { error };
  }
  if (writeResult) {
    const error = new Error('ROUTE_POLICY_REPAIR_REQUIRED');
    error.code = writeResult.error?.code || 'ROUTE_POLICY_REPAIR_REQUIRED';
    error.cause = writeResult;
    return { error };
  }

  return { committed: true };
}

function safeAdminExposureAuditWarningCode(error) {
  return error?.code === 'AUDIT_WRITE_FAILED' ? 'AUDIT_WRITE_FAILED' : 'UNKNOWN';
}

export async function readAdminSitePublicExposureReason(env, store, config, site, exposure) {
  if (exposure !== 'public' || typeof store.getLatestAdminSitePublicExposureReason !== 'function') return null;
  try {
    const lockBefore = await readAdminSiteCommitLock(store, config, site);
    if (isActiveAdminSiteCommitLock(lockBefore, readNow(env))) return null;
    const reason = await store.getLatestAdminSitePublicExposureReason({
      environment: config.environment,
      siteId: site.id,
      currentExposure: exposure,
    });
    const lockAfter = await readAdminSiteCommitLock(store, config, site);
    if (isActiveAdminSiteCommitLock(lockAfter, readNow(env)) || adminSiteCommitLockChanged(lockBefore, lockAfter)) return null;
    return reason;
  } catch (error) {
    globalThis.console?.warn?.(
      'SITE_EXPOSURE_REASON_READ_UNCONFIRMED',
      JSON.stringify({
        environment: config.environment,
        siteId: site.id,
        errorCode: safeAdminExposureAuditWarningCode(error),
      })
    );
    return null;
  }
}

async function readAdminSiteCommitLock(store, config, site) {
  if (typeof store.getSiteCommitLock !== 'function') return null;
  return store.getSiteCommitLock(config.environment, site.id);
}

function isActiveAdminSiteCommitLock(lock, now) {
  return Date.parse(lock?.expiresAt || '') > Date.parse(now);
}

function adminSiteCommitLockChanged(before, after) {
  return (
    (before?.lockId || null) !== (after?.lockId || null) ||
    Number(before?.fencingToken || 0) !== Number(after?.fencingToken || 0) ||
    (before?.updatedAt || null) !== (after?.updatedAt || null)
  );
}

function adminExposureErrorResponse(error) {
  const code = error?.code || error?.message;
  if (code === 'SITE_POLICY_LOCKED' || code === 'SITE_POLICY_CONFLICT') {
    return jsonError(
      'SITE_POLICY_CONFLICT',
      'Site policy changed while exposure was being updated.',
      409,
      'Refresh the site and retry.'
    );
  }
  if (code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' || code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED') {
    return jsonError(code, error.message, 503, error.action);
  }
  if (code === 'SITE_EXPOSURE_AUDIT_FAILED') {
    return jsonError(
      code,
      'Site exposure is effective, but the final audit record could not be confirmed.',
      503,
      'Refresh the site status and retry the exposure operation to reconcile its audit trail.'
    );
  }
  if (code === 'ROUTE_POLICY_REPAIR_REQUIRED' || code === 'ROUTE_SNAPSHOT_WRITE_FAILED') {
    return jsonError(
      'ROUTE_POLICY_REPAIR_REQUIRED',
      'Route policy could not be confirmed effective.',
      503,
      'Repair the route snapshot before retrying.'
    );
  }
  return jsonError(
    'SITE_EXPOSURE_UPDATE_FAILED',
    'Site exposure could not be updated.',
    503,
    'Retry after checking the site policy state.'
  );
}

export async function getAdminSite(config, store, siteId) {
  if (typeof store.getAdminSiteById === 'function') {
    const site = await store.getAdminSiteById(siteId, config.environment);
    if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
    return site;
  }
  const sites = await store.listAdminSites({ environment: config.environment });
  const site = sites.find((item) => item.id === siteId);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  return site;
}

export async function updateAdminSiteSettings(request, env, config, store, session, site) {
  if (typeof store.transferSiteOwner !== 'function') {
    return jsonError('SITE_TRANSFER_UNSUPPORTED', 'Site transfer is unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const target = await resolveAdminSiteOwnerTarget(store, config, body);
  if (target instanceof Response) return target;
  const currentVisibility = site.route?.visibility || site.defaultVisibility;
  if (target.ownerType === 'team' && currentVisibility === 'owner') return teamOwnerVisibilityUnsupported();

  let updated;
  try {
    const result = await createSiteOwnershipApplication({ store, env })({
      environment: config.environment,
      site,
      actor: { type: 'user', userId: session.userId },
      capability: 'platform_admin',
      target: { ...target, ownerUserId: target.ownerUserId || session.userId },
      buildAuditEvent: (updatedAt, currentSite) =>
        buildSiteOwnerTransferAuditEvent({
          id: nextId(env, 'aud'),
          environment: config.environment,
          actor: { type: 'user', userId: session.userId },
          site: currentSite,
          target,
          source: 'console-admin',
          createdAt: updatedAt,
        }),
      compensateSnapshotFailure: true,
    });
    updated = result.site;
  } catch (error) {
    return siteTransferErrorResponse(error);
  }

  const refreshed = await getAdminSite(config, store, updated.id);
  if (refreshed instanceof Response) return refreshed;
  return jsonOk({ site: formatAdminSiteDetail(refreshed) });
}

async function resolveAdminSiteOwnerTarget(store, config, body) {
  const ownerType = body?.ownerType === 'team' || body?.ownerType === 'user' ? body.ownerType : '';
  if (!ownerType) {
    return jsonError('SITE_TRANSFER_INVALID', 'Site transfer target is invalid.', 400, 'Use ownerType user or team.');
  }

  if (ownerType === 'user') {
    const ownerId = normalizeRequiredString(body.ownerId || body.userId);
    if (!ownerId) return jsonError('SITE_TRANSFER_INVALID', 'Site transfer target is invalid.', 400, 'Choose a user.');
    const user = typeof store.getUser === 'function' ? await store.getUser(ownerId) : null;
    if (!user?.id || user.employeeStatus !== 'active') {
      return jsonError('SITE_TRANSFER_FORBIDDEN', 'Target user is not active.', 403, 'Choose an active user.');
    }
    return {
      ownerType: 'user',
      ownerId: user.id,
      ownerUserId: user.id,
    };
  }

  const teamId = normalizeRequiredString(body.teamId || body.ownerId);
  if (!teamId) return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
  const team = typeof store.getTeam === 'function' ? await store.getTeam(teamId) : null;
  if (!team || team.environment !== config.environment || team.deletedAt || team.status !== 'active') {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  return {
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: team.createdByUserId || null,
  };
}

export async function listAdminTeams(url, config, store) {
  const teamType = normalizeNullableString(url.searchParams.get('teamType'));
  const statusFilter = normalizeNullableString(url.searchParams.get('status'));
  const status = statusFilter === 'all' ? null : statusFilter || 'active';
  const teams = await createAdminTeamsQuery({
    teams: { list: (query) => store.listAdminTeams(query) },
  }).list({
    environment: config.environment,
    teamType,
    status,
  });
  return jsonOk({ teams });
}

export async function getAdminTeam(config, store, teamId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;
  return jsonOk({ team: formatAdminTeam(team) });
}

export async function getAdminTeamRecord(config, store, teamId) {
  const team = await store.getTeam(teamId);
  if (!team || team.environment !== config.environment || team.deletedAt) {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  return team;
}

export async function updateAdminTeamMember(request, config, store, session, teamId, userId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const role = typeof body.role === 'string' ? body.role : '';
  if (!TEAM_ROLES.has(role)) {
    return jsonError('TEAM_ROLE_INVALID', 'Team role is invalid.', 400, 'Use viewer, publisher, or admin.');
  }

  const result = await createAdminTeamMemberManagement(store).update({
    environment: config.environment,
    teamId: team.id,
    userId,
    role,
    actorUserId: session.userId,
    capability: 'platform_admin',
  });
  if (!result.ok) return adminTeamMemberMutationError(result.reason);
  return jsonOk({ member: formatAdminTeamMember(result.member) });
}

export async function removeAdminTeamMember(config, store, session, teamId, userId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;

  const result = await createAdminTeamMemberManagement(store).remove({
    environment: config.environment,
    teamId: team.id,
    userId,
    actorUserId: session.userId,
    capability: 'platform_admin',
  });
  if (!result.ok) return adminTeamMemberMutationError(result.reason);
  return jsonOk({ member: formatAdminTeamMember(result.member) });
}

function createAdminTeamMemberManagement(store) {
  return createTeamMemberManagement({
    teams: { get: (teamId) => store.getTeam(teamId) },
    users: { get: (userId) => store.getUser(userId) },
    members: {
      get: (query) => store.getTeamMember(query),
      list: (query) => store.listTeamMembers(query),
      upsert: (command) => store.addTeamMember(command),
      remove: (command) => store.removeTeamMember(command),
    },
  });
}

function adminTeamMemberMutationError(reason) {
  if (reason === 'team_not_found') return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  if (reason === 'user_not_found') {
    return jsonError('USER_NOT_FOUND', 'User not found.', 404, 'Pick a user that has signed in to XD Cell.');
  }
  if (reason === 'last_admin') {
    return jsonError(
      'TEAM_LAST_ADMIN',
      'Team must keep at least one active admin.',
      409,
      'Promote another member to admin before changing this member.'
    );
  }
  if (reason === 'member_not_found') {
    return jsonError('TEAM_MEMBER_NOT_FOUND', 'Team member not found.', 404, 'Check the user id.');
  }
  throw new Error('ADMIN_TEAM_MEMBER_MUTATION_RESULT_INVALID');
}

export async function updateAdminTeamSettings(request, config, store, teamId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const result = await createAdminTeamManagement(store).updateSettings({
    environment: config.environment,
    teamId,
    name: body.name,
    description: body.description,
    capability: 'platform_admin',
  });
  if (!result.ok) return adminTeamManagementError(result.reason);
  return jsonOk({ team: formatAdminTeam(result.team) });
}

export async function deleteAdminTeam(config, store, session, teamId) {
  const team = await getAdminTeamRecord(config, store, teamId);
  if (team instanceof Response) return team;
  const result = await createAdminTeamManagement(store).deleteTeam({
    environment: config.environment,
    teamId,
    actorUserId: session.userId,
    capability: 'platform_admin',
  });
  if (!result.ok) return adminTeamManagementError(result.reason);
  return jsonOk({ team: formatAdminTeam(result.team) });
}

function createAdminTeamManagement(store) {
  return createTeamManagement({
    teams: {
      get: (teamId) => store.getTeam(teamId),
      ...(typeof store.updateTeamSettings === 'function'
        ? {
            updateSettings: (command) =>
              store.updateTeamSettings({
                teamId: command.teamId,
                name: command.name,
                description: command.description,
              }),
          }
        : {}),
      ...(typeof store.deleteCustomTeam === 'function' ? { deleteCustom: (command) => store.deleteCustomTeam(command) } : {}),
    },
    members: { get: (query) => store.getTeamMember(query) },
  });
}

function adminTeamManagementError(reason) {
  if (reason === 'team_not_found') return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  if (reason === 'department_settings_readonly') {
    return jsonError(
      'DEPARTMENT_TEAM_SETTINGS_READONLY',
      'Department team settings are read-only.',
      403,
      'Use admin team merge tooling if the department path changed.'
    );
  }
  if (reason === 'settings_unsupported') {
    return jsonError('TEAM_SETTINGS_UNSUPPORTED', 'Team settings are unavailable.', 503, 'Retry later.');
  }
  if (reason === 'department_delete_forbidden') {
    return jsonError(
      'DEPARTMENT_TEAM_DELETE_FORBIDDEN',
      'Department teams cannot be deleted from admin team settings.',
      403,
      'Use platform admin team merge tooling.'
    );
  }
  if (reason === 'blocking_assets') {
    return jsonError(
      'TEAM_HAS_BLOCKING_ASSETS',
      'Team still owns sites or active access keys.',
      409,
      'Delete or transfer team sites and revoke team access keys first.'
    );
  }
  throw new Error('ADMIN_TEAM_MANAGEMENT_RESULT_INVALID');
}

export async function mergeDepartmentTeam(request, config, store, session, sourceTeamId) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const targetTeamId = normalizeRequiredString(body.targetTeamId);
  if (!targetTeamId) {
    return jsonError('TEAM_MERGE_TARGET_REQUIRED', 'Target team id is required.', 400, 'Choose a target department team.');
  }

  const result = await createDepartmentTeamMerge({
    teams: { merge: (command) => store.mergeDepartmentTeams(command) },
  }).execute({
    sourceTeamId,
    targetTeamId,
    actorUserId: session.userId,
    reason: normalizeNullableString(body.reason),
    environment: config.environment,
  });
  if (!result.ok) return adminMergeErrorResponse(result.errorCode);
  return jsonOk({
    merge: {
      sourceTeam: formatAdminTeam(result.merge.sourceTeam),
      targetTeam: formatAdminTeam(result.merge.targetTeam),
      counts: result.merge.counts,
    },
  });
}

export async function listAuditEvents(config, store) {
  const events = await createAuditEventsQueryApplication(store).list({ environment: config.environment });
  return jsonOk({ events });
}

function createAuditEventsQueryApplication(store) {
  return createAuditEventsQuery({
    audits: { list: (query) => store.listAuditEvents(query) },
    metadata: { sanitize: sanitizeAuditMetadata },
  });
}

export async function listPlatformAdmins(config, store) {
  const admins = await createPlatformAdminApplication(store).list({ environment: config.environment });
  return jsonOk({ admins });
}

export async function grantPlatformAdmin(request, config, store, session) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const userId = normalizeRequiredString(body.userId);
  if (!userId) return jsonError('PLATFORM_ADMIN_USER_REQUIRED', 'User id is required.', 400, 'Choose a user to grant.');

  const result = await createPlatformAdminApplication(store).grant({
    environment: config.environment,
    userId,
    actorUserId: session.userId,
    reason: normalizeNullableString(body.reason),
  });
  if (!result.ok) return platformAdminMutationError(result.reason);
  return jsonOk({ admin: result.admin });
}

export async function revokePlatformAdmin(request, config, store, session, userId) {
  let body = {};
  if (request.headers.get('Content-Type')) {
    try {
      body = await readJsonBody(request, { maxBytes: 16 * 1024 });
    } catch {
      return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
    }
  }

  const normalizedUserId = normalizeRequiredString(userId);
  if (!normalizedUserId)
    return jsonError('PLATFORM_ADMIN_USER_REQUIRED', 'User id is required.', 400, 'Choose a user to revoke.');

  const result = await createPlatformAdminApplication(store).revoke({
    environment: config.environment,
    userId: normalizedUserId,
    actorUserId: session.userId,
    reason: normalizeNullableString(body.reason),
  });
  if (!result.ok) return platformAdminMutationError(result.reason);
  return jsonOk({ admin: result.admin });
}

function createPlatformAdminApplication(store) {
  return createPlatformAdminManagement({
    admins: {
      list: (query) => store.listPlatformAdmins(query),
      grant: (command) => store.grantPlatformAdmin(command),
      revoke: (command) => store.revokePlatformAdmin(command),
    },
    users: { get: (userId) => store.getUser(userId) },
  });
}

function platformAdminMutationError(reason) {
  if (reason === 'user_not_found') {
    return jsonError('ADMIN_USER_NOT_FOUND', 'User was not found.', 404, 'Choose an existing user.');
  }
  if (reason === 'last_active') {
    return jsonError(
      'PLATFORM_ADMIN_LAST_ACTIVE',
      'Platform must keep at least one active administrator.',
      409,
      'Grant another platform administrator before revoking this user.'
    );
  }
  if (reason === 'admin_not_found') {
    return jsonError('PLATFORM_ADMIN_NOT_FOUND', 'Platform admin was not found.', 404, 'Check the user id.');
  }
  throw new Error('PLATFORM_ADMIN_MUTATION_RESULT_INVALID');
}

export function formatAdminDeployment(deployment) {
  const ownerState = deployment.ownerState === 'not_created' ? 'not_created' : 'persisted';
  const actor = deployment.actor || {};
  const formatted = {
    id: deployment.id,
    siteId: deployment.siteId,
    siteSlug: deployment.siteSlug || null,
    owner: {
      state: ownerState,
      type: ownerState === 'not_created' ? null : deployment.ownerType || 'user',
      id: ownerState === 'not_created' ? null : deployment.ownerId || deployment.ownerUserId || null,
      email: ownerState === 'not_created' ? null : deployment.ownerEmail || null,
      displayName: ownerState === 'not_created' ? null : deployment.ownerDisplayName || null,
      departmentPath: ownerState === 'not_created' ? null : deployment.ownerDepartmentPath || null,
      teamType: ownerState === 'not_created' ? null : deployment.ownerTeamType || null,
    },
    actor: {
      type: actor.type ?? deployment.actorType ?? null,
      id: actor.id ?? deployment.actorId ?? null,
      userId: actor.userId ?? deployment.actorUserId ?? null,
      email: actor.email ?? null,
      displayName: actor.displayName ?? null,
    },
    status: deployment.status,
    source: deployment.source || null,
    operation: deployment.operation || null,
    createdAt: deployment.createdAt,
  };
  if (deployment.traceId) formatted.traceId = deployment.traceId;
  if (deployment.errorCode) formatted.errorCode = deployment.errorCode;
  if (deployment.errorMessage) formatted.errorMessage = deployment.errorMessage;
  if (deployment.failureStage) formatted.failureStage = deployment.failureStage;
  if (deployment.failureDiagnostics) formatted.failureDiagnostics = deployment.failureDiagnostics;
  return formatted;
}

export async function getAdminDeploymentTrace(config, store, deploymentId) {
  const result = await createDeploymentTraceQueryApplication(store).byDeployment({
    environment: config.environment,
    deploymentId,
  });
  if (!result.ok) {
    return jsonError('DEPLOYMENT_NOT_FOUND', 'Deployment not found.', 404, 'Check the deployment id.');
  }
  return jsonOk(result.value);
}

export async function getAdminDeploymentTraceByTraceId(config, store, traceId) {
  const result = await createDeploymentTraceQueryApplication(store).byTraceId({
    environment: config.environment,
    traceId,
  });
  return result.ok ? jsonOk(result.value) : deploymentTraceNotFound();
}

function deploymentTraceNotFound() {
  return jsonError('DEPLOYMENT_TRACE_NOT_FOUND', 'Deployment trace not found.', 404, 'Check the deployment trace id.');
}

function createDeploymentTraceQueryApplication(store) {
  const listDeploymentEvents = (query, fallback) =>
    typeof store.listDeploymentEvents === 'function' ? store.listDeploymentEvents(query) : fallback;
  return createDeploymentTraceQuery({
    deployments: { get: (id, environment) => store.getDeployment(id, environment) },
    events: {
      listByDeployment: (query) => listDeploymentEvents(query, []),
      listByTrace: (query) => listDeploymentEvents(query, null),
    },
    diagnostics: { sanitize: sanitizeDeploymentTraceDiagnostics },
  });
}

function adminMergeErrorResponse(code) {
  if (code === 'TEAM_NOT_FOUND') return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check team ids.');
  if (code === 'TEAM_MERGE_TARGET_INVALID') {
    return jsonError(
      'TEAM_MERGE_TARGET_INVALID',
      'Source and target team must be different.',
      400,
      'Choose another target team.'
    );
  }
  if (code === 'TEAM_MERGE_ENVIRONMENT_MISMATCH') {
    return jsonError(
      'TEAM_MERGE_ENVIRONMENT_MISMATCH',
      'Teams are not in the same environment.',
      400,
      'Choose a team in the same environment.'
    );
  }
  if (code === 'TEAM_MERGE_DEPARTMENT_REQUIRED') {
    return jsonError('TEAM_MERGE_DEPARTMENT_REQUIRED', 'Only department teams can be merged.', 400, 'Choose department teams.');
  }
  if (code === 'TEAM_MERGE_SOURCE_INACTIVE' || code === 'TEAM_MERGE_TARGET_INACTIVE') {
    return jsonError(code, 'Team cannot be merged in its current state.', 409, 'Refresh teams and retry.');
  }
  throw new Error('TEAM_MERGE_RESULT_INVALID');
}

function teamOwnerVisibilityUnsupported() {
  return jsonError(
    'SITE_VISIBILITY_INVALID',
    'Team-owned sites cannot use owner visibility.',
    400,
    'Use internal, org, acl, or disabled for team-owned sites.'
  );
}
