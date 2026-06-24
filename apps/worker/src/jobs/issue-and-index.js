import {
  buildProjectIndexInputs,
  dispatchWorkflow,
  ensurePublishingIssue,
  ensureSmokeIssue,
} from '@xd/git-client';

import { postExecutorCallback } from '../integrations/gateway-client.js';

export async function startIssueAndIndex(job, config, adapters = {}) {
  const fetchImpl = adapters.fetchImpl || fetch;
  const callback = adapters.postExecutorCallback || postExecutorCallback;
  const github = config.github;

  const issueResult =
    config.issueMode === 'smoke_single'
      ? await ensureSmokeIssue(fetchImpl, github, job, { scope: config.smokeIssueScope })
      : await ensurePublishingIssue(fetchImpl, github, job, {
          baseRef: config.baseRef,
        });
  const issueNumber = issueResult.issue.number;
  console.log(
    JSON.stringify({
      service: 'pages-worker',
      message: 'issue_ready',
      jobId: job.id,
      issueNumber,
      issueUrl: issueResult.issue.html_url || issueResult.issue.url || null,
      issueCreated: issueResult.created,
      issueMode: config.issueMode || 'per_job',
      executorMode: config.executorMode || 'actions',
    })
  );

  if (config.executorMode === 'issue_only' || (config.executorMode === 'github_issue_webhook' && issueResult.created)) {
    await callback(fetchImpl, config, {
      publishingJobId: job.id,
      executorType: 'pages_worker',
      status: 'succeeded',
      stageResult: 'issue_created',
      issueNumber,
      issueUrl: issueResult.issue.html_url || issueResult.issue.url || null,
    });
    return {
      action: config.executorMode === 'github_issue_webhook' ? 'issue_created_waiting_for_github_issue_webhook' : 'issue_created',
      issueNumber,
      issueUrl: issueResult.issue.html_url || issueResult.issue.url || null,
      issueCreated: issueResult.created,
    };
  }

  const jobWithIssue = { ...job, issueNumber };
  const workflow = await dispatchWorkflow(fetchImpl, github, {
    workflowId: 'project-index.yml',
    ref: config.workflowRef,
    inputs: buildProjectIndexInputs(jobWithIssue, {
      baseRef: config.baseRef,
      callbackUrl: config.callbackUrl,
      issueNumber,
    }),
  });

  await callback(fetchImpl, config, {
    publishingJobId: job.id,
    executorType: 'pages_worker',
    status: 'succeeded',
    stageResult: 'issue_created',
    issueNumber,
    issueUrl: issueResult.issue.html_url || issueResult.issue.url || null,
  });

  return {
    action: 'issue_created_and_project_index_dispatched',
    issueNumber,
    issueUrl: issueResult.issue.html_url || issueResult.issue.url || null,
    issueCreated: issueResult.created,
    workflow,
  };
}
