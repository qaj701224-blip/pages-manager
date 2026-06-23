import { jsonResponse } from '@xd/worker-kit';

import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { notifySlackJobStatus } from '../slack/notifier.js';
import { notifySlackPlatformDevStatus, platformNotificationText } from '../slack/platform-notifier.js';
import {
  cancelJobForClosedGithubIssue,
  cancelJobForClosedGithubPr,
  restoreJobForReopenedGithubResource,
} from './resource-reconciler.js';
import { issueUrl, platformDevItemIdFromIssueBody, publishingJobIdFromIssueBody } from './webhook.js';

async function handlePlatformDevIssueWebhook({ issue, action, store, env, result }) {
  const itemId = platformDevItemIdFromIssueBody(issue.body);
  if (!itemId) return null;

  let item = await store.getPlatformDevItem(itemId);
  if (!item) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'platform_item_not_found', itemId });
  }

  const issueNumber = issue.number || null;
  const patch = {
    githubIssueNumber: issueNumber || item.githubIssueNumber,
    githubIssueUrl: issueUrl(issue) || item.githubIssueUrl,
  };

  if (action === 'closed') {
    item =
      item.status === 'closed_unmerged'
        ? await store.patchPlatformDevItem(item.id, patch)
        : await store.updatePlatformDevItem(item.id, 'closed_unmerged', patch);
  } else if (['opened', 'edited', 'reopened'].includes(action)) {
    item =
      item.status === 'received' || item.status === 'issue_creating'
        ? await store.updatePlatformDevItem(item.id, item.requiresHumanGate ? 'gate_pending' : 'issue_created', patch)
        : await store.patchPlatformDevItem(item.id, patch);
  }

  await store.linkPlatformDevItemToSlackSession(item);
  const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, item, {
    stage: item.status,
    text: platformNotificationText(item.status, item) || 'GitHub issue 状态已更新。',
    skipDuplicate: false,
  });

  return jsonResponse({
    ok: true,
    created: true,
    delivery: result.delivery,
    issueAction: 'platform_item_recorded',
    item,
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
  });
}

export async function handleGithubIssueWebhook({ body, action, store, env, result }) {
  const issue = body.issue || {};
  if (issue.pull_request) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'pull_request_issue' });
  }

  if (!['opened', 'reopened', 'edited', 'closed'].includes(action)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_issue_action' });
  }

  const platformResult = await handlePlatformDevIssueWebhook({ issue, action, store, env, result });
  if (platformResult) return platformResult;

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
  if (!['opened', 'synchronize', 'closed', 'reopened', 'ready_for_review'].includes(action)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_pull_request_action' });
  }

  const pullRequest = body.pull_request || {};
  const prNumber = pullRequest.number || body.number || null;
  if (!prNumber) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'missing_pr_number' });
  }

  let platformItem = store.findPlatformDevItemByPrNumber
    ? await store.findPlatformDevItemByPrNumber(prNumber, { headSha: pullRequest.head?.sha || null })
    : null;
  if (platformItem) {
    const patch = {
      githubPrNumber: prNumber,
      githubPrUrl: pullRequest.html_url || platformItem.githubPrUrl,
      branchName: pullRequest.head?.ref || platformItem.branchName,
      headSha: pullRequest.head?.sha || platformItem.headSha,
    };
    let nextStatus = platformItem.status;
    if (action === 'closed') nextStatus = pullRequest.merged ? 'merged' : 'closed_unmerged';
    else if (['opened', 'reopened', 'ready_for_review'].includes(action)) nextStatus = 'pr_created';
    else if (action === 'synchronize') nextStatus = 'ci_running';
    platformItem =
      platformItem.status === nextStatus
        ? await store.patchPlatformDevItem(platformItem.id, patch)
        : await store.updatePlatformDevItem(platformItem.id, nextStatus, patch);
    await store.linkPlatformDevItemToSlackSession(platformItem);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, platformItem, {
      stage: nextStatus,
      text: platformNotificationText(nextStatus, platformItem) || 'GitHub PR 状态已更新。',
      skipDuplicate: false,
    });
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      prAction: 'platform_item_recorded',
      item: platformItem,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    });
  }

  if (!['closed', 'reopened'].includes(action)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_site_pull_request_action' });
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
