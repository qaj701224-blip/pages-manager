import { accessModeFromVisibility } from '@xd/pages-access-policy';
import { departmentTeamDisplayName } from '@xd/pages-metadata';

export function createAdminUsersQuery({ users }) {
  if (typeof users?.list !== 'function') throw new TypeError('users.list is required');
  return {
    async list(query) {
      const result = await users.list(query);
      return {
        users: result.users.map(projectAdminUser),
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        },
      };
    },
  };
}

export function createAdminSitesQuery({ sites }) {
  if (typeof sites?.list !== 'function') throw new TypeError('sites.list is required');
  return {
    async list(query) {
      return (await sites.list(query)).map(projectAdminSite);
    },
  };
}

export function createAdminTeamsQuery({ teams }) {
  if (typeof teams?.list !== 'function') throw new TypeError('teams.list is required');
  return {
    async list(query) {
      return (await teams.list(query)).map(projectAdminTeam);
    },
  };
}

export function projectAdminUser(user) {
  return {
    id: user.id,
    email: user.email,
    realname: user.realname || null,
    employeeStatus: user.employeeStatus,
    departmentPath: user.departmentPath || null,
    isPlatformAdmin: Boolean(user.isPlatformAdmin),
    lastLoginAt: user.lastLoginAt || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function projectAdminSite(site) {
  return {
    id: site.id,
    slug: site.slug,
    hostname: site.route?.hostname || null,
    owner: {
      type: site.ownerType || 'user',
      id: site.ownerId || site.ownerUserId,
      email: site.ownerEmail || null,
      displayName: site.ownerDisplayName || null,
      departmentPath: site.ownerDepartmentPath || null,
      teamType: site.ownerTeamType || null,
    },
    deploymentShape: site.deploymentShape ?? null,
    exposure: site.route?.exposure || site.defaultExposure || 'internal',
    visibility: site.route?.visibility || site.defaultVisibility,
    status: site.route?.routeStatus || 'active',
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

export function projectAdminSiteDetail(site) {
  return {
    ...projectAdminSite(site),
    access: {
      exposure: site.route?.exposure || site.defaultExposure || 'internal',
      accessMode: site.route?.accessMode || accessModeFromVisibility(site.route?.visibility || site.defaultVisibility),
      visibility: site.route?.visibility || site.defaultVisibility,
    },
    permissions: {
      role: 'admin',
      canManage: true,
      canManageAccess: true,
    },
  };
}

export function projectAdminTeam(team) {
  return {
    id: team.id,
    name: departmentTeamDisplayName(team),
    description: team.description || null,
    teamType: team.teamType,
    departmentPath: team.departmentPath || null,
    status: team.status,
    mergedIntoTeamId: team.mergedIntoTeamId || null,
    mergedAt: team.mergedAt || null,
    mergedByUserId: team.mergedByUserId || null,
    mergeReason: team.mergeReason || null,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export function projectAdminTeamMember(member) {
  return {
    teamId: member.teamId,
    userId: member.userId,
    user: member.user ? projectConsoleUser(member.user) : null,
    role: member.role,
    membershipSource: member.membershipSource,
    departmentPath: member.departmentPath || null,
    removedAt: member.removedAt || null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

function projectConsoleUser(user) {
  return {
    id: user.id,
    email: user.email || null,
    realname: user.realname || null,
    account: user.account || null,
    departmentPath: user.departmentPath || null,
    employeeStatus: user.employeeStatus || null,
  };
}
