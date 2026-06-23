import {
  buildPlatformAgentInputs,
  dispatchWorkflow,
  ensurePlatformDevIssue,
} from '@xd/git-client';

import { postExecutorCallback } from '../integrations/gateway-client.js';

function shouldDispatchPlatformAgent(item = {}) {
  if (!item.agentEligible) return false;
  if (item.requiresHumanGate && item.gateStatus !== 'approved') return false;
  return true;
}

function platformAgentMode(item = {}) {
  const fixStatuses = ['agent_queued', 'ci_failed', 'review_blocked', 'ready_to_merge', 'pr_created'];
  return fixStatuses.includes(item.status) && item.githubPrNumber ? 'fix' : 'initial';
}

function stageResultForIssueCreated(item = {}) {
  if (item.requiresHumanGate && item.gateStatus !== 'approved') return 'gate_pending';
  if (item.status === 'agent_queued') return 'agent_queued';
  return 'issue_created';
}

export async function startPlatformDevItem(item, config, adapters = {}) {
  const fetchImpl = adapters.fetchImpl || fetch;
  const callback = adapters.postExecutorCallback || postExecutorCallback;
  const github = config.github;

  const issueResult = await ensurePlatformDevIssue(fetchImpl, github, item, {
    baseRef: config.platformBaseRef || config.workflowRef || 'master',
  });
  const issueNumber = issueResult.issue.number;
  const issueUrl = issueResult.issue.html_url || issueResult.issue.url || null;

  await callback(fetchImpl, config, {
    workItemKind: 'platform_dev',
    platformDevItemId: item.id,
    executorType: 'pages_worker',
    status: 'succeeded',
    stageResult: stageResultForIssueCreated(item),
    issueNumber,
    issueUrl,
  });

  if (!shouldDispatchPlatformAgent(item)) {
    return {
      action: item.requiresHumanGate ? 'platform_issue_created_waiting_for_gate' : 'platform_issue_created',
      issueNumber,
      issueUrl,
      issueCreated: issueResult.created,
    };
  }

  const itemWithIssue = { ...item, githubIssueNumber: issueNumber, githubIssueUrl: issueUrl };
  const mode = platformAgentMode(itemWithIssue);
  const workflow = await dispatchWorkflow(fetchImpl, github, {
    workflowId: 'platform-agent.yml',
    ref: config.platformWorkflowRef || config.workflowRef || 'master',
    inputs: buildPlatformAgentInputs(itemWithIssue, {
      mode,
      baseRef: config.platformBaseRef || config.platformWorkflowRef || config.workflowRef || 'master',
      callbackUrl: config.callbackUrl,
      issueNumber,
      gateApproved: itemWithIssue.gateStatus === 'approved' || itemWithIssue.requiresHumanGate === false,
    }),
  });

  await callback(fetchImpl, config, {
    workItemKind: 'platform_dev',
    platformDevItemId: item.id,
    executorType: 'pages_worker',
    status: 'succeeded',
    stageResult: 'agent_running',
    issueNumber,
    issueUrl,
  });

  return {
    action: mode === 'fix' ? 'platform_agent_fix_dispatched' : 'platform_issue_created_and_agent_dispatched',
    issueNumber,
    issueUrl,
    issueCreated: issueResult.created,
    workflow,
  };
}
