export function normalizeTeamName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

export function normalizeNullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 500) : null;
}

export function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function normalizeUserEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeTeamRole(role) {
  if (role === 'viewer' || role === 'publisher' || role === 'admin') return role;
  throw new Error('TEAM_ROLE_INVALID');
}
