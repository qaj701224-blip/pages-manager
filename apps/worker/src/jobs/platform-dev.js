import {
  buildPlatformAgentInputs,
  dispatchWorkflow,
  ensurePlatformDevIssue,
} from '@xd/git-client';

import { postExecutorCallback } from '../integrations/gateway-client.js';

function shouldDispatchPlatformAgent(item = {}) {
  if (!item.agentEligible) return false;
  if (item.autoDevStatus !== 'triggered') return false;
  if (item.status === 'received') return false;
  return true;
}

function platformAgentMode(item = {}) {
  const fixStatuses = ['ci_failed', 'review_blocked', 'ready_to_merge', 'pr_created'];
  if (item.status === 'agent_queued' && item.githubPrNumber) return 'fix';
  return fixStatuses.includes(item.status) && item.githubPrNumber ? 'fix' : 'initial';
}

function stageResultForIssueCreated(item = {}) {
  if (item.autoDevStatus !== 'triggered') return 'auto_dev_pending';
  if (item.status === 'received') return 'auto_dev_pending';
  if (item.status === 'agent_queued') return 'agent_queued';
  return 'issue_created';
}

function contextText(value = '', maxLength = 12_000) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

function followupContextFromSummary(summary = '') {
  const text = String(summary || '');
  const marker = '## Slack Follow-up';
  const index = text.lastIndexOf(marker);
  return index >= 0 ? contextText(text.slice(index)) : '';
}

function platformAgentContextInputs(item = {}) {
  return {
    reviewContext: contextText(item.reviewContext),
    memoryContext: contextText(item.memoryContext),
    statusContext: contextText(item.statusContext),
    followupContext: contextText(item.followupContext || followupContextFromSummary(item.summary)),
  };
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

  if (!shouldDispatchPlatformAgent(item)) {
    await callback(fetchImpl, config, {
      workItemKind: 'platform_dev',
      platformDevItemId: item.id,
      executorType: 'pages_worker',
      status: 'succeeded',
      stageResult: stageResultForIssueCreated(item),
      issueNumber,
      issueUrl,
    });
    return {
      action: item.autoDevStatus === 'triggered' ? 'platform_issue_created' : 'platform_issue_created_waiting_for_auto_dev',
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
      prNumber: itemWithIssue.githubPrNumber,
      headSha: itemWithIssue.headSha,
      autoDevTriggered: itemWithIssue.autoDevStatus === 'triggered',
      ...platformAgentContextInputs(itemWithIssue),
    }),
  });

  await callback(fetchImpl, config, {
    workItemKind: 'platform_dev',
    platformDevItemId: item.id,
    executorType: 'pages_worker',
    status: 'succeeded',
    stageResult: stageResultForIssueCreated(item),
    issueNumber,
    issueUrl,
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
