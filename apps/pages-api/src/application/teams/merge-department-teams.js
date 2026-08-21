const EXPECTED_ERRORS = new Set([
  'TEAM_NOT_FOUND',
  'TEAM_MERGE_TARGET_INVALID',
  'TEAM_MERGE_ENVIRONMENT_MISMATCH',
  'TEAM_MERGE_DEPARTMENT_REQUIRED',
  'TEAM_MERGE_SOURCE_INACTIVE',
  'TEAM_MERGE_TARGET_INACTIVE',
]);

export function createDepartmentTeamMerge({ teams }) {
  if (typeof teams?.merge !== 'function') throw new TypeError('teams.merge is required');

  return { execute };

  async function execute(command) {
    try {
      return {
        ok: true,
        merge: await teams.merge({
          sourceTeamId: command.sourceTeamId,
          targetTeamId: command.targetTeamId,
          actorUserId: command.actorUserId,
          reason: command.reason,
          environment: command.environment,
        }),
      };
    } catch (error) {
      const errorCode = String(error?.message || '').split(':', 1)[0];
      if (EXPECTED_ERRORS.has(errorCode)) return { ok: false, errorCode };
      throw error;
    }
  }
}
