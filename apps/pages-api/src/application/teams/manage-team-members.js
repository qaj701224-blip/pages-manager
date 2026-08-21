export function createTeamMemberManagement({ teams, users, members }) {
  if (typeof teams?.get !== 'function') throw new TypeError('teams.get is required');
  if (typeof users?.get !== 'function') throw new TypeError('users.get is required');
  if (typeof members?.get !== 'function') throw new TypeError('members.get is required');
  if (typeof members?.list !== 'function') throw new TypeError('members.list is required');
  if (typeof members?.upsert !== 'function') throw new TypeError('members.upsert is required');
  if (typeof members?.remove !== 'function') throw new TypeError('members.remove is required');

  return { update, remove };

  async function update(command) {
    const access = await authorize(command);
    if (!access.ok) return access;

    const user = await users.get(command.userId);
    if (!user) return denied('user_not_found');
    if (!(await canChangeAdminRole(command.teamId, command.userId, command.role))) {
      return denied('last_admin');
    }

    return {
      ok: true,
      member: await members.upsert({
        teamId: command.teamId,
        userId: command.userId,
        role: command.role,
        membershipSource: 'manual',
        actorUserId: command.actorUserId,
      }),
    };
  }

  async function remove(command) {
    const access = await authorize(command);
    if (!access.ok) return access;
    if (!(await canRemove(command.teamId, command.userId))) return denied('last_admin');

    const member = await members.remove({
      teamId: command.teamId,
      userId: command.userId,
      actorUserId: command.actorUserId,
    });
    return member ? { ok: true, member } : denied('member_not_found');
  }

  async function authorize(command) {
    const team = await teams.get(command.teamId);
    if (!team || team.environment !== command.environment || team.deletedAt) return denied('team_not_found');
    if (command.capability === 'platform_admin') return { ok: true, team };
    if (team.status !== 'active') return denied('team_not_found');

    const actor = await members.get({ teamId: team.id, userId: command.actorUserId });
    if (!actor) return denied('team_not_found');
    if (actor.role !== 'admin') return denied('team_admin_required');
    return { ok: true, team };
  }

  async function canChangeAdminRole(teamId, userId, nextRole) {
    if (nextRole === 'admin') return true;
    const member = await members.get({ teamId, userId });
    if (!member || member.role !== 'admin') return true;
    return hasAnotherActiveAdmin(teamId, userId);
  }

  async function canRemove(teamId, userId) {
    const member = await members.get({ teamId, userId });
    if (!member || member.role !== 'admin') return true;
    return hasAnotherActiveAdmin(teamId, userId);
  }

  async function hasAnotherActiveAdmin(teamId, userId) {
    return (await members.list({ teamId })).some(
      (member) =>
        member.userId !== userId &&
        !member.removedAt &&
        member.role === 'admin' &&
        member.user?.employeeStatus === 'active'
    );
  }
}

function denied(reason) {
  return { ok: false, reason };
}
