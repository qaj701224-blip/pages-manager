import { redactSecretLikeText } from './text.js';

function redactSlackAnalysisValue(value) {
  if (typeof value === 'string') return redactSecretLikeText(value);
  if (Array.isArray(value)) return value.map((item) => redactSlackAnalysisValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSlackAnalysisValue(entry)]));
  }
  return value;
}

export function redactSlackAnalysis(analysis) {
  return analysis ? redactSlackAnalysisValue(analysis) : analysis;
}

export function slackAgentRunModelPatch(slackAgentAnalysis) {
  return {
    provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
    model: slackAgentAnalysis?.modelName || null,
    modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
  };
}

export async function completeSlackAgentRun(store, agentRun, patch = {}) {
  if (!agentRun) return null;
  return await store.completeAgentRun(agentRun.id, patch);
}

export async function failRunningSlackAgentRunsForClosedSession(store, slackSessionId, options = {}) {
  if (!slackSessionId || !store?.listAgentRunsForSlackSession || !store?.failAgentRun) return [];

  const excludeAgentRunId = options.excludeAgentRunId || null;
  const runs = await store.listAgentRunsForSlackSession(slackSessionId);
  const failed = [];
  for (const run of runs) {
    if (run.agentKind !== 'slack_agent' || run.status !== 'running' || (excludeAgentRunId && run.id === excludeAgentRunId)) {
      continue;
    }

    const failedRun = await store.failAgentRun(
      run.id,
      'slack_session_closed',
      'Slack session was closed before the agent run completed.'
    );
    if (failedRun) failed.push(failedRun);
  }
  await store.clearSlackAgentLeaseForSession?.(slackSessionId);
  return failed;
}
