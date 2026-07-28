import {
  assertNoPositionals,
  createClient,
  outputJsonResult,
  readConfigForCommand,
  resolveCredential,
} from './shared.js';

export async function runTeams(parsed, context) {
  assertNoPositionals(parsed, 'TEAMS_USAGE_INVALID', 'xd-cell teams 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);
  const result = await client.requestApi('GET', '/.xd-pages/api/teams');
  const payload = { environment: config.environment, teams: result.teams || [] };
  if (outputJsonResult(parsed, context, payload)) return 0;
  outputTeamsSummary(context.output, payload.teams);
  return 0;
}

function outputTeamsSummary(output, teams) {
  if (!teams.length) {
    output('暂无团队。');
    return;
  }
  output(['团队 ID', '名称', '类型', '角色', '来源'].join('\t'));
  for (const team of teams) {
    output(
      [
        team.id || '-',
        team.name || team.departmentPath || '-',
        team.teamType || '-',
        team.currentUserRole || '-',
        team.currentUserMembershipSource || '-',
      ].join('\t')
    );
  }
}
