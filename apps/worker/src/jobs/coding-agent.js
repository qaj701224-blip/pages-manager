import { appendFollowupIssueComment, buildPagesAgentInputs, dispatchWorkflow } from '@xd/git-client';

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
  const github = config.github;
  const mode = job.status === 'fixing' ? 'fix' : 'initial';
  const issueComment = mode === 'fix' ? await appendFollowupIssueComment(fetchImpl, github, job, { mode }) : null;

  const workflow = await dispatchWorkflow(fetchImpl, github, {
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

  return {
    action: mode === 'fix' ? 'pages_agent_fix_dispatched' : 'pages_agent_dispatched',
    ...(issueComment ? { issueComment } : {}),
    workflow,
  };
}
