import { githubApiUrl, githubRequest, parseRepoFullName } from '@xd/git-client';

import { notifySlackJobStatus } from '../slack/notifier.js';
import { normalizeSlackWorkItemQueryState, slackWorkItemIncludesInactive } from '../slack/work-item-query.js';
import { isActionableSlackWorkItem, listSlackWorkItemsForSession } from '../slack/work-items.js';
import { issueUrl } from './webhook.js';

export async function cancelJobForClosedGithubIssue(store, job, issue = {}) {
  const message = issue.number
    ? `GitHub issue #${issue.number} 已关闭，发布任务已停止。`
    : 'GitHub issue 已关闭，发布任务已停止。';
  if (store.cancelJob) {
    return await store.cancelJob(job.id, 'github_issue_closed', message);
  }
  return await store.patchJob(job.id, {
    status: 'cancelled',
    errorCode: 'github_issue_closed',
    errorMessage: message,
  });
}

export async function cancelJobForClosedGithubPr(store, job, pullRequest = {}) {
  const message = pullRequest.number
    ? `GitHub PR #${pullRequest.number} 已关闭，发布任务已停止。`
    : 'GitHub PR 已关闭，发布任务已停止。';
  if (store.cancelJob) {
    return await store.cancelJob(job.id, 'github_pr_closed', message);
  }
  return await store.patchJob(job.id, {
    status: 'cancelled',
    errorCode: 'github_pr_closed',
    errorMessage: message,
  });
}

function gatewayGithubConfig(env = {}) {
  const token = env.GITHUB_STATUS_TOKEN || env.GITHUB_APP_INSTALLATION_TOKEN || env.GITHUB_TOKEN;
  const repoFullName = env.GITHUB_REPO || env.GITHUB_REPOSITORY;
  if (!token || !repoFullName) return null;
  return {
    apiBaseUrl: env.GITHUB_ENTERPRISE_API_BASE_URL || env.GITHUB_API_BASE_URL || 'https://api.github.com',
    token,
    repoFullName,
  };
}

function gatewayGithubWriteConfig(env = {}) {
  const token = env.GITHUB_APP_INSTALLATION_TOKEN || env.GITHUB_TOKEN || env.GITHUB_STATUS_TOKEN;
  const repoFullName = env.GITHUB_REPO || env.GITHUB_REPOSITORY;
  if (!token || !repoFullName) return null;
  return {
    apiBaseUrl: env.GITHUB_ENTERPRISE_API_BASE_URL || env.GITHUB_API_BASE_URL || 'https://api.github.com',
    token,
    repoFullName,
  };
}

function githubIssueIsClosed(issue = {}) {
  if (!issue) return false;
  return issue.state === 'closed' || Boolean(issue.closed_at);
}

function githubPullRequestIsClosed(pullRequest = {}) {
  if (!pullRequest) return false;
  return pullRequest.state === 'closed' && !pullRequest.merged;
}

async function fetchGithubIssueForJob(env = {}, job = {}) {
  const config = gatewayGithubConfig(env);
  if (!config || !job?.issueNumber) return null;

  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const fetchImpl = env.GITHUB_STATUS_FETCH || env.GITHUB_FETCH || fetch;
  const result = await githubRequest(fetchImpl, config, {
    method: 'GET',
    url: githubApiUrl(config, `/repos/${owner}/${repo}/issues/${job.issueNumber}`),
  });
  return result.body || null;
}

async function fetchGithubPullRequestForJob(env = {}, job = {}) {
  const config = gatewayGithubConfig(env);
  if (!config || !job?.prNumber) return null;

  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const fetchImpl = env.GITHUB_STATUS_FETCH || env.GITHUB_FETCH || fetch;
  const result = await githubRequest(fetchImpl, config, {
    method: 'GET',
    url: githubApiUrl(config, `/repos/${owner}/${repo}/pulls/${job.prNumber}`),
  });
  return result.body || null;
}

function pullRequestUrl(pullRequest = {}) {
  return pullRequest.html_url || pullRequest.url || null;
}

function restoredStatusForReopenedGithubResource(job = {}, target = '') {
  if (target === 'pr' || job.prNumber) return 'reviewing';
  return 'generating_page';
}

export async function restoreJobForReopenedGithubResource(store, job, target, resource = {}) {
  const patch = {
    status: restoredStatusForReopenedGithubResource(job, target),
    errorCode: null,
    errorMessage: null,
  };
  if (target === 'issue') {
    patch.issueNumber = resource.number || job.issueNumber || null;
    patch.issueUrl = issueUrl(resource) || job.issueUrl || null;
  }
  if (target === 'pr') {
    patch.prNumber = resource.number || job.prNumber || null;
    patch.prUrl = pullRequestUrl(resource) || job.prUrl || null;
  }
  return await store.patchJob(job.id, patch);
}

