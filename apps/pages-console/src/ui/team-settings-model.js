export function canEditTeamSettings(team) {
  return team?.teamType === 'custom' && team?.currentUserRole === 'admin';
}

export function canDeleteTeam(team) {
  return canEditTeamSettings(team);
}

export function getTeamSettingsReadOnlyReason(team) {
  if (team?.teamType === 'department') return '部门团队信息由 XDS 部门路径同步，不能在工作台编辑或删除。';
  if (team?.currentUserRole !== 'admin') return '仅团队 admin 可编辑团队信息或删除团队。';
  return '';
}

export function normalizeTeamSettingsForm(form) {
  const name = String(form?.name || '').trim();
  if (!name) {
    const error = new Error('Team name is required.');
    error.code = 'TEAM_NAME_REQUIRED';
    throw error;
  }
  const description = String(form?.description || '').trim();
  return {
    name,
    description: description || null,
  };
}

export function getTeamDeleteErrorMessage(error) {
  if (error?.code === 'TEAM_HAS_BLOCKING_ASSETS') {
    return '团队仍拥有站点或有效 Access Key。请先手动删除或转移团队站点，并撤销团队 Access Keys。';
  }
  if (error?.code === 'DEPARTMENT_TEAM_DELETE_FORBIDDEN') return '部门团队不能在工作台删除。';
  if (error?.code === 'TEAM_ADMIN_REQUIRED') return '仅团队 admin 可删除团队。';
  return '删除团队失败，请稍后重试。';
}
