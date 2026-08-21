import { deriveDepartmentTeamIdentity } from './department-path.js';
import { cloneRecord } from './support/index.js';

export function createTestPagesMetadataStore({ now = () => new Date().toISOString() } = {}) {
  const users = new Map();
  const teams = new Map();
  const memberships = new Map();

  return {
    async createUser(input) {
      const timestamp = now();
      const user = {
        id: input.userId || input.id,
        email: normalizeEmail(input.email),
        realname: input.realname || null,
        account: input.account || null,
        accountId: input.accountId || null,
        employeenum: input.employeenum || null,
        employeeStatus: input.employeeStatus || 'unknown',
        feishuOpenId: input.feishuOpenId || null,
        cindyMembershipId: input.cindyMembershipId || null,
        createdSource: input.createdSource || 'xd_sso',
        departmentPath: input.departmentPath || null,
        departmentCheckedAt: input.departmentCheckedAt || null,
        sessionVersion: input.sessionVersion || 1,
        lastLoginAt: input.lastLoginAt || null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      users.set(user.id, user);
      return cloneRecord(user);
    },

    async upsertUserFromSso(input) {
      const normalizedEmail = normalizeEmail(input.email);
      const existing =
        users.get(input.userId || input.id) || [...users.values()].find((user) => user.email === normalizedEmail) || null;
      const timestamp = input.updatedAt || now();
      const user = {
        ...existing,
        id: existing?.id || input.userId || input.id,
        email: normalizedEmail,
        realname: input.realname || existing?.realname || null,
        account: input.account || existing?.account || null,
        accountId: input.accountId || existing?.accountId || null,
        employeenum: input.employeenum || existing?.employeenum || null,
        employeeStatus: input.employeeStatus || existing?.employeeStatus || 'unknown',
        feishuOpenId: existing?.feishuOpenId || null,
        cindyMembershipId: existing?.cindyMembershipId || null,
        createdSource: existing?.createdSource || 'xd_sso',
        departmentPath: input.departmentPath || existing?.departmentPath || null,
        departmentCheckedAt: input.departmentCheckedAt || existing?.departmentCheckedAt || null,
        sessionVersion: input.sessionVersion || existing?.sessionVersion || 1,
        lastLoginAt: input.lastLoginAt || timestamp,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      users.set(user.id, user);
      return cloneRecord(user);
    },

    async getUser(userId) {
      return cloneRecord(users.get(userId) || null);
    },

    async updateUserDepartmentFromDirectory({ userId, departmentPath, departmentCheckedAt }) {
      const user = users.get(userId);
      if (!user) return null;
      Object.assign(user, { departmentPath, departmentCheckedAt, updatedAt: departmentCheckedAt || now() });
      return cloneRecord(user);
    },

    async hydrateDepartmentMembership({ environment, userId, departmentPath }) {
      const identity = deriveDepartmentTeamIdentity(departmentPath);
      const teamId = `${environment}:${identity.teamPath}`;
      const team = teams.get(teamId) || {
        id: teamId,
        environment,
        name: identity.displayName || identity.teamPath,
        teamType: 'department',
        departmentPath: identity.teamPath,
      };
      teams.set(teamId, team);
      const member = {
        teamId,
        userId,
        role: 'admin',
        membershipSource: 'department_auto',
        departmentPath,
        removedAt: null,
      };
      memberships.set(`${teamId}:${userId}`, member);
      return { team: cloneRecord(team), member: cloneRecord(member), restored: true };
    },

    async listTeamsForUser({ environment, userId }) {
      return [...memberships.values()]
        .filter((member) => member.userId === userId && !member.removedAt)
        .map((member) => ({
          ...cloneRecord(teams.get(member.teamId)),
          currentUserRole: member.role,
          currentUserMembershipSource: member.membershipSource,
        }))
        .filter((team) => !environment || team.environment === environment);
    },
  };
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
