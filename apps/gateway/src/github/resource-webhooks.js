import { jsonResponse } from '@xd/worker-kit';

import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { notifySlackJobStatus } from '../slack/notifier.js';
import {
  cancelJobForClosedGithubIssue,
  cancelJobForClosedGithubPr,
  restoreJobForReopenedGithubResource,
} from './resource-reconciler.js';
import { issueUrl, publishingJobIdFromIssueBody } from './webhook.js';

export async function handleGithubIssueWebhook({ body, action, store, env, result }) {
  const issue = body.issue || {};
  if (issue.pull_request) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'pull_request_issue' });
  }

  if (!['opened', 'reopened', 'edited', 'closed'].includes(action)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_issue_action' });
  }

  const jobId = publishingJobIdFromIssueBody(issue.body);
  if (!jobId) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'non_pages_issue' });
  }

  let job = await store.getJob(jobId);
  if (!job) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'job_not_found', jobId });
  }

  const issueNumber = issue.number || null;
  if (job.issueNumber && issueNumber && Number(job.issueNumber) !== Number(issueNumber)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'issue_number_mismatch', job });
  }

  if (action === 'reopened') {
    if (issueNumber && !job.issueNumber) {
      job = await store.patchJob(job.id, {
        issueNumber,
        issueUrl: issueUrl(issue),
      });
    }

    if (job.status === 'cancelled' && job.errorCode === 'github_issue_closed') {
      job = await restoreJobForReopenedGithubResource(store, job, 'issue', issue);
      await store.linkJobToSlackSession(job);
      const workerStart = await startWorkerForJobIfConfigured(job, env);
      const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
        stage: job.status,
        text: 'GitHub issue 已重新打开，发布任务已恢复。',
        statusText: ':white_check_mark: GitHub issue 已重新打开，任务已恢复。',
        skipDuplicate: false,
        dedupeKey: `github-issue-reopened:${job.id}:${issueNumber || 'unknown'}`,
      });
      return jsonResponse({
        ok: true,
        created: true,
        delivery: result.delivery,
        issueAction: 'job_restored_by_issue_reopened',
        job,
        ...(workerStart ? { workerStart } : {}),
        ...(slackStatusNotification ? { slackStatusNotification } : {}),
      });
    }

    return jsonResponse({ ok: true, created: true, delivery: result.delivery, issueAction: 'issue_reopened_recorded', job });
  }

  if (action === 'closed') {
    if (issueNumber && !job.issueNumber) {
      job = await store.patchJob(job.id, {
        issueNumber,
        issueUrl: issueUrl(issue),
      });
    }
    job = await cancelJobForClosedGithubIssue(store, job, issue);
    await store.linkJobToSlackSession(job);
    await notifySlackJobStatus(env, store, job, {
      stage: 'cancelled',
      text: 'GitHub issue 已关闭，当前发布任务已停止。',
      statusText: ':white_check_mark: GitHub issue 已关闭，任务已停止。',
      skipDuplicate: false,
      dedupeKey: `github-issue-closed:${job.id}:${issueNumber || 'unknown'}`,
    });
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      issueAction: 'job_cancelled_by_issue_closed',
      job,
    });
  }

  if (!job.issueNumber || ['received', 'issue_creating'].includes(job.status)) {
    job = await store.updateJob(job.id, 'issue_created', {
      issueNumber,
      issueUrl: issueUrl(issue),
    });
  }
  await store.linkJobToSlackSession(job);

  let workerStart = null;
  let issueAction = 'recorded';

  if (job.status === 'issue_created') {
    job = await store.updateJob(job.id, 'generating_page');
    await store.linkJobToSlackSession(job);
    await notifySlackJobStatus(env, store, job, {
      stage: 'issue_created',
      text: 'GitHub issue 已创建，准备启动页面生成。',
    });
    workerStart = await startWorkerForJobIfConfigured(job, env);
    issueAction = workerStart?.started ? 'pages_agent_dispatched' : 'pages_agent_ready';
  } else if (['generating_page', 'patch_generated', 'branch_committed', 'pr_created', 'reviewing'].includes(job.status)) {
    issueAction = 'already_running_or_completed';
  }

  return jsonResponse({
    ok: true,
    created: true,
    delivery: result.delivery,
    issueAction,
    job,
    ...(workerStart ? { workerStart } : {}),
  });
}

export async function handleGithubPullRequestWebhook({ body, action, store, env, result }) {
  if (!['closed', 'reopened'].includes(action)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_pull_request_action' });
  }

  const pullRequest = body.pull_request || {};
  const prNumber = pullRequest.number || body.number || null;
  if (!prNumber) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'missing_pr_number' });
  }

  let job = await store.findJobByPrNumber(prNumber, { headSha: pullRequest.head?.sha || null });
  if (!job) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'job_not_found', prNumber });
  }

  if (pullRequest.html_url && pullRequest.html_url !== job.prUrl) {
    job = await store.patchJob(job.id, { prUrl: pullRequest.html_url });
  }

  if (action === 'closed') {
    if (pullRequest.merged) {
      return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'merged_pr', job });
    }

    job = await cancelJobForClosedGithubPr(store, job, pullRequest);
    await store.linkJobToSlackSession(job);
    const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: 'cancelled',
      cardTitle: 'PR 已关闭',
      text: 'GitHub PR 已关闭，当前发布任务已停止。',
      statusText: ':white_check_mark: GitHub PR 已关闭，任务已停止。',
      skipDuplicate: false,
      dedupeKey: `github-pr-closed:${job.id}:${prNumber}`,
    });
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      prAction: 'job_cancelled_by_pr_closed',
      job,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    });
  }

  if (job.status === 'cancelled' && job.errorCode === 'github_pr_closed') {
    job = await restoreJobForReopenedGithubResource(store, job, 'pr', pullRequest);
    await store.linkJobToSlackSession(job);
    const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: job.status,
      text: 'GitHub PR 已重新打开，发布任务已恢复。',
      statusText: ':white_check_mark: GitHub PR 已重新打开，任务已恢复。',
      skipDuplicate: false,
      dedupeKey: `github-pr-reopened:${job.id}:${prNumber}`,
    });
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      prAction: 'job_restored_by_pr_reopened',
      job,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    });
  }

  return jsonResponse({ ok: true, created: true, delivery: result.delivery, prAction: 'pr_reopened_recorded', job });
}
