export function buildTeamCards(teams) {
  return (Array.isArray(teams) ? teams : []).map((team) => ({
    id: team.id,
    name: team.name || team.id || '团队',
    avatarText: firstAvatarText(team.name || team.id || 'T'),
    summary: teamSummary(team),
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

function teamSummary(team) {
  if (team?.teamType !== 'department') return team?.description || '暂无描述';

  const departmentPath = departmentTeamPath(team.departmentPath);
  return departmentPath ? `部门路径：${departmentPath}` : '部门路径由企业 SSO 同步';
}

function departmentTeamPath(value) {
  const path = normalizeDepartmentPath(value);
  const segments = path ? path.split('/') : [];
  if (segments.length >= 4 && segments[0] === '心动') return segments.slice(0, 3).join('/');
  return path;
}

function normalizeDepartmentPath(value) {
  return typeof value === 'string'
    ? value
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
        .join('/')
    : '';
}
