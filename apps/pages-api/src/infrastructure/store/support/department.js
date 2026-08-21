import { normalizeDepartmentPath } from '../../../department-path.js';
import { fnv1a64Hex } from './common.js';
import { normalizeRequiredString } from './normalizers.js';

export function assertDepartmentMergeTeams(source, target) {
  if (!source || !target) throw new Error('TEAM_NOT_FOUND');
  if (source.id === target.id) throw new Error('TEAM_MERGE_TARGET_INVALID');
  if (source.environment !== target.environment) throw new Error('TEAM_MERGE_ENVIRONMENT_MISMATCH');
  if (source.teamType !== 'department' || target.teamType !== 'department') {
    throw new Error('TEAM_MERGE_DEPARTMENT_REQUIRED');
  }
  if (source.status !== 'active' || source.deletedAt || source.mergedIntoTeamId) {
    throw new Error('TEAM_MERGE_SOURCE_INACTIVE');
  }
  if (target.status !== 'active' || target.deletedAt) throw new Error('TEAM_MERGE_TARGET_INACTIVE');
}

export function departmentTeamId(environment, departmentPath) {
  const normalizedPath = normalizeDepartmentPath(departmentPath);
  const normalizedEnvironment = normalizeRequiredString(environment).replaceAll(/[^A-Za-z0-9]+/g, '_') || 'unknown';
  if (!normalizedPath) return 'team_department_unknown';
  return `team_department_${normalizedEnvironment}_${fnv1a64Hex(normalizedPath)}`;
}
