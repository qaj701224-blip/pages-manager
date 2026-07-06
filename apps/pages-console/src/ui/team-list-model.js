export function buildTeamCards(teams) {
  return (Array.isArray(teams) ? teams : []).map((team) => ({
    id: team.id,
    name: team.name || team.id || '团队',
    avatarText: firstAvatarText(team.name || team.id || 'T'),
    description: team.description || team.departmentPath || '暂无描述',
    roleLabel: team.currentUserRole || 'viewer',
    typeLabel: team.teamType === 'department' ? '部门团队' : '',
    siteCount: Math.max(0, Number(team.siteCount || 0)),
    memberCount: Math.max(0, Number(team.memberCount || 0)),
  }));
}

export function buildTeamFilterOptions(teams) {
  return [
    { value: '', label: '全部团队' },
    ...(Array.isArray(teams) ? teams : []).map((team) => ({
      value: team.id,
      label: team.name || team.id,
    })),
  ];
}

function firstAvatarText(value) {
  return String(value || 'T').trim().slice(0, 1) || 'T';
}
