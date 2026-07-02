import { isConsoleBffRequest, requireConsoleUserSession } from './console-auth.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';
const TEAM_ROLES = new Set(['viewer', 'publisher', 'admin']);

export async function handleConsoleTeamsApi(request, env, config, store) {
  if (!isConsoleBffRequest(request)) return null;

  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${CONSOLE_PREFIX}/teams`)) return null;

  const session = await requireConsoleUserSession(request, env, config, store, {
    hydrateDepartment: url.pathname === `${CONSOLE_PREFIX}/teams` && request.method === 'GET',
  });
  if (session instanceof Response) return session;

  if (url.pathname === `${CONSOLE_PREFIX}/teams`) {
    if (request.method !== 'GET') return methodNotAllowed();
    const teams = await store.listTeamsForUser({
      environment: config.environment,
      userId: session.userId,
    });
    return jsonOk({ teams: teams.map(formatTeam) });
  }

  const memberMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/teams\/([^/]+)\/members\/([^/]+)$/);
  if (memberMatch) {
    const teamId = decodePathSegment(memberMatch[1]);
    const userId = decodePathSegment(memberMatch[2]);
    if (!teamId || !userId) return invalidPathSegment();
    if (request.method === 'PATCH') return updateTeamMember(request, store, config, session, teamId, userId);
    if (request.method === 'DELETE') return removeTeamMember(store, config, session, teamId, userId);
    return methodNotAllowed();
  }

  const teamMembersMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/teams\/([^/]+)\/members$/);
  if (teamMembersMatch) {
    if (request.method !== 'GET') return methodNotAllowed();
    const teamId = decodePathSegment(teamMembersMatch[1]);
    if (!teamId) return invalidPathSegment();
    const access = await requireTeamMember(store, config, session, teamId);
    if (access instanceof Response) return access;
    const members = await store.listTeamMembers({ teamId });
    return jsonOk({ members: members.map(formatTeamMember) });
  }

  const teamSettingsMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/teams\/([^/]+)\/settings$/);
  if (teamSettingsMatch) {
    if (request.method !== 'PATCH') return methodNotAllowed();
    const teamId = decodePathSegment(teamSettingsMatch[1]);
    if (!teamId) return invalidPathSegment();
    return updateTeamSettings(request, store, config, session, teamId);
  }

  const teamMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/teams\/([^/]+)$/);
  if (teamMatch) {
    const teamId = decodePathSegment(teamMatch[1]);
    if (!teamId) return invalidPathSegment();
    if (request.method === 'GET') return getTeam(store, config, session, teamId);
    if (request.method === 'DELETE') return deleteTeam(store, config, session, teamId);
    return methodNotAllowed();
  }

  return null;
}

async function getTeam(store, config, session, teamId) {
  const access = await requireTeamMember(store, config, session, teamId);
  if (access instanceof Response) return access;
  return jsonOk({ team: formatTeam(access.team, access.member) });
}

async function updateTeamMember(request, store, config, session, teamId, userId) {
  const access = await requireTeamAdmin(store, config, session, teamId);
  if (access instanceof Response) return access;

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

  const member = await store.addTeamMember({
    teamId,
    userId,
    role,
    membershipSource: 'manual',
    actorUserId: session.userId,
  });
  return jsonOk({ member: formatTeamMember(member) });
}

async function removeTeamMember(store, config, session, teamId, userId) {
  const access = await requireTeamAdmin(store, config, session, teamId);
  if (access instanceof Response) return access;

  const member = await store.removeTeamMember({ teamId, userId, actorUserId: session.userId });
  if (!member) return jsonError('TEAM_MEMBER_NOT_FOUND', 'Team member not found.', 404, 'Check the user id.');
  return jsonOk({ member: formatTeamMember(member) });
}

async function updateTeamSettings(request, store, config, session, teamId) {
  const access = await requireTeamAdmin(store, config, session, teamId);
  if (access instanceof Response) return access;
  if (access.team.teamType === 'department') {
    return jsonError(
      'DEPARTMENT_TEAM_SETTINGS_READONLY',
      'Department team settings are read-only.',
      403,
      'Use admin team merge tooling if the department path changed.'
    );
  }
  if (typeof store.updateTeamSettings !== 'function') {
    return jsonError('TEAM_SETTINGS_UNSUPPORTED', 'Team settings are unavailable.', 503, 'Retry later.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 16 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }
  const team = await store.updateTeamSettings({
    teamId,
    name: body.name,
    description: body.description,
    actorUserId: session.userId,
  });
  return jsonOk({ team: formatTeam(team, access.member) });
}

async function deleteTeam(store, config, session, teamId) {
  const access = await requireTeamAdmin(store, config, session, teamId);
  if (access instanceof Response) return access;
  if (access.team.teamType === 'department') {
    return jsonError(
      'DEPARTMENT_TEAM_DELETE_FORBIDDEN',
      'Department teams cannot be deleted from workspace settings.',
      403,
      'Use platform admin team merge tooling.'
    );
  }

  try {
    const deleted = await store.deleteCustomTeam({ teamId, actorUserId: session.userId });
    if (!deleted) return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
    return jsonOk({ team: formatTeam(deleted, access.member) });
  } catch (error) {
    if (String(error?.message || error).includes('TEAM_HAS_BLOCKING_ASSETS')) {
      return jsonError(
        'TEAM_HAS_BLOCKING_ASSETS',
        'Team still owns sites or active access keys.',
        409,
        'Delete or transfer team sites and revoke team access keys first.'
      );
    }
    throw error;
  }
}

async function requireTeamAdmin(store, config, session, teamId) {
  const access = await requireTeamMember(store, config, session, teamId);
  if (access instanceof Response) return access;
  if (access.member.role !== 'admin') {
    return jsonError('TEAM_ADMIN_REQUIRED', 'Team admin role required.', 403, 'Ask a team admin to perform this action.');
  }
  return access;
}

async function requireTeamMember(store, config, session, teamId) {
  const team = await store.getTeam(teamId);
  if (!team || team.environment !== config.environment) {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  const member = await store.getTeamMember({ teamId, userId: session.userId });
  if (!member) return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  return { team, member };
}

function formatTeam(team, member) {
  return {
    id: team.id,
    name: team.name,
    description: team.description || null,
    teamType: team.teamType,
    departmentPath: team.departmentPath || null,
    status: team.status,
    currentUserRole: team.currentUserRole || member?.role || null,
    currentUserMembershipSource: team.currentUserMembershipSource || member?.membershipSource || null,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function formatTeamMember(member) {
  return {
    teamId: member.teamId,
    userId: member.userId,
    role: member.role,
    membershipSource: member.membershipSource,
    departmentPath: member.departmentPath || null,
    removedAt: member.removedAt || null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function invalidPathSegment() {
  return jsonError('PATH_SEGMENT_INVALID', 'Path segment is invalid.', 400, 'Use URL-encoded path segments.');
}
