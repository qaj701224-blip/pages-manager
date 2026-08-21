const XDS_COMPANY_ROOTS = new Set(['心动']);

export function normalizeDepartmentPath(value) {
  return typeof value === 'string'
    ? value
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
        .join('/')
    : '';
}

export function deriveDepartmentTeamIdentity(departmentPath) {
  const fullPath = normalizeDepartmentPath(departmentPath);
  const segments = fullPath ? fullPath.split('/') : [];
  const teamSegments = shouldCollapseXdsCompanyPath(segments) ? segments.slice(0, 3) : segments;
  const teamPath = teamSegments.join('/');
  const displayName = teamSegments.at(-1) || '';

  return {
    fullPath,
    teamPath,
    displayName,
  };
}

export function departmentTeamDisplayName(team = {}) {
  if (team.teamType !== 'department') return String(team.name || team.id || '').trim();
  const name = String(team.name || team.id || '').trim();
  const identity = deriveDepartmentTeamIdentity(team.departmentPath || team.name);
  if (identity.teamPath && identity.teamPath !== identity.fullPath) return identity.displayName;
  return name || identity.displayName;
}

function shouldCollapseXdsCompanyPath(segments) {
  return segments.length >= 4 && XDS_COMPANY_ROOTS.has(segments[0]);
}