export async function reopenGithubResourceForJob(env = {}, job = {}, target = '') {
  const config = gatewayGithubWriteConfig(env);
  if (!config) {
    const error = new Error('GitHub write token is not configured');
    error.status = 503;
    throw error;
  }

  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const fetchImpl = env.GITHUB_FETCH || env.GITHUB_STATUS_FETCH || fetch;
  const number = target === 'pr' ? job.prNumber : job.issueNumber;
  if (!number) {
    const error = new Error(target === 'pr' ? 'PR number is missing' : 'Issue number is missing');
    error.status = 400;
    throw error;
  }

  const pathname = target === 'pr' ? `/repos/${owner}/${repo}/pulls/${number}` : `/repos/${owner}/${repo}/issues/${number}`;
  const result = await githubRequest(fetchImpl, config, {
    method: 'PATCH',
    url: githubApiUrl(config, pathname),
    body: { state: 'open' },
  });
  return result.body || null;
}

export async function reconcileClosedGithubIssueForJob(store, env, job, options = {}) {
  if (!job?.id || job.status === 'cancelled') return job;

  let updatedJob = job;
  let issue = null;
  if (job.issueNumber) {
    try {
      issue = await fetchGithubIssueForJob(env, job);
    } catch (err) {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'github_issue_state_reconcile_failed',
          jobId: job.id,
          issueNumber: job.issueNumber,
          error: err.message,
        })
      );
    }
  }

  if (githubIssueIsClosed(issue)) {
    const nextIssueUrl = issueUrl(issue) || job.issueUrl || null;
    if (nextIssueUrl !== job.issueUrl) {
      updatedJob = await store.patchJob(job.id, { issueUrl: nextIssueUrl });
    }
    updatedJob = await cancelJobForClosedGithubIssue(store, updatedJob, issue);
    await store.linkJobToSlackSession(updatedJob);

    if (options.notifySlack) {
      await notifySlackJobStatus(env, store, updatedJob, {
        stage: 'cancelled',
        cardTitle: 'Issue 已关闭',
        text: 'GitHub issue 已关闭，当前发布任务已停止。',
        statusText: ':white_check_mark: GitHub issue 已关闭，任务已停止。',
        skipDuplicate: false,
        dedupeKey: `github-issue-reconciled-closed:${updatedJob.id}:${updatedJob.issueNumber || 'unknown'}`,
      });
    }

    return updatedJob;
  }

  let pullRequest = null;
  if (updatedJob.prNumber) {
    try {
      pullRequest = await fetchGithubPullRequestForJob(env, updatedJob);
    } catch (err) {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'github_pr_state_reconcile_failed',
          jobId: updatedJob.id,
          prNumber: updatedJob.prNumber,
          error: err.message,
        })
      );
    }
  }

  if (!githubPullRequestIsClosed(pullRequest)) return updatedJob;

  const nextPrUrl = pullRequestUrl(pullRequest) || updatedJob.prUrl || null;
  if (nextPrUrl !== updatedJob.prUrl) {
    updatedJob = await store.patchJob(updatedJob.id, { prUrl: nextPrUrl });
  }
  updatedJob = await cancelJobForClosedGithubPr(store, updatedJob, pullRequest);
  await store.linkJobToSlackSession(updatedJob);

  if (options.notifySlack) {
    await notifySlackJobStatus(env, store, updatedJob, {
      stage: 'cancelled',
      cardTitle: 'PR 已关闭',
      text: 'GitHub PR 已关闭，当前发布任务已停止。',
      statusText: ':white_check_mark: GitHub PR 已关闭，任务已停止。',
      skipDuplicate: false,
      dedupeKey: `github-pr-reconciled-closed:${updatedJob.id}:${updatedJob.prNumber || 'unknown'}`,
    });
  }

  return updatedJob;
}

export async function listReconciledSlackWorkItemsForSession(store, body, env, options = {}) {
  const displayLimit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
  const reconcileLimit = options.reconcileLimit || Math.max(displayLimit, 20);
  const workItemState = normalizeSlackWorkItemQueryState(options.workItemState || (options.includeInactive ? 'all' : 'active'));
  const result = await listSlackWorkItemsForSession(store, body, {
    ...options,
    limit: reconcileLimit,
    workItemState,
  });
  const reconciledJobs = [];

  for (const job of result.jobs || []) {
    const reconciled = await reconcileClosedGithubIssueForJob(store, env, job);
    const actionable = isActionableSlackWorkItem(reconciled);
    if (workItemState === 'closed' ? !actionable : slackWorkItemIncludesInactive(workItemState) || actionable) {
      reconciledJobs.push(reconciled);
    }
  }

  const jobs = reconciledJobs.slice(0, displayLimit);
  return {
    ...result,
    jobs,
    total: jobs.length,
    limit: displayLimit,
    workItemState,
  };
}
