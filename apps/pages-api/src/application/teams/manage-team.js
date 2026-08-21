export function createTeamManagement({ teams, members }) {
  if (typeof teams?.get !== 'function') throw new TypeError('teams.get is required');
  if (typeof members?.get !== 'function') throw new TypeError('members.get is required');

  return { updateSettings, deleteTeam };

  async function updateSettings(command) {
    const access = await authorize(command);
    if (!access.ok) return access;
    if (access.team.teamType === 'department') return denied('department_settings_readonly');
    if (typeof teams.updateSettings !== 'function') return denied('settings_unsupported');

    return {
      ok: true,
      team: await teams.updateSettings({
        teamId: access.team.id,
        name: command.name,
        description: command.description,
        actorUserId: command.actorUserId,
      }),
    };
  }

  async function deleteTeam(command) {
    const access = await authorize(command);
    if (!access.ok) return access;
    if (access.team.teamType === 'department') return denied('department_delete_forbidden');
    if (typeof teams.deleteCustom !== 'function') return denied('team_not_found');

    try {
      const team = await teams.deleteCustom({ teamId: access.team.id, actorUserId: command.actorUserId });
      return team ? { ok: true, team } : denied('team_not_found');
    } catch (error) {
      if (String(error?.message || error).includes('TEAM_HAS_BLOCKING_ASSETS')) {
        return denied('blocking_assets');
      }
      throw error;
    }
  }

  async function authorize(command) {
    const team = await teams.get(command.teamId);
    if (!team || team.environment !== command.environment || team.deletedAt) return denied('team_not_found');
    if (command.capability === 'platform_admin') return { ok: true, team };
    if (team.status !== 'active') return denied('team_not_found');

    const member = await members.get({ teamId: team.id, userId: command.actorUserId });
    if (!member) return denied('team_not_found');
    if (member.role !== 'admin') return denied('team_admin_required');
    return { ok: true, team, member };
  }
}

function denied(reason) {
  return { ok: false, reason };
}
