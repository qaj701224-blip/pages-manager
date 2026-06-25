import { appendFollowupIssueComment, buildPagesAgentInputs, dispatchWorkflow } from '@xd/git-client';

import { postExecutorCallback } from '../integrations/gateway-client.js';

function safeBranchSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function pagesAgentBranchName(job, config) {
  if (job.branchName) return job.branchName;
  if (config.prMode !== 'smoke_single') return '';
  if (config.smokePrBranch) return config.smokePrBranch;

  return [
    'sites',
    [
      'smoke',
      safeBranchSegment(config.smokeIssueScope || 'local-slack-smoke'),
      safeBranchSegment(job.employeeSlug),
      safeBranchSegment(job.siteSlug),
    ]
      .filter(Boolean)
      .join('-'),
  ].join('/');
}

export async function startPagesAgent(job, config, adapters = {}) {
  const fetchImpl = adapters.fetchImpl || fetch;
  const callback = adapters.postExecutorCallback || postExecutorCallback;
  const github = config.github;
  const mode = job.status === 'fixing' ? 'fix' : 'initial';
  let issueComment = null;
  let failureCode = 'pages_agent_dispatch_failed';

  let workflow;
  try {
    if (mode === 'fix') {
      failureCode = 'pages_agent_followup_comment_failed';
      issueComment = await appendFollowupIssueComment(fetchImpl, github, job, { mode });
    }

    failureCode = 'pages_agent_dispatch_failed';
    workflow = await dispatchWorkflow(fetchImpl, github, {
      workflowId: 'pages-agent.yml',
      ref: config.workflowRef,
      inputs: buildPagesAgentInputs(job, {
        mode,
        baseRef: config.baseRef,
        issueNumber: job.issueNumber,
        indexSnapshotId: job.indexSnapshotId,
        callbackUrl: config.callbackUrl,
        branchName: pagesAgentBranchName(job, config),
      }),
    });
  } catch (error) {
    if (mode === 'fix') {
      await callback(fetchImpl, config, {
        publishingJobId: job.id,
        executorType: 'pages_worker',
        status: 'failed',
        errorCode: failureCode,
        errorMessage: error?.message || 'Failed to dispatch pages-agent.yml',
      });
    }
    throw error;
  }

  return {
    action: mode === 'fix' ? 'pages_agent_fix_dispatched' : 'pages_agent_dispatched',
    ...(issueComment ? { issueComment } : {}),
    workflow,
  };
}
