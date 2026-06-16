import { githubApiUrl, githubRequest, parseRepoFullName } from '@xd/git-client';
import { jsonResponse } from '@xd/worker-kit';

import {
  issueUrl,
  parseGithubWebhookBody,
  publishingJobIdFromIssueBody,
  verifyGithubWebhookSignature,
} from '../github/webhook.js';
import {
  classifyReviewAgentComment,
  isAllowedReviewAgent,
  isAllowedSiteCheckRun,
  normalizeReviewAgentWebhook,
  normalizeSiteCheckRunWebhook,
} from '../github/review.js';
import { readJson } from '../http/body.js';
import { readSlackRequest, slackAckResponse, slackChallengeResponse } from '../slack/http.js';
import {
  classifySlackIntake,
  isUnsupportedBulkDestructiveRequest,
  parseSlackPrNumber,
  slackStatusReply,
} from '../slack/intake.js';
import {
  addSlackReaction,
  buildSlackAgentReplyBlocks,
  mentionSlackUser,
  notificationTextForCallback,
  notificationTextForReviewAction,
  notifySlackJob,
  notifySlackJobStatus,
  postSlackMessage,
  removeSlackReaction,
  startSlackAgentReply,
  updateSlackAgentReply,
  updateSlackMessage,
} from '../slack/notifier.js';
import { selectSlackSession, slackActorFromBody, slackUserIdFromBody, surfaceForSlackBody } from '../slack/session.js';
import { compactUserFacingText, redactSecretLikeText } from '../slack/text.js';
import {
  findVisibleSlackJobByPrNumber,
  inactiveSlackWorkItemReply,
  isActionableSlackWorkItem,
  isReopenableSlackWorkItem,
  listSlackWorkItemsForSession,
  parseSlackButtonValue,
  reopenTargetForSlackWorkItem,
  slackJobVisibleToActor,
  slackWorkItemListBlocks,
  slackWorkItemListText,
  unsupportedDestructiveRequestReply,
} from '../slack/work-items.js';

const CALLBACK_STAGE_RESULTS = {
  index_ready: {
    status: 'generating_page',
    patch(body) {
      return { indexSnapshotId: body.indexSnapshotId || body.index_snapshot_id || null };
    },
  },
  issue_created: {
    status: 'issue_created',
    patch(body) {
      return {
        issueNumber: body.issueNumber || body.issue_number || null,
        issueUrl: body.issueUrl || body.issue_url || null,
      };
    },
  },
  patch_generated: { status: 'patch_generated' },
  branch_committed: {
    status: 'branch_committed',
    patch(body) {
      return { branchName: body.branchName || body.branch_name || null };
    },
  },
  pr_created: {
    status: 'pr_created',
    patch(body) {
      return {
        branchName: body.branchName || body.branch_name || null,
        prNumber: body.prNumber || body.pr_number || null,
        prUrl: body.prUrl || body.pr_url || null,
        baseRef: body.baseRef || body.base_ref || null,
        headSha: body.headSha || body.head_sha || null,
      };
    },
  },
  reviewing: {
    status: 'reviewing',
    patch(body) {
      return {
        branchName: body.branchName || body.branch_name || null,
        prNumber: body.prNumber || body.pr_number || null,
        prUrl: body.prUrl || body.pr_url || null,
        baseRef: body.baseRef || body.base_ref || null,
        headSha: body.headSha || body.head_sha || null,
      };
    },
  },
  previewing: { status: 'previewing' },
  preview_deployed: {
    status: 'preview_deployed',
    patch(body) {
      return { previewUrl: body.previewUrl || body.preview_url || null };
    },
  },
};

const STALE_CALLBACK_PATCH_STATUSES = {
  issue_created: new Set([
    'indexing',
    'generating_page',
    'patch_generated',
    'branch_committed',
    'pr_created',
    'reviewing',
    'changes_requested',
    'fixing',
    'previewing',
    'preview_deployed',
  ]),
};

const REVIEW_RECONCILE_JOB_STATUSES = ['pr_created', 'reviewing'];
const REVIEW_FALLBACK_AGENT_LOGIN = 'pages-review-watchdog';
const DEFAULT_REVIEW_AGENT_TIMEOUT_SECONDS = 180;
const AGENT_EVENT_CODING_FIX_DISPATCHED = 'coding_fix_dispatched';
const AGENT_EVENT_SLACK_FOLLOWUP_QUEUED = 'slack_followup_queued';

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    const error = new Error(`${name} is required`);
    error.status = 400;
    throw error;
  }
  return value;
}

function verifyInternalCallbackToken(request, env) {
  if (!env.INTERNAL_CALLBACK_TOKEN) return null;

  const token = request.headers.get('X-Pages-Callback-Token');
  if (token === env.INTERNAL_CALLBACK_TOKEN) return null;

  return jsonResponse({ error: 'Invalid callback token' }, 401);
}

function isUnaddressedChannelThreadMessage(body = {}) {
  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  return event.type === 'message' && surface.channelType !== 'im' && Boolean(event.thread_ts);
}

async function existingSlackThreadSession(store, body = {}) {
  const actor = slackActorFromBody(body);
  const surface = surfaceForSlackBody(body);
  const sessionKey = `thread:${surface.channelId || 'unknown'}:${surface.threadTs || surface.messageTs || 'unknown'}`;
  return store.findSlackSessionByScope ? await store.findSlackSessionByScope(actor.teamId, actor.slackUserId, sessionKey) : null;
}

async function cancelJobForClosedGithubIssue(store, job, issue = {}) {
  const message = issue.number ? `GitHub issue #${issue.number} 已关闭，发布任务已停止。` : 'GitHub issue 已关闭，发布任务已停止。';
  if (store.cancelJob) {
    return await store.cancelJob(job.id, 'github_issue_closed', message);
  }
  return await store.patchJob(job.id, {
    status: 'cancelled',
    errorCode: 'github_issue_closed',
    errorMessage: message,
  });
}

async function cancelJobForClosedGithubPr(store, job, pullRequest = {}) {
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

async function restoreJobForReopenedGithubResource(store, job, target, resource = {}) {
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

async function reopenGithubResourceForJob(env = {}, job = {}, target = '') {
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

async function reconcileClosedGithubIssueForJob(store, env, job, options = {}) {
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

async function listReconciledSlackWorkItemsForSession(store, body, env, options = {}) {
  const displayLimit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
  const reconcileLimit = options.reconcileLimit || Math.max(displayLimit, 20);
  const result = await listSlackWorkItemsForSession(store, body, {
    ...options,
    limit: reconcileLimit,
  });
  const reconciledJobs = [];

  for (const job of result.jobs || []) {
    const reconciled = await reconcileClosedGithubIssueForJob(store, env, job);
    if (options.includeInactive || isActionableSlackWorkItem(reconciled)) {
      reconciledJobs.push(reconciled);
    }
  }

  const jobs = reconciledJobs.slice(0, displayLimit);
  return {
    ...result,
    jobs,
    total: jobs.length,
    limit: displayLimit,
  };
}

async function applyExecutorCallback(store, jobId, stageResult, status, patch) {
  const existing = await store.getJob(jobId);
  if (!existing) return null;

  if (STALE_CALLBACK_PATCH_STATUSES[stageResult]?.has(existing.status)) {
    return await store.patchJob(jobId, patch);
  }

  return await store.updateJob(jobId, status, patch);
}

async function handleGithubIssueWebhook({ body, action, store, env, result }) {
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

async function handleGithubPullRequestWebhook({ body, action, store, env, result }) {
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

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function getStore(env) {
  if (!env.store) {
    env.store = env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  }
  if (!env.store) {
    const error = new Error('Gateway store is not configured');
    error.status = 500;
    throw error;
  }
  return env.store;
}

function shouldStartWorkerForJob(job) {
  return job.status === 'received' || job.status === 'generating_page' || job.status === 'fixing' || job.status === 'previewing';
}

function shouldDispatchPreviewForReview(updatedJob, normalized, gate) {
  if (!updatedJob || updatedJob.previewUrl || !gate.canPreview) return false;
  if (!['review_summary', 'issue_comment'].includes(normalized.sourceType)) return false;
  if (!['note', 'suggestion'].includes(normalized.classification)) return false;
  return ['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(updatedJob.status);
}

function shouldReportSiteCheckWaiting(updatedJob, normalized, gate) {
  if (!updatedJob || updatedJob.previewUrl || gate.canPreview) return false;
  if (gate.blockingCount > 0 || gate.unknownCount > 0) return false;
  if (gate.siteCheck?.passed) return false;
  if (!['review_summary', 'issue_comment'].includes(normalized.sourceType)) return false;
  if (!['note', 'suggestion'].includes(normalized.classification)) return false;
  return ['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(updatedJob.status);
}

async function previewGateForPr(store, repoFullName, prNumber, options = {}) {
  if (store.previewGateForPr) return await store.previewGateForPr(repoFullName, prNumber, options);

  const reviewGate = await store.reviewGateForPr(repoFullName, prNumber, options);
  const siteCheckGate = store.siteCheckGateForPr
    ? await store.siteCheckGateForPr(repoFullName, prNumber, options)
    : { required: true, passed: false, status: 'missing', conclusion: null };
  return {
    ...reviewGate,
    reviewGate,
    siteCheck: siteCheckGate,
    siteCheckPassed: siteCheckGate.passed,
    canPreview: reviewGate.canPreview && siteCheckGate.passed,
  };
}

function repoFullNameForJob(job, env) {
  if (env.GITHUB_REPO) return env.GITHUB_REPO;

  for (const value of [job.prUrl, job.issueUrl]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    } catch {
      // Ignore malformed stored URLs.
    }
  }

  return null;
}

async function previewTriggerFromStoredReviews(store, job, env) {
  if (!job?.prNumber || job.previewUrl) return null;
  if (!['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(job.status)) return null;

  const repoFullName = repoFullNameForJob(job, env);
  if (!repoFullName) return null;

  const options = job.headSha ? { headSha: job.headSha } : {};
  const gate = await previewGateForPr(store, repoFullName, job.prNumber, options);
  if (!gate.canPreview) return null;

  const comments = await store.listReviewAgentComments(repoFullName, job.prNumber, options);
  const reviewComment = comments.find((comment) => {
    if (comment.status !== 'open') return false;
    if (!['review_summary', 'issue_comment'].includes(comment.sourceType)) return false;
    return ['note', 'suggestion'].includes(classifyReviewAgentComment(comment));
  });

  return reviewComment ? { gate, reviewComment } : null;
}

async function dispatchPreviewFromReviewTrigger(job, store, env, trigger, reviewAction = 'preview_dispatched') {
  const updatedJob =
    job.status === 'previewing' ? job : await store.updateJob(job.id, 'previewing', job.headSha ? { headSha: job.headSha } : {});
  const workerStart = await startWorkerForJobIfConfigured(updatedJob, env);

  return {
    reviewAction,
    job: updatedJob,
    workerStart,
    gate: trigger.gate,
    reviewComment: trigger.reviewComment,
  };
}

async function dispatchPreviewFromStoredReviewIfReady(job, store, env) {
  const trigger = await previewTriggerFromStoredReviews(store, job, env);
  if (!trigger) return null;
  return dispatchPreviewFromReviewTrigger(job, store, env, trigger);
}

function reviewFallbackTimeoutMs(env = {}) {
  const seconds = Number(env.GITHUB_REVIEW_AGENT_TIMEOUT_SECONDS || DEFAULT_REVIEW_AGENT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_REVIEW_AGENT_TIMEOUT_SECONDS * 1000;
  return seconds * 1000;
}

function reviewWaitElapsedMs(job, nowMs) {
  const since = new Date(job.updatedAt || job.createdAt || 0).getTime();
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, nowMs - since);
}

function isOpenNonblockingReviewSummary(comment) {
  if (comment.status !== 'open') return false;
  if (!['review_summary', 'issue_comment'].includes(comment.sourceType)) return false;
  return ['note', 'suggestion'].includes(classifyReviewAgentComment(comment));
}

function syntheticReviewFallbackComment(job, repoFullName, timeoutMs) {
  const shortSha = String(job.headSha || '').slice(0, 10) || 'unknown';
  const timeoutSeconds = Math.round(timeoutMs / 1000);

  return {
    repoFullName,
    prNumber: job.prNumber,
    githubReviewId: null,
    githubCommentId: null,
    githubCommentNodeId: `review-fallback:${job.id}:${shortSha}`,
    sourceType: 'issue_comment',
    reviewAgentLogin: REVIEW_FALLBACK_AGENT_LOGIN,
    reviewState: '',
    body: [
      'Pages Review Gate: no blocking result was returned by the external Review Agent before timeout.',
      '',
      `Timeout: ${timeoutSeconds}s`,
      `Reviewed commit: \`${shortSha}\``,
      '',
      [
        'site-check has passed and no blocking or unknown Review Agent comments were recorded for this PR head.',
        'Proceeding to Preview.',
      ].join(' '),
    ].join('\n'),
    path: null,
    line: null,
    diffHunk: null,
    status: 'open',
    classification: 'note',
    firstSeenDeliveryId: `review-fallback:${job.id}:${shortSha}`,
    lastSeenDeliveryId: `review-fallback:${job.id}:${shortSha}`,
    headSha: job.headSha,
  };
}

async function reviewFallbackTriggerForJob(store, job, env, nowMs = Date.now()) {
  if (!job?.prNumber || !job.headSha || job.previewUrl) return { skipped: 'missing_pr_head_or_preview' };
  if (!REVIEW_RECONCILE_JOB_STATUSES.includes(job.status)) return { skipped: 'status_not_reconcilable' };

  const repoFullName = repoFullNameForJob(job, env);
  if (!repoFullName) return { skipped: 'repo_unknown' };

  const options = { headSha: job.headSha };
  const replay = await previewTriggerFromStoredReviews(store, job, env);
  if (replay) return { trigger: replay, reviewAction: 'preview_dispatched' };

  const timeoutMs = reviewFallbackTimeoutMs(env);
  const elapsedMs = reviewWaitElapsedMs(job, nowMs);
  const gate = await previewGateForPr(store, repoFullName, job.prNumber, options);

  if (!gate.siteCheck?.passed) return { skipped: 'site_check_waiting', gate };
  if (gate.blockingCount > 0) return { skipped: 'blocking_review_comment', gate };
  if (gate.unknownCount > 0) return { skipped: 'unknown_review_comment', gate };
  if (elapsedMs < timeoutMs) {
    return {
      skipped: 'review_timeout_waiting',
      gate,
      elapsedMs,
      timeoutMs,
    };
  }

  const comments = await store.listReviewAgentComments(repoFullName, job.prNumber, options);
  if (comments.some(isOpenNonblockingReviewSummary)) {
    const trigger = await previewTriggerFromStoredReviews(store, job, env);
    return trigger ? { trigger, reviewAction: 'preview_dispatched' } : { skipped: 'stored_review_not_dispatchable', gate };
  }

  const reviewComment = await store.recordReviewAgentComment(syntheticReviewFallbackComment(job, repoFullName, timeoutMs));
  const gateAfterFallback = await previewGateForPr(store, repoFullName, job.prNumber, options);

  return {
    trigger: {
      gate: gateAfterFallback,
      reviewComment: reviewComment.comment,
    },
    reviewAction: 'review_timeout_preview_dispatched',
    reviewCommentCreated: reviewComment.created,
    elapsedMs,
    timeoutMs,
  };
}

async function notifySlackForReviewAction(env, store, job, reviewAction, gate, reviewComment, dedupeKey) {
  const text = notificationTextForReviewAction(reviewAction, { gate, reviewComment }) || reviewAction;
  const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
    stage: job.status,
    text,
    dedupeKey,
    skipDuplicate: false,
  });
  const slackNotification = await notifySlackPlainProgress(env, store, job, text, dedupeKey);
  return { slackStatusNotification, slackNotification };
}

async function reconcileReviewGateForJob(store, job, env, nowMs = Date.now()) {
  const fallback = await reviewFallbackTriggerForJob(store, job, env, nowMs);
  if (!fallback.trigger) {
    return {
      jobId: job?.id || null,
      prNumber: job?.prNumber || null,
      headSha: job?.headSha || null,
      skipped: fallback.skipped || 'not_ready',
      ...(fallback.gate ? { gate: fallback.gate } : {}),
      ...(fallback.elapsedMs !== undefined ? { elapsedMs: fallback.elapsedMs, timeoutMs: fallback.timeoutMs } : {}),
    };
  }

  const result = await dispatchPreviewFromReviewTrigger(
    job,
    store,
    env,
    fallback.trigger,
    fallback.reviewAction || 'preview_dispatched'
  );
  await store.linkJobToSlackSession(result.job);
  const slack = await notifySlackForReviewAction(
    env,
    store,
    result.job,
    result.reviewAction,
    result.gate,
    result.reviewComment,
    `review-reconcile:${result.reviewAction}:${result.reviewComment?.githubCommentNodeId || result.job.headSha}`
  );

  return {
    jobId: result.job.id,
    prNumber: result.job.prNumber,
    headSha: result.job.headSha,
    reviewAction: result.reviewAction,
    job: result.job,
    gate: result.gate,
    reviewComment: result.reviewComment,
    reviewCommentCreated: fallback.reviewCommentCreated,
    ...(result.workerStart ? { workerStart: result.workerStart } : {}),
    ...(slack.slackStatusNotification ? { slackStatusNotification: slack.slackStatusNotification } : {}),
    ...(slack.slackNotification ? { slackNotification: slack.slackNotification } : {}),
  };
}

async function startWorkerForJobIfConfigured(job, env) {
  if (!env.PAGES_WORKER_START_URL || !shouldStartWorkerForJob(job)) return null;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (env.PAGES_WORKER_SHARED_SECRET) {
    headers['X-Pages-Worker-Token'] = env.PAGES_WORKER_SHARED_SECRET;
  }

  const fetchImpl = env.WORKER_FETCH || fetch;
  const response = await fetchImpl(env.PAGES_WORKER_START_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ job }),
  });
  const body = await readResponseJson(response);

  if (!response.ok || body?.ok === false) {
    return {
      started: false,
      error: body?.error || response.statusText || `HTTP ${response.status}`,
    };
  }

  const result = {
    started: true,
    response: body,
  };
  const store = env.store || env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  if (job.status === 'fixing' && store) {
    result.dispatchEvent = await recordCodingFixDispatch(store, job, result);
  }

  return result;
}

function slackAgentEndpoint(env = {}) {
  if (env.SLACK_AGENT_TURN_URL) return { url: env.SLACK_AGENT_TURN_URL, mode: 'turn' };
  if (env.SLACK_AGENT_ANALYZE_URL) return { url: env.SLACK_AGENT_ANALYZE_URL, mode: 'analyze' };
  return null;
}

function slackAgentRequestPayload(body, intake, context = {}) {
  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  const slackSession = context.slackSession || null;
  const agentRun = context.agentRun || null;

  return {
    ...body,
    agentRunId: agentRun?.id || null,
    slackSessionId: slackSession?.id || null,
    teamId: body.team_id || body.team?.id || event.team || null,
    slackUserId: slackUserIdFromBody(body, null),
    channelId: surface.channelId || null,
    threadTs: surface.threadTs || null,
    messageTs: surface.messageTs || null,
    messageText: intake.text,
    text: intake.text,
    employeeSlug: body.employeeSlug || body.employee_slug,
    siteSlug: body.siteSlug || body.site_slug,
    slackSession,
    sessionMemory: context.sessionMemory || null,
    issueLinks: context.issueLinks || [],
    activeIssueLink: context.issueLinks?.[0] || null,
    agentRun,
  };
}

async function readSlackAgentResponse(response) {
  const text = await response.text();
  if (!text) return {};

  const contentType = response.headers?.get?.('Content-Type') || '';
  if (/\bapplication\/x-ndjson\b/i.test(contentType)) {
    const events = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const final = [...events].reverse().find((event) => event.type === 'analysis_final' && event.analysis);
    return {
      ok: true,
      turn: {
        events,
        analysis: final?.analysis || null,
        visibleText: events
          .filter((event) => event.type === 'reply_delta' && event.text)
          .map((event) => event.text)
          .join(''),
      },
      analysis: final?.analysis || null,
    };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function normalizeSlackAgentTurnResult(result = {}, mode = 'analyze') {
  if (mode === 'turn') {
    const turn = result.turn || result.data?.turn || result;
    const finalEvent = Array.isArray(turn.events)
      ? [...turn.events].reverse().find((event) => event.type === 'analysis_final' && event.analysis)
      : null;
    const analysis = result.analysis || turn.analysis || finalEvent?.analysis || null;
    return {
      analysis,
      turn: {
        ...turn,
        analysis,
        events: Array.isArray(turn.events) ? turn.events : [],
      },
    };
  }

  return { analysis: result?.analysis || null, turn: null };
}

function shouldStartSlackAgentReplyForTurn(intake, endpoint) {
  return endpoint?.mode === 'turn' && intake.action === 'agent_turn';
}

function sameSlackReplyTarget(message = {}, thread = {}) {
  if (!message?.messageTs || !message.channel || !thread.channelId) return false;
  return message.channel === thread.channelId && (message.threadTs || null) === (thread.threadTs || thread.messageTs || null);
}

async function startSlackAgentReplyMessage(env, store, body, slackSession, agentRun) {
  if (!canSendSlackOutput(env) || !store?.recordSlackAgentReplyMessage || !agentRun?.id || !slackSession?.id) return null;
  const existing = store.getSlackAgentReplyMessage ? await store.getSlackAgentReplyMessage(agentRun.id) : null;
  if (existing?.messageTs) return { ok: true, action: 'existing', message: existing };

  const thread = slackThreadForSession(slackSession, surfaceForSlackBody(body));
  if (!thread.channelId) return null;

  const text = mentionSlackUser('我已收到，正在整理需求。', slackUserIdFromBody(body, null));
  const reusable = store.getLatestSlackAgentReplyMessageForSession
    ? await store.getLatestSlackAgentReplyMessageForSession(slackSession.id)
    : null;
  if (sameSlackReplyTarget(reusable, thread)) {
    try {
      const updateResult = await updateSlackAgentReply(env, reusable, {
        text,
        status: 'running',
        blocks: buildSlackAgentReplyBlocks(
          { text: '我已收到，正在整理需求。' },
          { title: '需求整理', status: 'running' }
        ),
      });
      if (updateResult?.ok && !updateResult.skipped) {
        const message = await store.recordSlackAgentReplyMessage(agentRun.id, {
          slackSessionId: slackSession.id,
          channel: updateResult.channel || reusable.channel || thread.channelId,
          threadTs: reusable.threadTs || thread.threadTs || thread.messageTs || null,
          messageTs: updateResult.ts || updateResult.messageTs || reusable.messageTs,
          textSnapshot: '我已收到，正在整理需求。',
          lastSequence: 1,
          status: 'running',
        });
        return { ...updateResult, action: 'reused', message };
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_agent_reply_reuse_failed',
          slackSessionId: slackSession.id,
          agentRunId: agentRun.id,
          error: err.message,
        })
      );
    }
  }

  let result;
  try {
    result = await startSlackAgentReply(
      env,
      { channel: thread.channelId, thread_ts: thread.threadTs || thread.messageTs || undefined, text },
      {
        text,
        status: 'running',
        blocks: buildSlackAgentReplyBlocks(
          { text: '我已收到，正在整理需求。' },
          { title: '需求整理', status: 'running' }
        ),
      }
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_agent_reply_start_failed',
        slackSessionId: slackSession.id,
        agentRunId: agentRun.id,
        error: err.message,
      })
    );
    return { ok: false, error: err.message };
  }

  if (!result?.ok || result.skipped) return result || null;
  const messageTs = result.ts || result.messageTs || result.message?.messageTs || null;
  if (!messageTs) return { ...result, ok: false, error: 'Slack agent reply start did not return a message timestamp' };

  const message = await store.recordSlackAgentReplyMessage(agentRun.id, {
    slackSessionId: slackSession.id,
    channel: result.channel || thread.channelId,
    threadTs: thread.threadTs || thread.messageTs || null,
    messageTs,
    textSnapshot: '我已收到，正在整理需求。',
    lastSequence: 1,
    status: 'running',
  });

  await store.recordAgentRunEvent?.({
    slackSessionId: slackSession.id,
    agentRunId: agentRun.id,
    type: 'slack_reply_posted',
    stage: 'slack_agent_turn',
    text: '我已收到，正在整理需求。',
    status: 'recorded',
    dedupeKey: `slack-reply-posted:${agentRun.id}`,
    slackChannelId: message.channel,
    slackThreadTs: message.threadTs,
    slackMessageTs: message.messageTs,
  });

  return { ...result, action: 'posted', message };
}

async function updateSlackAgentReplyMessage(env, store, body, replyMessage, result = {}, options = {}) {
  if (!replyMessage?.messageTs || !shouldPostSlackResultReply(result)) return null;

  const text = mentionSlackUser(result.replyText, slackUserIdFromBody(body, null));
  let updateResult;
  try {
    updateResult = await updateSlackAgentReply(env, replyMessage, {
      text,
      status: options.status || 'completed',
      blocks:
        result.blocks ||
        buildSlackAgentReplyBlocks(
          { text: result.replyText },
          { title: '需求整理', status: options.status || 'completed' }
        ),
    });
  } catch (err) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_agent_reply_update_failed',
        slackSessionId: replyMessage.slackSessionId,
        agentRunId: replyMessage.agentRunId,
        error: err.message,
      })
    );
    return { ok: false, error: err.message };
  }

  if (!updateResult?.ok || updateResult.skipped) return updateResult || null;

  const sequence = options.sequence || replyMessage.lastSequence || 1;
  const messageTs = updateResult.ts || updateResult.messageTs || updateResult.message?.messageTs || replyMessage.messageTs;
  const message = store?.recordSlackAgentReplyMessage
    ? await store.recordSlackAgentReplyMessage(replyMessage.agentRunId, {
        slackSessionId: replyMessage.slackSessionId,
        channel: updateResult.channel || replyMessage.channel,
        threadTs: replyMessage.threadTs,
        messageTs,
        textSnapshot: result.replyText,
        lastSequence: sequence,
        status: options.status || 'completed',
      })
    : replyMessage;

  await store?.recordAgentRunEvent?.({
    slackSessionId: replyMessage.slackSessionId,
    agentRunId: replyMessage.agentRunId,
    type: options.status === 'failed' ? 'slack_reply_failed' : 'slack_reply_updated',
    stage: 'slack_agent_turn',
    text: result.replyText,
    status: options.status || 'completed',
    dedupeKey: `slack-reply-${options.status === 'failed' ? 'failed' : 'updated'}:${replyMessage.agentRunId}:${sequence}`,
    slackChannelId: message.channel,
    slackThreadTs: message.threadTs,
    slackMessageTs: message.messageTs,
  });

  return { ...updateResult, action: 'updated', message };
}

async function recordSlackAgentTurnEvent(store, turn = {}, event = {}, replyMessage = null, fallbackSequence = 1) {
  if (!store?.recordAgentRunEvent || !turn?.agentRunId || !event?.type) return null;
  const sequence = Number(event.sequence) || fallbackSequence;
  return await store.recordAgentRunEvent({
    slackSessionId: event.slackSessionId || turn.slackSessionId || null,
    agentRunId: event.agentRunId || turn.agentRunId,
    type: event.type,
    stage: 'slack_agent_turn',
    text: event.text || event.analysis?.summary || event.type,
    status: event.type === 'reply_failed' ? 'failed' : event.type === 'reply_completed' ? 'completed' : 'recorded',
    dedupeKey: event.dedupeKey || `${event.agentRunId || turn.agentRunId}:${sequence}`,
    slackChannelId: replyMessage?.channel || null,
    slackThreadTs: replyMessage?.threadTs || null,
    slackMessageTs: replyMessage?.messageTs || null,
  });
}

async function recordSlackAgentTurnEvents(store, turn = {}, replyMessage = null) {
  if (!store?.recordAgentRunEvent || !turn?.agentRunId) return [];
  const recorded = [];
  for (const event of turn.events || []) {
    const result = await recordSlackAgentTurnEvent(store, turn, event, replyMessage, recorded.length + 1);
    if (result) recorded.push(result);
  }
  return recorded;
}

async function failSlackAgentReplyMessage(env, store, body, replyMessage) {
  if (!replyMessage?.messageTs) return null;
  return updateSlackAgentReplyMessage(
    env,
    store,
    body,
    replyMessage,
    {
      ok: false,
      action: 'slack_agent_failed',
      replyText: '处理失败：这轮需求整理失败了，请稍后重试，或直接补充更具体的信息。',
    },
    {
      sequence: replyMessage.lastSequence || 1,
      status: 'failed',
    }
  );
}

function slackAgentReplyUpdateIntervalMs(env = {}) {
  const configured = Number(env.SLACK_AGENT_REPLY_UPDATE_INTERVAL_MS);
  if (Number.isFinite(configured)) return Math.max(0, configured);
  return 750;
}

function slackAgentTurnContentType(response) {
  return response.headers?.get?.('Content-Type') || response.headers?.get?.('content-type') || '';
}

async function readSlackAgentNdjsonResponse(response, context = {}) {
  const events = [];
  const turn = {
    agentRunId: context.agentRunId || null,
    slackSessionId: context.slackSessionId || null,
    events,
    visibleText: '',
    analysis: null,
    eventsRecorded: true,
  };
  const updateIntervalMs = slackAgentReplyUpdateIntervalMs(context.env);
  let replyMessage = context.replyMessage || null;
  let lastUpdateAt = 0;
  let lastSequence = replyMessage?.lastSequence || 1;

  const isCurrentRun = async () =>
    await slackAgentRunStillRunning(context.store, {
      id: turn.agentRunId,
      slackSessionId: turn.slackSessionId,
    });

  const maybeUpdateReply = async ({ force = false, status = 'running' } = {}) => {
    if (!replyMessage?.messageTs || !turn.visibleText) return null;
    if (!(await isCurrentRun())) {
      turn.cancelled = true;
      return null;
    }
    const now = Date.now();
    if (!force && updateIntervalMs > 0 && now - lastUpdateAt < updateIntervalMs) return null;
    const update = await updateSlackAgentReplyMessage(
      context.env,
      context.store,
      context.body,
      replyMessage,
      {
        ok: true,
        action: 'slack_agent_turn_stream',
        replyText: turn.visibleText,
      },
      {
        sequence: lastSequence,
        status,
      }
    );
    if (update?.message) replyMessage = update.message;
    if (update?.ok) lastUpdateAt = now;
    return update;
  };

  const handleEvent = async (eventInput) => {
    const event = {
      ...eventInput,
      agentRunId: eventInput.agentRunId || turn.agentRunId,
      slackSessionId: eventInput.slackSessionId || turn.slackSessionId,
    };
    if (!event.type) return;
    turn.agentRunId = turn.agentRunId || event.agentRunId || null;
    turn.slackSessionId = turn.slackSessionId || event.slackSessionId || null;
    lastSequence = Number(event.sequence) || lastSequence;
    events.push(event);
    if (!(await isCurrentRun())) {
      turn.cancelled = true;
      return;
    }
    await recordSlackAgentTurnEvent(context.store, turn, event, replyMessage, events.length);

    if (event.type === 'reply_delta' && event.text) {
      turn.visibleText += event.text;
      await maybeUpdateReply({ status: 'running' });
    }

    if (event.type === 'analysis_final' && event.analysis) {
      turn.analysis = event.analysis;
    }

  };

  let buffer = '';
  const flushLines = async (final = false) => {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? '' : lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await handleEvent(JSON.parse(trimmed));
    }
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      await flushLines(false);
    }
    buffer += decoder.decode();
    await flushLines(true);
  } else {
    buffer = await response.text();
    await flushLines(true);
  }

  const failed = [...events].reverse().find((event) => event.type === 'reply_failed');
  return {
    ok: !failed,
    ...(failed ? { error: failed.error || failed.text || 'Slack Agent turn failed' } : {}),
    ...(turn.cancelled ? { cancelled: true } : {}),
    turn,
    analysis: turn.analysis,
  };
}

async function readSlackAgentTurnResponse(response, context = {}) {
  const contentType = slackAgentTurnContentType(response);
  if (/\bapplication\/x-ndjson\b/i.test(contentType)) {
    return await readSlackAgentNdjsonResponse(response, context);
  }
  return await readSlackAgentResponse(response);
}

async function runSlackAgentTurnIfConfigured(body, intake, env, context = {}) {
  const endpoint = slackAgentEndpoint(env);
  if (!endpoint) return { analysis: null, turn: null };

  const headers = {
    'Content-Type': 'application/json',
    Accept: endpoint.mode === 'turn' ? 'application/x-ndjson, application/json;q=0.9' : 'application/json',
  };

  if (env.SLACK_AGENT_SHARED_SECRET) {
    headers['X-Pages-Slack-Agent-Token'] = env.SLACK_AGENT_SHARED_SECRET;
  }

  const store = context.store || env.store || env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  const replyStart = shouldStartSlackAgentReplyForTurn(intake, endpoint)
    ? await startSlackAgentReplyMessage(env, store, body, context.slackSession, context.agentRun)
    : null;
  const replyMessage = replyStart?.message || null;
  try {
    const fetchImpl = env.SLACK_AGENT_FETCH || fetch;
    const payload = slackAgentRequestPayload(body, intake, context);
    const response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const result =
      endpoint.mode === 'turn'
        ? await readSlackAgentTurnResponse(response, {
            env,
            store,
            body,
            replyMessage,
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
        })
        : await readSlackAgentResponse(response);

    if (result?.cancelled || !(await slackAgentRunStillRunning(store, context.agentRun))) {
      return {
        cancelled: true,
        analysis: null,
        turn: result?.turn
          ? { ...result.turn, cancelled: true, replyMessage }
          : {
              agentRunId: context.agentRun?.id || null,
              slackSessionId: context.slackSession?.id || null,
              cancelled: true,
              replyMessage,
            },
      };
    }

    if (!response.ok || result?.ok === false) {
      const error = new Error(result?.error || response.statusText || `HTTP ${response.status}`);
      error.status = 502;
      throw error;
    }

    const turnResult = normalizeSlackAgentTurnResult(result, endpoint.mode);
    if (endpoint.mode === 'turn' && !turnResult.analysis) {
      const error = new Error('Slack Agent turn response is missing analysis');
      error.status = 502;
      throw error;
    }
    if (turnResult.turn) {
      turnResult.turn.replyMessage = replyMessage;
      turnResult.turn.replyStart = replyStart;
      if (!turnResult.turn.eventsRecorded) {
        await recordSlackAgentTurnEvents(store, turnResult.turn, replyMessage);
      }
    }

    return turnResult;
  } catch (err) {
    await failSlackAgentReplyMessage(env, store, body, replyMessage);
    throw err;
  }
}

function actorFromHeaders(request, fallback = {}) {
  return {
    requestedByType: request.headers.get('X-Pages-Actor-Type') || fallback.requestedByType || 'user',
    requestedById: request.headers.get('X-Pages-Actor-Id') || fallback.requestedById,
  };
}

function normalizePublishingJobInput(body, request) {
  const actor = actorFromHeaders(request, body);
  const idempotencyKey = request.headers.get('Idempotency-Key') || body.idempotencyKey || body.idempotency_key || body.requestId;

  return {
    source: body.source || 'api',
    requestedByType: actor.requestedByType,
    requestedById: required(actor.requestedById, 'requestedById'),
    idempotencyKey: required(idempotencyKey, 'idempotencyKey'),
    employeeSlug: required(body.employeeSlug || body.employee_slug, 'employeeSlug'),
    siteSlug: required(body.siteSlug || body.site_slug, 'siteSlug'),
    siteProjectId: body.siteProjectId || body.site_project_id || null,
    ownerScopeId: body.ownerScopeId || body.owner_scope_id || null,
    employeeId: body.employeeId || body.employee_id || null,
    intent: body.intent || 'create_site',
    approvalMode: body.approvalMode || body.approval_mode || 'manual_required',
    title: body.title,
    summary: body.summary || body.brief || '',
    brief: body.brief,
    requesterProfile: body.requesterProfile || body.requester_profile || null,
  };
}

function stableSlugHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

function slugSegment(value, fallback, maxLength = 48) {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-');
  const slug = normalized || fallback;
  return slug.slice(0, maxLength).replaceAll(/-+$/g, '') || fallback;
}

function requesterSlugBase(profileInput = {}, slackUserId) {
  const profile = profileInput || {};
  const email = String(profile.email || '')
    .trim()
    .toLowerCase();
  if (email.includes('@')) return email.split('@')[0].split('+')[0];
  return profile.displayName || profile.display_name || profile.realName || profile.real_name || profile.name || slackUserId;
}

function employeeSlugForSlack({ teamId, slackUserId, requesterProfile }) {
  const identityKey = `${teamId || 'unknown-team'}:${slackUserId || 'unknown-user'}`;
  const suffix = stableSlugHash(identityKey);
  const base = slugSegment(requesterSlugBase(requesterProfile, slackUserId), 'slack-user', 40);
  return `${base}-${suffix}`;
}

function siteSlugForSlack(analysis = {}, body = {}) {
  return slugSegment(analysis.siteSlug || analysis.site_slug || body.siteSlug || body.site_slug || 'profile', 'profile', 72);
}

function slackJobInput(body) {
  const event = body.event || {};
  const analysis = body.slackAgentAnalysis || {};
  const slackSession = body.slackSession || null;
  const teamId = body.team_id || body.team?.id || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);
  const intake = body.intake || classifySlackIntake(body);
  const surface = surfaceForSlackBody(body);
  const text = intake.text || event.text || body.text || '';
  const idempotencyKey =
    body.idempotencyKey ||
    body.idempotency_key ||
    body.event_id ||
    body.trigger_id ||
    `${teamId}:${event.ts || body.event_ts || Date.now()}`;
  const requesterProfile = body.requesterProfile || body.requester_profile || null;

  return {
    source: 'slack',
    requestedByType: 'user',
    requestedById: `slack:${teamId}:${slackUserId}`,
    idempotencyKey,
    employeeSlug: employeeSlugForSlack({ teamId, slackUserId, requesterProfile }),
    siteSlug: siteSlugForSlack(analysis, body),
    intent: analysis.intent || 'create_site',
    approvalMode: analysis.approvalMode || body.approvalMode || body.approval_mode || 'manual_required',
    title: body.title || analysis.title || text.slice(0, 80) || 'Slack publishing request',
    summary: body.summary || analysis.summary || text,
    requesterProfile,
    slackSessionId: slackSession?.id || body.slackSessionId || null,
    slackSessionKey: slackSession?.sessionKey || body.slackSessionKey || null,
    slackThread: {
      teamId,
      channelId: surface.channelId,
      channelType: surface.channelType,
      messageTs: surface.messageTs,
      threadTs: surface.threadTs,
      userId: slackUserId,
    },
  };
}

const CREATE_JOB_INTENTS = new Set(['create_or_update_site', 'new_site_request', 'create_site', 'update_site']);
const FOLLOWUP_INTENTS = new Set(['modify_existing_preview', 'append_requirement']);
const NON_FOLLOWUP_ACTIONS = new Set([
  'help',
  'ping',
  'status',
  'cancel',
  'close_session',
  'empty',
  'missing_requirement',
  'list_work_items',
  'switch_work_item',
  'unsupported_destructive_request',
]);
const LIST_WORK_ITEM_INTENTS = new Set(['list_work_items']);
const SWITCH_WORK_ITEM_INTENTS = new Set(['switch_work_item']);
const UNSUPPORTED_DESTRUCTIVE_INTENTS = new Set(['unsupported_destructive_request']);

function hasActiveSlackTarget(slackSession) {
  return Boolean(
    slackSession?.activeJobId || slackSession?.activeIssueNumber || slackSession?.activePrNumber || slackSession?.activePreviewUrl
  );
}

function shouldAnalyzeSlackTurn(intake, slackSession) {
  if (NON_FOLLOWUP_ACTIONS.has(intake.action)) return false;
  if (intake.command && !intake.shouldCreateJob) return false;
  return Boolean(intake.shouldAnalyze || intake.shouldCreateJob || hasActiveSlackTarget(slackSession));
}

function looksLikeSlackFollowupText(text = '') {
  return /(preview|预览|不满意|继续|调整|修改|改成|换成|加|增加|删除|删掉|标题|文案|颜色|布局|风格|重新|再来)/i.test(text);
}

function isSlackFollowupIntent(analysis, intake, slackSession = null) {
  if (analysis?.needsClarification) return false;
  if (FOLLOWUP_INTENTS.has(analysis?.intent)) return true;
  if (analysis?.intent) {
    if (!CREATE_JOB_INTENTS.has(analysis.intent)) return false;
    if (hasActiveSlackTarget(slackSession)) return true;
    return looksLikeSlackFollowupText(intake.text);
  }
  return looksLikeSlackFollowupText(intake.text);
}

async function activeJobForSlackSession(store, slackSession) {
  if (slackSession?.activeJobId) {
    const job = await store.getJob(slackSession.activeJobId);
    if (job) return job;
  }

  const links = await store.findIssueLinksForSlackSession(slackSession.id);
  const link = links[0];
  return link?.publishingJobId ? await store.getJob(link.publishingJobId) : null;
}

function followupSummary(existingSummary, text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return existingSummary || '';
  const previous = String(existingSummary || '').trim();
  const block = ['## Slack Follow-up', '', cleanText].join('\n');
  return previous ? `${previous}\n\n${block}` : block;
}

function followupRoundFromSummary(summary = '') {
  return (String(summary || '').match(/## Slack Follow-up/g) || []).length;
}

function followupCardTitle(round) {
  return `第 ${Math.max(1, Number(round) || 1)} 轮修改处理中`;
}

function queuedFollowupClaimKey(jobId, round) {
  return `pages-manager:coding-fix:queued-followup:${jobId}:round:${Math.max(1, Number(round) || 1)}`;
}

function queuedFollowupClaimTtlMs(env = {}) {
  const minutes = Number(env.CODING_AGENT_RUN_TIMEOUT_MINUTES || env.PAGES_WORKER_TIMEOUT_MINUTES || 30);
  return Math.max((Number.isFinite(minutes) ? minutes : 30) * 60_000, 60_000);
}

async function acquireQueuedFollowupClaim(store, jobId, round, env) {
  if (!store?.redis) return { acquired: true, key: null, value: null };

  const key = queuedFollowupClaimKey(jobId, round);
  const value = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const acquired = await store.redis.set(key, value, 'PX', queuedFollowupClaimTtlMs(env), 'NX');
  return {
    acquired: acquired === 'OK',
    key,
    value,
  };
}

async function releaseQueuedFollowupClaim(store, claim) {
  if (!store?.redis || !claim?.key || !claim?.value) return;

  try {
    const current = await store.redis.get(claim.key);
    if (current === claim.value) {
      await store.redis.del(claim.key);
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'queued_followup_claim_release_failed',
        key: claim.key,
        error: error.message,
      })
    );
  }
}

function agentEventTime(event = {}) {
  const timestamp = Date.parse(event.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestAgentEvent(events = [], type) {
  return events
    .filter((event) => event.type === type)
    .sort((left, right) => agentEventTime(right) - agentEventTime(left))[0];
}

function agentEventRound(event = {}) {
  const match = String(event.text || event.dedupeKey || '').match(/(?:第\s*|round[:=])(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function queuedFollowupsAfterLastFixDispatch(events = [], summary = '') {
  const lastDispatch = latestAgentEvent(events, AGENT_EVENT_CODING_FIX_DISPATCHED);
  const lastDispatchTime = agentEventTime(lastDispatch);
  const queued = events
    .filter((event) => event.type === AGENT_EVENT_SLACK_FOLLOWUP_QUEUED)
    .filter((event) => agentEventTime(event) > lastDispatchTime)
    .sort((left, right) => agentEventTime(left) - agentEventTime(right));

  if (queued.length) return queued;

  const lastDispatchRound = agentEventRound(lastDispatch);
  const currentRound = followupRoundFromSummary(summary);
  if (currentRound <= lastDispatchRound) return [];

  return events
    .filter((event) => event.type === AGENT_EVENT_SLACK_FOLLOWUP_QUEUED)
    .sort((left, right) => agentEventTime(left) - agentEventTime(right))
    .slice(-(currentRound - lastDispatchRound));
}

async function recordCodingFixDispatch(store, job, workerStart) {
  if (!workerStart?.started || !store?.recordAgentRunEvent || job?.status !== 'fixing') return null;

  const round = followupRoundFromSummary(job.summary);
  return await store.recordAgentRunEvent({
    publishingJobId: job.id,
    slackSessionId: job.slackSessionId || null,
    type: AGENT_EVENT_CODING_FIX_DISPATCHED,
    stage: 'fixing',
    status: 'dispatched',
    text: `round:${Math.max(1, Number(round) || 1)} Coding Agent 修复已启动。`,
    dedupeKey: `coding-fix-dispatched:${job.id}:${job.updatedAt || Date.now()}:${Math.max(1, Number(round) || 1)}`,
  });
}

async function recordQueuedSlackFollowup(store, job, slackSession, feedback, agentRun) {
  if (!store?.recordAgentRunEvent || !job?.id) return null;

  return await store.recordAgentRunEvent({
    publishingJobId: job.id,
    slackSessionId: slackSession?.id || job.slackSessionId || null,
    agentRunId: agentRun?.id || null,
    type: AGENT_EVENT_SLACK_FOLLOWUP_QUEUED,
    stage: 'fixing',
    status: 'queued',
    text: feedback,
    dedupeKey: `slack-followup-queued:${job.id}:${agentRun?.id || Date.now()}`,
  });
}

async function dispatchQueuedFollowupFixIfNeeded(store, reviewedJob, env) {
  if (!reviewedJob?.id || !store?.listAgentRunEventsForJob || !store?.moveJobToFixing) return null;

  const events = await store.listAgentRunEventsForJob(reviewedJob.id);
  const queued = queuedFollowupsAfterLastFixDispatch(events, reviewedJob.summary);
  if (!queued.length) return null;

  const round = followupRoundFromSummary(reviewedJob.summary);
  const claim = await acquireQueuedFollowupClaim(store, reviewedJob.id, round, env);
  if (!claim.acquired) {
    return {
      skipped: true,
      reason: 'queued_followup_claimed',
      job: reviewedJob,
      queuedFollowupCount: queued.length,
      workerStart: null,
      dispatchEvent: null,
      slackStatusNotification: { skipped: true, reason: 'queued_followup_claimed' },
    };
  }

  const fixingJob = await store.moveJobToFixing(reviewedJob.id, {
    previewUrl: null,
    summary: reviewedJob.summary,
  });
  if (!fixingJob) {
    await releaseQueuedFollowupClaim(store, claim);
    return null;
  }

  await store.linkJobToSlackSession(fixingJob);
  const workerStart = await startWorkerForJobIfConfigured(fixingJob, env);
  if (!workerStart?.started) {
    await releaseQueuedFollowupClaim(store, claim);
  }
  const slackStatusNotification = await notifySlackJobStatus(env, store, fixingJob, {
    stage: 'fixing',
    text: `已接上 ${queued.length} 条新修改，继续启动第 ${Math.max(1, Number(round) || 1)} 轮修复。`,
    statusText: ':hourglass_flowing_sand: 已接上新的修改，正在继续更新 PR 和 Preview。',
    cardTitle: followupCardTitle(round),
    finalSummary: finalRequirementCardSummary(fixingJob.summary),
    currentChange: followupCardSummary(queued.at(-1)?.text || ''),
    allowRegression: true,
    skipDuplicate: false,
    dedupeKey: `queued-followup-dispatch:${fixingJob.id}:${workerStart?.dispatchEvent?.event?.id || Date.now()}`,
  });

  return {
    job: fixingJob,
    queuedFollowupCount: queued.length,
    workerStart,
    dispatchEvent: workerStart?.dispatchEvent || null,
    slackStatusNotification,
  };
}

function followupCardSummary(feedback = '') {
  const text = compactUserFacingText(feedback);
  return text ? `本轮修改：${text}` : '本轮修改已记录，正在更新页面。';
}

function finalRequirementCardSummary(summary = '') {
  const parts = String(summary || '')
    .split(/^\s*##\s*Slack Follow-up\s*$/gim)
    .map((part) => compactUserFacingText(part))
    .filter(Boolean);
  const base = parts.shift() || '';
  if (!parts.length) return base;

  const visibleFollowups = parts.slice(-4).map((part, index) => `${index + 1}. ${part}`);
  const hiddenCount = Math.max(0, parts.length - visibleFollowups.length);
  return [
    base || '已记录初始需求。',
    '',
    '*已追加修改*',
    hiddenCount ? `...前面还有 ${hiddenCount} 轮修改` : null,
    ...visibleFollowups,
  ]
    .filter(Boolean)
    .join('\n');
}

function userFacingSlackSummary(analysis = {}, fallback = '') {
  const sourceMessages = Array.isArray(analysis.sourceMessages || analysis.source_messages)
    ? analysis.sourceMessages || analysis.source_messages
    : [];
  const candidates = [analysis.summary, fallback, ...sourceMessages]
    .map((value) => compactUserFacingText(value))
    .filter(Boolean)
    .filter((value) => !/\b(activeJobId|activeIssueNumber|previewUrl|slackSessionId|sessionKey)\b/i.test(value));

  return candidates[0] || '已记录你的个人网站需求。';
}

function userFacingSlackTitle(analysis = {}) {
  const title = compactUserFacingText(analysis.title || '');
  if (title) return title.slice(0, 80);
  const summary = userFacingSlackSummary(analysis);
  return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
}

function redactSlackAnalysisValue(value) {
  if (typeof value === 'string') return redactSecretLikeText(value);
  if (Array.isArray(value)) return value.map((item) => redactSlackAnalysisValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSlackAnalysisValue(entry)]));
  }
  return value;
}

function redactSlackAnalysis(analysis) {
  return analysis ? redactSlackAnalysisValue(analysis) : analysis;
}

function canDispatchFixForJob(job) {
  return ['pr_created', 'reviewing', 'changes_requested', 'fixing', 'preview_deployed'].includes(job.status);
}

function shouldCloseSlackSession(intake, slackAgentAnalysis) {
  return intake.action === 'close_session' || slackAgentAnalysis?.intent === 'close_session';
}

function shouldRejectUnsupportedDestructiveSlackTurn(intake, slackAgentAnalysis) {
  return (
    intake.action === 'unsupported_destructive_request' ||
    UNSUPPORTED_DESTRUCTIVE_INTENTS.has(slackAgentAnalysis?.intent) ||
    isUnsupportedBulkDestructiveRequest(intake.text)
  );
}

function shouldCreateSlackJob(intake, slackAgentAnalysis) {
  if (!slackAgentAnalysis) return Boolean(intake.shouldCreateJob);
  if (slackAgentAnalysis.needsClarification) return false;
  return CREATE_JOB_INTENTS.has(slackAgentAnalysis.intent);
}

function shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis, slackSession) {
  if (!slackAgentAnalysis || slackAgentAnalysis.needsClarification) return false;
  if (!CREATE_JOB_INTENTS.has(slackAgentAnalysis.intent)) return false;
  if (intake.command) return false;
  if (!['agent_turn', 'create_job'].includes(intake.action)) return false;
  if (hasActiveSlackTarget(slackSession)) return false;
  return true;
}

function slackIssueConfirmationText(slackAgentAnalysis = {}) {
  const summary = userFacingSlackSummary(slackAgentAnalysis);
  const site = String(slackAgentAnalysis.siteSlug || slackAgentAnalysis.site_slug || 'profile').trim();
  const title = userFacingSlackTitle(slackAgentAnalysis);
  const lines = ['我整理好了，先等你确认。', '', `标题：${title}`, `站点：${site}`];
  if (summary) lines.push('', `需求：${summary}`);
  lines.push('', '下一步：点击「确认创建发布任务」。');
  return lines.join('\n');
}

function slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis = {}, options = {}) {
  const sessionId = slackSession?.id || '';
  const title = userFacingSlackTitle(slackAgentAnalysis);
  const site = String(slackAgentAnalysis.siteSlug || slackAgentAnalysis.site_slug || 'profile').trim();
  const summary = userFacingSlackSummary(slackAgentAnalysis);
  const status = options.statusLabel || '待确认';
  const contextText = options.contextText || '点击确认后，我会创建 issue 并开始生成 PR。';
  const fields = [
    {
      type: 'mrkdwn',
      text: `*站点*\n${site}`,
    },
    {
      type: 'mrkdwn',
      text: `*状态*\n${status}`,
    },
  ];

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: options.header || '确认发布需求' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${title}*\n${summary.slice(0, 900)}`,
      },
    },
    {
      type: 'section',
      fields,
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextText,
        },
      ],
    },
  ];

  if (options.actions !== false) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '确认创建发布任务' },
          style: 'primary',
          action_id: 'pages_confirm_issue',
          value: sessionId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '继续补充需求' },
          action_id: 'pages_continue_modifying',
          value: sessionId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '关闭会话' },
          style: 'danger',
          action_id: 'pages_close_session',
          value: sessionId,
        },
      ],
    });
  }

  return blocks;
}

function slackIssueConfirmedText(slackAgentAnalysis = {}) {
  const title = userFacingSlackTitle(slackAgentAnalysis);
  return `已确认：${title}\n我会开始创建 issue，后续进度会在当前对话更新。`;
}

function slackIssueConfirmedBlocks(slackSession, slackAgentAnalysis = {}) {
  return slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis, {
    header: '发布需求已确认',
    statusLabel: '已确认',
    contextText: '我会开始创建 issue；后续请看当前对话里的发布进度卡。',
    actions: false,
  });
}

function slackIssueWaitingMoreText(slackAgentAnalysis = {}) {
  const title = userFacingSlackTitle(slackAgentAnalysis);
  return `继续补充：${title}\n直接在当前对话回复新的要求，我会重新整理。`;
}

function slackIssueWaitingMoreBlocks(slackSession, slackAgentAnalysis = {}) {
  return slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis, {
    header: '继续补充需求',
    statusLabel: '等待补充',
    contextText: '直接在当前对话回复新的要求；确认前不会创建 issue。',
  });
}

function slackAgentReplyText(intake, slackAgentAnalysis, fallbackText = null, options = {}) {
  return redactSecretLikeText(
    (options.preferFallback ? fallbackText : null) ||
      slackAgentAnalysis?.clarifyingQuestion ||
      slackAgentAnalysis?.clarifying_question ||
      slackAgentAnalysis?.summary ||
      fallbackText ||
      intake.replyText ||
      '我已记录这轮消息，但还需要再确认一下需求。'
  );
}

function slackThreadForSession(session = {}, fallback = {}) {
  const surface = session.surfaceContext || {};
  return {
    ...(fallback || {}),
    teamId: session.teamId || fallback.teamId || null,
    channelId: session.channelId || surface.channelId || fallback.channelId || null,
    channelType: surface.channelType || fallback.channelType || (session.dmChannelId ? 'im' : null),
    messageTs: surface.messageTs || fallback.messageTs || session.threadTs || null,
    threadTs: session.threadTs || surface.threadTs || fallback.threadTs || null,
    userId: session.primarySlackUserId || fallback.userId || null,
  };
}

function slackJobBindingPatchForSession(job = {}, session = {}) {
  return {
    slackSessionId: session.id || job.slackSessionId || null,
    slackSessionKey: session.sessionKey || job.slackSessionKey || null,
    slackThread: slackThreadForSession(session, job.slackThread || {}),
  };
}

function sessionMemoryForSelectedJob(job = {}) {
  const summary = redactSecretLikeText(job.summary || job.title || job.siteSlug || '');
  return {
    summary,
    requirements: {
      intent: job.intent || 'modify_existing_preview',
      title: redactSecretLikeText(job.title || ''),
      summary,
      siteSlug: job.siteSlug || null,
      issueNumber: job.issueNumber || null,
      prNumber: job.prNumber || null,
      previewUrl: job.previewUrl || null,
    },
    pendingQuestions: [],
    lastPreviewFeedback: null,
    lastAgentResponse: job.prNumber
      ? `已切换到 PR #${job.prNumber}，后续回复会继续修改这个任务。`
      : '已切换到这个发布任务，后续回复会继续修改它。',
  };
}

async function activateJobForSlackSession(store, job, session) {
  if (!job?.id || !session?.id) return job || null;
  const slackBindingPatch = slackJobBindingPatchForSession(job, session);
  const updatedJob = (await store.patchJob(job.id, slackBindingPatch)) || { ...job, ...slackBindingPatch };
  await store.linkJobToSlackSession(updatedJob, session);
  await store.updateSessionMemory(session.id, sessionMemoryForSelectedJob(updatedJob));
  return updatedJob;
}

function slackEventId(body = {}) {
  return body.event_id || body.trigger_id || body.event?.client_msg_id || null;
}

function inferSlackChannelType(event = {}) {
  if (event.channel_type) return event.channel_type;
  return String(event.channel || '').startsWith('D') ? 'im' : null;
}

function ignoredSlackEventReason(body = {}) {
  const event = body.event || {};
  if (body.type && body.type !== 'event_callback') return null;
  if (event.subtype && event.subtype !== 'bot_message') return `ignored_subtype:${event.subtype}`;
  if (event.bot_id || event.subtype === 'bot_message') return 'ignored_bot_event';
  if (event.type === 'app_mention') return null;
  if (event.type === 'message' && inferSlackChannelType(event) === 'im') return null;
  if (event.type === 'message' && event.thread_ts) return null;
  return 'unsupported_event';
}

function shouldPostSlackResultReply(result = {}) {
  if (!result.replyText) return false;
  if (result.reply === false || result.noReply) return false;
  if (result.action === 'ignored_untracked_thread_message') return false;
  return true;
}

function interactionChannelId(body = {}, session = null) {
  return session?.channelId || body.channel?.id || body.container?.channel_id || null;
}

function interactionThreadTs(body = {}, session = null) {
  return (
    session?.threadTs ||
    body.message?.thread_ts ||
    body.message?.ts ||
    body.container?.thread_ts ||
    body.container?.message_ts ||
    null
  );
}

function interactionChannelType(channelId, session = null) {
  if (session?.dmChannelId || String(channelId || '').startsWith('D')) return 'im';
  return null;
}

function draftAnalysisFromMemory(memory = {}) {
  const requirements = memory.requirements && typeof memory.requirements === 'object' ? memory.requirements : {};
  return {
    ...requirements,
    intent: requirements.intent || 'create_or_update_site',
    summary: requirements.summary || memory.summary || '',
    title: requirements.title || memory.summary || 'Slack publishing request',
    siteSlug: requirements.siteSlug || requirements.site_slug || 'profile',
    approvalMode: requirements.approvalMode || requirements.approval_mode || 'manual_required',
    needsClarification: Boolean(requirements.needsClarification || requirements.needs_clarification),
  };
}

function hasConfirmableDraft(analysis = {}) {
  return (
    CREATE_JOB_INTENTS.has(analysis.intent) && !analysis.needsClarification && Boolean(String(analysis.summary || '').trim())
  );
}

function confirmedSlackJobBodyFromInteraction(body = {}, session, analysis = {}, requesterProfile = null) {
  const teamId = body.team?.id || body.team_id || session.teamId || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);
  const channelId = interactionChannelId(body, session);
  const threadTs = interactionThreadTs(body, session);
  const messageTs = body.message?.ts || body.container?.message_ts || threadTs || null;
  const draftHash = stableSlugHash(JSON.stringify({ analysis, sessionId: session.id }));

  return {
    team_id: teamId,
    trigger_id: body.trigger_id || `confirm:${session.id}`,
    idempotencyKey: `slack-confirm:${session.id}:${draftHash}`,
    event: {
      type: 'block_actions',
      user: slackUserId,
      channel: channelId,
      channel_type: interactionChannelType(channelId, session),
      ts: messageTs,
      thread_ts: threadTs,
      text: analysis.summary || analysis.title || 'Slack confirmed publishing request',
    },
    intake: {
      action: 'confirm_issue',
      shouldCreateJob: true,
      text: analysis.summary || analysis.title || '',
    },
    slackAgentAnalysis: analysis,
    slackSession: session,
    requesterProfile,
  };
}

async function postSlackInteractionThreadReply(env, body = {}, session = null, text = '') {
  if (!canSendSlackOutput(env) || !text) return null;
  const channel = interactionChannelId(body, session);
  if (!channel) return null;
  return postSlackMessage(env, {
    channel,
    thread_ts: interactionThreadTs(body, session) || undefined,
    text: mentionSlackUser(text, slackUserIdFromBody(body, null)),
  });
}

async function updateSlackInteractionMessage(env, body = {}, session = null, options = {}) {
  if (!canSendSlackOutput(env)) return null;
  const channel = interactionChannelId(body, session);
  const ts = body.message?.ts || body.container?.message_ts || null;
  if (!channel || !ts) return null;

  return updateSlackMessage(env, {
    channel,
    ts,
    text: mentionSlackUser(options.text || '已更新。', slackUserIdFromBody(body, null)),
    ...(options.blocks ? { blocks: options.blocks } : {}),
  });
}

function shouldPostSlackPlainProgressMessages(env = {}) {
  return String(env.SLACK_PLAIN_PROGRESS_MESSAGES || 'false').toLowerCase() === 'true';
}

async function notifySlackPlainProgress(env, store, job, text, key) {
  if (!shouldPostSlackPlainProgressMessages(env)) return null;
  return notifySlackJob(env, store, job, text, key);
}

function slackDeliveryContextFromBody(body = {}) {
  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  return {
    teamId: body.team_id || body.team?.id || event.team || 'unknown-team',
    eventId: slackEventId(body) || 'unknown-event',
    channelId: surface.channelId || null,
    threadTs: surface.threadTs || surface.messageTs || null,
    slackUserId: slackUserIdFromBody(body, null),
    requestId: body.event_context || body.trigger_id || null,
  };
}

function slackReactionName(value, fallback) {
  const normalized = String(value || fallback || '')
    .trim()
    .replace(/^:+|:+$/g, '');
  return normalized || null;
}

function slackResultType(result = {}) {
  if (result.action === 'close_session') return 'session_closed';
  if (result.action === 'clarification_needed') return 'clarification_requested';
  if (result.action === 'status' || result.action === 'status_query') return 'status_returned';
  if (result.action === 'list_work_items' || String(result.action || '').startsWith('switch_work_item')) return 'status_returned';
  if (String(result.action || '').startsWith('followup_')) return 'followup_appended';
  if (result.jobId) return 'job_created';
  if (result.replyText) return 'agent_replied';
  return 'none';
}

function slackProcessingStatus(result = {}, overrides = {}) {
  if (overrides.processingStatus) return overrides.processingStatus;
  if (result.action === 'ignored_slack_event' || result.action === 'ignored_untracked_thread_message') return 'ignored';
  return 'processed';
}

function slackDeliveryPatchForResult(result = {}, overrides = {}) {
  const processingStatus = slackProcessingStatus(result, overrides);
  return {
    processingStatus,
    resultType: overrides.resultType || slackResultType(result),
    ignoredReason:
      overrides.ignoredReason || (processingStatus === 'ignored' ? result.reason || result.action || 'ignored' : null),
    errorCode: overrides.errorCode || null,
    errorMessage: overrides.errorMessage || null,
    slackSessionId: result.slackSessionId || null,
    publishingJobId: result.jobId || null,
    agentRunId: result.agentRunId || null,
    ...(overrides.payloadRedacted ? { payloadRedacted: overrides.payloadRedacted } : {}),
  };
}

function canSendSlackOutput(env = {}) {
  const hasNotifierUrl = Boolean(env.SLACK_NOTIFIER_URL || env.PAGES_SLACK_NOTIFIER_URL);
  const hasNotifierSecret = Boolean(env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET);
  return Boolean(env.SLACK_BOT_TOKEN || (hasNotifierUrl && hasNotifierSecret));
}

function slackApiMethodUrl(env = {}, method) {
  if (env.SLACK_API_BASE_URL) {
    return `${String(env.SLACK_API_BASE_URL).replace(/\/+$/, '')}/${method}`;
  }

  return String(env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage').replace(/\/chat\.postMessage$/, `/${method}`);
}

function remoteSlackNotifierUrl(env = {}, path) {
  const base = env.SLACK_NOTIFIER_URL || env.PAGES_SLACK_NOTIFIER_URL;
  if (!base) return null;
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function remoteSlackNotifierToken(env = {}) {
  return env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET;
}

function requesterProfileFromSlackUser(body = {}, slackUser = {}) {
  const event = body.event || {};
  const profile = slackUser.profile || {};
  const slackUserId = slackUser.id || slackUserIdFromBody(body, null);
  const slackTeamId = slackUser.team_id || body.team_id || body.team?.id || event.team || null;
  const displayName = profile.display_name || profile.display_name_normalized || null;
  const realName = profile.real_name || profile.real_name_normalized || slackUser.real_name || null;
  const name = slackUser.name || profile.name || null;

  return {
    source: 'slack.users.info',
    slackTeamId,
    slackUserId,
    name,
    displayName,
    realName,
    email: profile.email || null,
  };
}

async function fetchSlackRequesterProfileFromNotifier(env = {}, slackUserId) {
  const url = remoteSlackNotifierUrl(env, '/internal/slack-notifier/user-info');
  const token = remoteSlackNotifierToken(env);
  if (!url || !token || !slackUserId) return null;

  const fetchImpl = env.SLACK_NOTIFIER_FETCH || env.SLACK_FETCH || fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Pages-Slack-Notifier-Token': token,
    },
    body: JSON.stringify({ user: slackUserId }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.ok === false || !body?.profile) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_user_profile_lookup_failed',
        slackUserId,
        via: 'slack-notifier',
        error: body?.error || response.statusText || `HTTP ${response.status}`,
      })
    );
    return null;
  }

  return body.profile;
}

async function fetchSlackRequesterProfile(env = {}, body = {}) {
  if (String(env.SLACK_USER_PROFILE_LOOKUP || 'true').toLowerCase() === 'false') return null;

  const slackUserId = slackUserIdFromBody(body, null);
  if (!slackUserId) return null;

  const notifierProfile = await fetchSlackRequesterProfileFromNotifier(env, slackUserId);
  if (notifierProfile) return notifierProfile;

  if (!env.SLACK_BOT_TOKEN) return requesterProfileFromSlackUser(body, { id: slackUserId });

  const fetchImpl = env.SLACK_PROFILE_FETCH || env.SLACK_FETCH || fetch;
  let response;
  let payload;
  try {
    response = await fetchImpl(slackApiMethodUrl(env, 'users.info'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams({ user: slackUserId }).toString(),
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_user_profile_lookup_failed',
        slackUserId,
        error: error.message,
      })
    );
    return requesterProfileFromSlackUser(body, { id: slackUserId });
  }

  if (!response.ok || payload?.ok === false || !payload?.user) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_user_profile_lookup_failed',
        slackUserId,
        error: payload?.error || response.statusText || `HTTP ${response.status}`,
      })
    );
    return requesterProfileFromSlackUser(body, { id: slackUserId });
  }

  return requesterProfileFromSlackUser(body, payload.user);
}

async function addWorkingReactionForSlackEvent(env, body = {}) {
  if (!canSendSlackOutput(env)) return null;
  if (String(env.SLACK_REACTION_ON_RECEIVE || 'false').toLowerCase() !== 'true') return null;
  if (ignoredSlackEventReason(body)) return null;

  const event = body.event || {};
  const channel = event.channel || body.channel_id;
  const timestamp = event.ts || body.event_ts;
  const name = slackReactionName(env.SLACK_WORKING_REACTION, 'eyes');
  if (!channel || !timestamp || !name) return null;

  const reaction = { channel, timestamp, name };
  let result = null;
  try {
    result = await addSlackReaction(env, reaction);
  } catch (error) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_reaction_failed',
        channel,
        timestamp,
        reaction: name,
        error: error.message,
      })
    );
    return {
      ok: false,
      error: error.message,
      reaction,
      status: 'failed',
    };
  }
  if (!result?.ok) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_reaction_failed',
        channel,
        timestamp,
        reaction: name,
        error: result?.error || 'unknown_error',
      })
    );
  }
  return {
    ...result,
    reaction,
    status: result?.ok && !result.skipped ? 'working' : 'failed',
  };
}

async function updateSlackReaction(env, currentReaction, nextName) {
  if (!canSendSlackOutput(env) || !currentReaction?.channel || !currentReaction?.timestamp) return null;
  const normalizedNextName = slackReactionName(nextName, null);
  const removed = currentReaction.name
    ? await removeSlackReaction(env, {
        channel: currentReaction.channel,
        timestamp: currentReaction.timestamp,
        name: currentReaction.name,
      })
    : null;
  const added = normalizedNextName
    ? await addSlackReaction(env, {
        channel: currentReaction.channel,
        timestamp: currentReaction.timestamp,
        name: normalizedNextName,
      })
    : null;

  for (const [action, result] of [
    ['remove', removed],
    ['add', added],
  ]) {
    if (result && !result.ok) {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_reaction_update_failed',
          action,
          channel: currentReaction.channel,
          timestamp: currentReaction.timestamp,
          reaction: action === 'add' ? normalizedNextName : currentReaction.name,
          error: result.error || 'unknown_error',
        })
      );
    }
  }

  return {
    removed,
    added,
    nextName: normalizedNextName,
  };
}

function shouldKeepWorkingReactionForResult(result = {}) {
  if (!result || result.accepted === false) return false;
  if (result.action === 'switch_work_item') return false;
  if (result.jobId) return true;
  return String(result.action || '').startsWith('followup_');
}

async function settleImmediateSlackReaction(env, workingReaction, result = {}) {
  const reaction = workingReaction?.reaction;
  if (!reaction || workingReaction?.status !== 'working') return null;
  if (shouldKeepWorkingReactionForResult(result)) return null;
  if (result.action === 'ignored_slack_event' || result.action === 'ignored_untracked_thread_message') {
    return { ...(await updateSlackReaction(env, reaction, null)), outcome: 'ignored' };
  }
  const failed = result.ok === false || result.action === 'slack_event_processing_failed';
  const doneReaction = failed
    ? slackReactionName(env.SLACK_FAILED_REACTION, 'x')
    : slackReactionName(env.SLACK_DONE_REACTION, 'white_check_mark');
  return { ...(await updateSlackReaction(env, reaction, doneReaction)), outcome: failed ? 'failed' : 'done' };
}

async function settleJobSlackReactions(env, store, job, outcome = 'done') {
  if (!job?.id || !store?.listSlackDeliveries || !store?.updateSlackDelivery) return null;
  const doneReaction =
    outcome === 'failed'
      ? slackReactionName(env.SLACK_FAILED_REACTION, 'x')
      : slackReactionName(env.SLACK_DONE_REACTION, 'white_check_mark');
  const candidates = new Map();
  const addCandidates = async (options = {}) => {
    const result = await store.listSlackDeliveries({ ...options, limit: 100 });
    for (const delivery of result?.deliveries || []) {
      const key = `${delivery.teamId || 'unknown-team'}:${delivery.eventId || 'unknown-event'}`;
      candidates.set(key, delivery);
    }
  };

  await addCandidates({ publishingJobId: job.id });
  if (job.slackSessionId) {
    await addCandidates({ slackSessionId: job.slackSessionId });
  }
  if (job.slackThread?.channelId) {
    await addCandidates({ channelId: job.slackThread.channelId });
  }

  const deliveries = [...candidates.values()].filter((delivery) => {
    if (delivery.publishingJobId === job.id) return true;
    if (job.slackSessionId && delivery.slackSessionId === job.slackSessionId) return true;
    return (
      job.slackThread?.channelId &&
      delivery.channelId === job.slackThread.channelId &&
      (!job.slackThread?.threadTs || !delivery.threadTs || delivery.threadTs === job.slackThread.threadTs)
    );
  });
  const settled = [];

  for (const delivery of deliveries) {
    const state = delivery.payloadRedacted?.workingReaction;
    if (!state || state.status !== 'working' || !state.reaction?.channel || !state.reaction?.timestamp) continue;

    let reactionResult = null;
    try {
      reactionResult = await updateSlackReaction(env, state.reaction, doneReaction);
    } catch (error) {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_reaction_settlement_failed',
          jobId: job.id,
          eventId: delivery.eventId,
          error: error.message,
        })
      );
      continue;
    }
    const nextPayload = {
      ...(delivery.payloadRedacted || {}),
      workingReaction: {
        ...state,
        status: outcome,
        doneReaction,
        settledAt: new Date().toISOString(),
      },
    };
    await store.updateSlackDelivery(
      {
        teamId: delivery.teamId,
        eventId: delivery.eventId,
      },
      {
        payloadRedacted: nextPayload,
      }
    );
    settled.push({
      eventId: delivery.eventId,
      reactionResult,
    });
  }

  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_reaction_settlement_checked',
      jobId: job.id,
      outcome,
      candidateCount: candidates.size,
      matchedCount: deliveries.length,
      settledCount: settled.length,
    })
  );

  return settled.length ? { outcome, settledCount: settled.length, settled } : null;
}

async function postSlackResultReply(env, body = {}, result = {}) {
  if (!canSendSlackOutput(env) || !shouldPostSlackResultReply(result)) return null;

  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  const channel = surface.channelId;
  if (!channel) return null;

  return postSlackMessage(env, {
    channel,
    thread_ts: surface.threadTs || event.ts || undefined,
    text: mentionSlackUser(result.replyText, slackUserIdFromBody(body, null)),
    ...(result.blocks ? { blocks: result.blocks } : {}),
  });
}

function runSlackBackground(env, task) {
  const promise = Promise.resolve()
    .then(task)
    .catch((err) => {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_event_background_failed',
          error: err.message,
        })
      );
    });

  if (typeof env.waitUntil === 'function') {
    env.waitUntil(promise);
  }

  return promise;
}

function shouldProcessSlackEventsAsync(env = {}) {
  if (env.SLACK_EVENTS_PROCESSING_MODE === 'sync') return false;
  if (env.SLACK_EVENTS_PROCESSING_MODE === 'async') return true;
  return Boolean(env.SLACK_SIGNING_SECRET);
}

function slackReactionPayloadFromResult(workingReaction, patch = {}) {
  if (!workingReaction?.reaction) return null;
  return {
    workingReaction: {
      reaction: workingReaction.reaction,
      status: workingReaction.status || 'working',
      addedAt: new Date().toISOString(),
      ...patch,
    },
  };
}

async function updateSlackDeliveryReactionState(env, body = {}, workingReaction, patch = {}) {
  if (!workingReaction?.reaction) return null;
  const store = getStore(env);
  if (!store.updateSlackDelivery) return null;
  return store.updateSlackDelivery(slackDeliveryContextFromBody(body), {
    payloadRedacted: slackReactionPayloadFromResult(workingReaction, patch),
  });
}

async function processSlackEventBody(body, env, options = {}) {
  const store = getStore(env);

  if (body.type === 'url_verification' && body.challenge) {
    return { ok: true, action: 'url_verification', challenge: body.challenge };
  }

  const eventId = slackEventId(body);
  const deliveryContext = slackDeliveryContextFromBody(body);
  const updateDelivery = async (patch = {}) => {
    if (!eventId || !store.updateSlackDelivery) return null;
    return await store.updateSlackDelivery(deliveryContext, patch);
  };
  let activeSlackAgentTurn = null;
  const respond = async (resultOrPromise, overrides = {}) => {
    const result = await resultOrPromise;
    if (activeSlackAgentTurn?.replyMessage) {
      const agentReplyNotification = await updateSlackAgentReplyMessage(
        env,
        store,
        body,
        activeSlackAgentTurn.replyMessage,
        result,
        {
          sequence: activeSlackAgentTurn.events?.at(-1)?.sequence || activeSlackAgentTurn.replyMessage.lastSequence || 1,
          status: result.ok === false ? 'failed' : 'completed',
        }
      );
      if (agentReplyNotification?.ok) {
        result.noReply = true;
        result.agentReplyNotification = agentReplyNotification;
      }
    }
    await updateDelivery(slackDeliveryPatchForResult(result, overrides));
    return result;
  };

  if (eventId && store.recordSlackDelivery) {
    const delivery = await store.recordSlackDelivery({
      ...deliveryContext,
      eventId,
      eventType: body.event?.type || body.type || null,
      action: body.event?.subtype || body.action || null,
      ...(options.workingReaction ? { payloadRedacted: slackReactionPayloadFromResult(options.workingReaction) } : {}),
    });

    if (!delivery.created) {
      return {
        ok: true,
        action: 'duplicate_slack_event',
        accepted: false,
        reply: false,
        delivery: delivery.delivery,
      };
    }
  }

  await updateDelivery({ processingStatus: 'processing' });

  const ignoredReason = ignoredSlackEventReason(body);
  if (ignoredReason) {
    return respond({
      ok: true,
      action: 'ignored_slack_event',
      reason: ignoredReason,
      accepted: false,
      reply: false,
    });
  }

  const intake = classifySlackIntake(body);
  if (isUnaddressedChannelThreadMessage(body) && !(await existingSlackThreadSession(store, body))) {
    return respond({
      ok: true,
      action: 'ignored_untracked_thread_message',
      accepted: false,
      reply: false,
    });
  }

  const sessionSelection = await selectSlackSession(store, body, intake, env);

  if (sessionSelection.forbidden) {
    return respond({
      ok: true,
      action: sessionSelection.action,
      accepted: false,
      replyText: sessionSelection.replyText,
    });
  }

  if (sessionSelection.ambiguous) {
    return respond({
      ok: true,
      action: sessionSelection.action,
      accepted: false,
      replyText: sessionSelection.replyText,
      sessions: sessionSelection.sessions.map((session) => ({
        id: session.id,
        title: session.sessionTitle,
        activeJobId: session.activeJobId,
        activeIssueNumber: session.activeIssueNumber,
        activePrNumber: session.activePrNumber,
        activePreviewUrl: session.activePreviewUrl,
      })),
    });
  }

  const slackSession = sessionSelection.session;
  const sessionMemory = sessionSelection.memory;
  const lease = slackSession ? await store.acquireSlackAgentLease(slackSession.id, sessionSelection.config) : null;

  if (lease && !lease.acquired) {
    return respond({
      ok: true,
      action: 'agent_busy',
      accepted: false,
      replyText: '上一轮会话还在处理中，请稍等一下再发。',
      slackSessionId: slackSession.id,
      agentRunId: lease.agentRun.id,
    });
  }

  const agentRun = lease?.agentRun || null;

  if (intake.action === 'list_work_items') {
    const result = await listReconciledSlackWorkItemsForSession(store, body, env, {
      limit: 5,
      includeInactive: intake.includeInactive,
    });
    await completeSlackAgentRun(store, agentRun, {
      report: { action: intake.action, accepted: false, total: result.total },
    });
    return respond({
      ok: true,
      action: 'list_work_items',
      accepted: false,
      replyText: slackWorkItemListText(result.jobs || [], { includeInactive: intake.includeInactive }),
      blocks: slackWorkItemListBlocks(slackSession, result.jobs || [], { includeInactive: intake.includeInactive }),
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      jobs: (result.jobs || []).map((job) => ({
        id: job.id,
        status: job.status,
        siteSlug: job.siteSlug,
        issueNumber: job.issueNumber,
        prNumber: job.prNumber,
        previewUrl: job.previewUrl,
      })),
    });
  }

  if (intake.action === 'switch_work_item') {
    const prNumber = intake.prNumber || parseSlackPrNumber(intake.text);
    let job = prNumber ? await findVisibleSlackJobByPrNumber(store, body, prNumber) : null;
    job = await reconcileClosedGithubIssueForJob(store, env, job, { notifySlack: true });
    if (!job) {
      await completeSlackAgentRun(store, agentRun, {
        report: { action: intake.action, accepted: false, prNumber: prNumber || null },
      });
      return respond({
        ok: true,
        action: 'switch_work_item_not_found',
        accepted: false,
        replyText: prNumber
          ? `我没有找到你可继续操作的 PR #${prNumber}。可以说「我的 PR」查看当前可选任务。`
          : '我还没识别出要继续哪个 PR。可以说「继续 PR #数字」。',
        slackSessionId: slackSession.id,
        agentRunId: agentRun?.id,
      });
    }
    if (!isActionableSlackWorkItem(job)) {
      await completeSlackAgentRun(store, agentRun, {
        report: { action: `${intake.action}_inactive`, accepted: false, prNumber, jobId: job.id, status: job.status },
      });
      return respond({
        ok: true,
        action: 'switch_work_item_inactive',
        accepted: false,
        replyText: inactiveSlackWorkItemReply(job),
        slackSessionId: slackSession.id,
        agentRunId: agentRun?.id,
      });
    }

    const activeJob = await activateJobForSlackSession(store, job, slackSession);
    const slackStatusNotification = await notifySlackJobStatus(env, store, activeJob, {
      stage: activeJob.status,
      text: '已切换到这个发布任务。',
      statusText: ':white_check_mark: 已切换到这个任务。',
      skipDuplicate: false,
      dedupeKey: `slack-switch:${activeJob.id}:${slackSession.id}:${agentRun?.id || Date.now()}`,
      slackSessionId: slackSession.id,
    });
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: activeJob.id,
      report: { action: intake.action, accepted: true, prNumber },
    });
    return respond({
      ok: true,
      action: 'switch_work_item',
      accepted: true,
      jobId: activeJob.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      replyText: `已切换到${activeJob.prNumber ? ` PR #${activeJob.prNumber}` : '这个发布任务'}，继续在这里回复修改意见即可。`,
      noReply: Boolean(slackStatusNotification?.ok),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    });
  }

  if (intake.action === 'status') {
    let statusJob = intake.jobId
      ? await store.getJob(intake.jobId)
      : slackSession
        ? await activeJobForSlackSession(store, slackSession)
        : null;
    if (statusJob && !slackJobVisibleToActor(statusJob, body)) {
      await completeSlackAgentRun(store, agentRun, {
        report: { action: intake.action, jobId: intake.jobId, forbidden: true },
      });
      return respond({
        ok: true,
        action: 'forbidden_cross_user_job',
        accepted: false,
        replyText: '这个发布任务不属于当前 Slack 用户，不能查看状态。',
        ...(slackSession ? { slackSessionId: slackSession.id } : {}),
        ...(agentRun ? { agentRunId: agentRun.id } : {}),
      });
    }
    statusJob = await reconcileClosedGithubIssueForJob(store, env, statusJob, { notifySlack: true });

    await completeSlackAgentRun(store, agentRun, {
      report: { action: intake.action, jobId: intake.jobId || null },
    });
    return respond({
      ok: true,
      action: intake.action,
      accepted: false,
      replyText: statusJob ? slackStatusReply(statusJob.id, statusJob) : intake.replyText || '我还没有在当前会话里找到发布任务。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
    });
  }

  try {
    let slackAgentAnalysis = null;
    if (intake.action === 'close_session') {
      return respond(
        handleCloseSlackSession({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
        })
      );
    }

    if (shouldAnalyzeSlackTurn(intake, slackSession)) {
      const slackAgentTurnResult = await runSlackAgentTurnIfConfigured(body, intake, env, {
        store,
        slackSession,
        sessionMemory,
        issueLinks: await store.findIssueLinksForSlackSession(slackSession.id),
        agentRun,
      });
      if (slackAgentTurnResult.cancelled) {
        return respond({
          ok: true,
          action: 'slack_agent_turn_cancelled',
          accepted: false,
          reply: false,
          noReply: true,
          slackSessionId: slackSession.id,
          agentRunId: agentRun?.id,
        });
      }
      slackAgentAnalysis = slackAgentTurnResult.analysis || null;
      activeSlackAgentTurn = slackAgentTurnResult.turn || null;

      if (shouldCloseSlackSession(intake, slackAgentAnalysis)) {
        return respond(
          handleCloseSlackSession({
            store,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
          })
        );
      }

      if (slackAgentAnalysis?.intent === 'status_query') {
        return respond(
          handleSlackAgentStatusQuery({
            store,
            env,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
          })
        );
      }

      if (shouldRejectUnsupportedDestructiveSlackTurn(intake, slackAgentAnalysis)) {
        return respond(
          handleSlackAgentNonPublishingTurn({
            store,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
            action: 'unsupported_destructive_request',
            replyText: unsupportedDestructiveRequestReply(),
            preferReplyText: true,
          })
        );
      }

      if (LIST_WORK_ITEM_INTENTS.has(slackAgentAnalysis?.intent)) {
        const result = await listReconciledSlackWorkItemsForSession(store, body, env, {
          limit: 5,
          includeInactive: intake.includeInactive,
        });
        await completeSlackAgentRun(store, agentRun, {
          provider: slackAgentAnalysis?.modelProvider || 'unknown',
          model: slackAgentAnalysis?.modelName || null,
          modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
          report: { action: 'list_work_items', accepted: false, intent: slackAgentAnalysis.intent, total: result.total },
        });
        return respond({
          ok: true,
          action: 'list_work_items',
          accepted: false,
          replyText: slackWorkItemListText(result.jobs || [], { includeInactive: intake.includeInactive }),
          blocks: slackWorkItemListBlocks(slackSession, result.jobs || [], { includeInactive: intake.includeInactive }),
          slackSessionId: slackSession.id,
          agentRunId: agentRun?.id,
          slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis),
        });
      }

      if (SWITCH_WORK_ITEM_INTENTS.has(slackAgentAnalysis?.intent)) {
        const prNumber = parseSlackPrNumber(intake.text || slackAgentAnalysis.summary || '');
        let job = prNumber ? await findVisibleSlackJobByPrNumber(store, body, prNumber) : null;
        job = await reconcileClosedGithubIssueForJob(store, env, job, { notifySlack: true });
        if (!job) {
          await completeSlackAgentRun(store, agentRun, {
            provider: slackAgentAnalysis?.modelProvider || 'unknown',
            model: slackAgentAnalysis?.modelName || null,
            modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
            report: { action: 'switch_work_item_not_found', accepted: false, intent: slackAgentAnalysis.intent, prNumber },
          });
          return respond({
            ok: true,
            action: 'switch_work_item_not_found',
            accepted: false,
            replyText: prNumber
              ? `我没有找到你可继续操作的 PR #${prNumber}。可以说「我的 PR」查看当前可选任务。`
              : '我还没识别出要继续哪个 PR。可以说「继续 PR #数字」。',
            slackSessionId: slackSession.id,
            agentRunId: agentRun?.id,
            slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis),
          });
        }
        if (!isActionableSlackWorkItem(job)) {
          await completeSlackAgentRun(store, agentRun, {
            provider: slackAgentAnalysis?.modelProvider || 'unknown',
            model: slackAgentAnalysis?.modelName || null,
            modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
            report: {
              action: 'switch_work_item_inactive',
              accepted: false,
              intent: slackAgentAnalysis.intent,
              prNumber,
              jobId: job.id,
              status: job.status,
            },
          });
          return respond({
            ok: true,
            action: 'switch_work_item_inactive',
            accepted: false,
            replyText: inactiveSlackWorkItemReply(job),
            slackSessionId: slackSession.id,
            agentRunId: agentRun?.id,
            slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis),
          });
        }

        const activeJob = await activateJobForSlackSession(store, job, slackSession);
        const slackStatusNotification = await notifySlackJobStatus(env, store, activeJob, {
          stage: activeJob.status,
          text: '已切换到这个发布任务。',
          statusText: ':white_check_mark: 已切换到这个任务。',
          skipDuplicate: false,
          dedupeKey: `slack-switch:${activeJob.id}:${slackSession.id}:${agentRun?.id || Date.now()}`,
          slackSessionId: slackSession.id,
        });
        await completeSlackAgentRun(store, agentRun, {
          publishingJobId: activeJob.id,
          provider: slackAgentAnalysis?.modelProvider || 'unknown',
          model: slackAgentAnalysis?.modelName || null,
          modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
          report: { action: 'switch_work_item', accepted: true, intent: slackAgentAnalysis.intent, prNumber },
        });
        return respond({
          ok: true,
          action: 'switch_work_item',
          accepted: true,
          jobId: activeJob.id,
          slackSessionId: slackSession.id,
          agentRunId: agentRun?.id,
          replyText: `已切换到${activeJob.prNumber ? ` PR #${activeJob.prNumber}` : '这个发布任务'}，继续在这里回复修改意见即可。`,
          noReply: Boolean(slackStatusNotification?.ok),
          slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis),
          ...(slackStatusNotification ? { slackStatusNotification } : {}),
        });
      }

      if (slackAgentAnalysis?.intent === 'cancel_request') {
        return respond(
          handleSlackAgentNonPublishingTurn({
            store,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
            action: 'cancel_request',
            replyText: '收到取消意图。当前还没有自动取消发布任务；如果已经创建了 issue，可以先在 issue 里补充“取消”。',
          })
        );
      }

      if (hasActiveSlackTarget(slackSession) && isSlackFollowupIntent(slackAgentAnalysis, intake, slackSession)) {
        return respond(
          handleSlackFollowup({
            store,
            env,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
          })
        );
      }
    }

    if (slackAgentAnalysis?.needsClarification) {
      return respond(
        handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: 'clarification_needed',
        })
      );
    }

    if (shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis, slackSession)) {
      return respond(
        handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: 'confirm_before_issue',
          replyText: slackIssueConfirmationText(slackAgentAnalysis),
          blocks: slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis),
          preferReplyText: true,
        })
      );
    }

    if (!shouldCreateSlackJob(intake, slackAgentAnalysis)) {
      return respond(
        handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: slackAgentAnalysis ? 'agent_turn_recorded' : intake.action,
        })
      );
    }

    const redactedIntake = { ...intake, text: redactSecretLikeText(intake.text) };
    const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
    await store.updateSessionMemory(slackSession.id, {
      summary: redactedSlackAgentAnalysis?.summary || redactedIntake.text,
      requirements: redactedSlackAgentAnalysis || { text: redactedIntake.text, action: redactedIntake.action },
      lastAgentResponse: redactedSlackAgentAnalysis?.needsClarification ? redactedSlackAgentAnalysis.summary : null,
    });
    const requesterProfile = await fetchSlackRequesterProfile(env, body);
    const { job, created } = await store.createJob(
      slackJobInput({
        ...body,
        intake: redactedIntake,
        slackAgentAnalysis: redactedSlackAgentAnalysis,
        slackSession,
        requesterProfile,
      })
    );
    const issueLink = await store.linkJobToSlackSession(job, slackSession);
    const slackStatusNotification = created
      ? await notifySlackJobStatus(env, store, job, {
          stage: 'received',
          agentRunId: agentRun?.id || null,
          text: '已收到 Slack 发布需求，正在整理任务。',
          statusText: ':hourglass_flowing_sand: 我已收到需求，正在整理...',
        })
      : null;
    const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: job.id,
      provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
      model: slackAgentAnalysis?.modelName || null,
      modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
      report: {
        action: intake.action,
        accepted: true,
        slackAgentUsed: Boolean(slackAgentAnalysis),
        intent: slackAgentAnalysis?.intent || null,
        modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
      },
    });
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_job_created',
        action: intake.action,
        jobId: job.id,
        created,
        slackSessionId: slackSession.id,
        slackAgentUsed: Boolean(slackAgentAnalysis),
        workerStarted: workerStart?.started ?? null,
        workerError: workerStart?.error || null,
      })
    );
    return respond({
      ok: true,
      action: intake.action,
      accepted: true,
      jobId: job.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      issueLink,
      created,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
      ...(workerStart ? { workerStart } : {}),
    });
  } catch (err) {
    await updateDelivery({
      processingStatus: 'failed',
      resultType: 'none',
      errorCode: 'slack_event_processing_failed',
      errorMessage: err.message,
    });
    if (agentRun) {
      await store.failAgentRun(agentRun.id, 'slack_agent_failed', err.message);
    }
    throw err;
  }
}

async function handleCloseSlackSession({ store, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  await failRunningSlackAgentRunsForClosedSession(store, slackSession.id, { excludeAgentRunId: agentRun?.id });
  const closedSession = await store.closeSlackSession(slackSession.id);
  await store.updateSessionMemory(slackSession.id, {
    summary: redactSecretLikeText(sessionMemory.summary || intake.text),
    lastAgentResponse: '会话已关闭。',
    pendingQuestions: [],
  });
  await completeSlackAgentRun(store, agentRun, {
    report: {
      action: 'close_session',
      accepted: true,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  return {
    ok: true,
    action: 'close_session',
    accepted: true,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText: '已关闭当前会话。继续发新需求会开启新任务。',
    session: closedSession,
  };
}

async function handleSlackAgentStatusQuery({ store, env, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const job = await reconcileClosedGithubIssueForJob(store, env, await activeJobForSlackSession(store, slackSession), {
    notifySlack: true,
  });
  const replyText = job ? slackStatusReply(job.id, job) : '我还没有在当前会话里找到发布任务。';

  await store.updateSessionMemory(slackSession.id, {
    summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory.summary || intake.text),
    lastAgentResponse: replyText,
  });
  await completeSlackAgentRun(store, agentRun, {
    publishingJobId: job?.id || null,
    provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
    model: slackAgentAnalysis?.modelName || null,
    modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
    report: {
      action: 'status_query',
      accepted: false,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  return {
    ok: true,
    action: 'status_query',
    accepted: false,
    replyText,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

async function handleSlackAgentNonPublishingTurn({
  store,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  action,
  replyText,
  blocks,
  preferReplyText = false,
}) {
  const redactedIntakeText = redactSecretLikeText(intake.text);
  const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
  const finalReplyText = slackAgentReplyText(intake, redactedSlackAgentAnalysis, replyText, { preferFallback: preferReplyText });
  await store.updateSessionMemory(slackSession.id, {
    summary: redactedSlackAgentAnalysis?.summary || redactSecretLikeText(sessionMemory.summary) || redactedIntakeText,
    requirements: redactedSlackAgentAnalysis || redactSlackAnalysis(sessionMemory.requirements) || {},
    lastAgentResponse: finalReplyText,
    pendingQuestions: redactedSlackAgentAnalysis?.needsClarification
      ? [finalReplyText]
      : redactSlackAnalysis(sessionMemory.pendingQuestions) || [],
  });
  await completeSlackAgentRun(store, agentRun, {
    provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
    model: slackAgentAnalysis?.modelName || null,
    modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
    report: {
      action,
      accepted: false,
      slackAgentUsed: Boolean(slackAgentAnalysis),
      intent: slackAgentAnalysis?.intent || null,
      needsClarification: Boolean(slackAgentAnalysis?.needsClarification),
    },
  });
  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_agent_turn_recorded',
      action,
      intent: slackAgentAnalysis?.intent || null,
      needsClarification: Boolean(slackAgentAnalysis?.needsClarification),
      textLength: intake.text.length,
    })
  );

  return {
    ok: true,
    action,
    accepted: false,
    replyText: finalReplyText,
    ...(blocks ? { blocks } : {}),
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
  };
}

async function handleSlackFollowup({ store, env, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const job = await reconcileClosedGithubIssueForJob(store, env, await activeJobForSlackSession(store, slackSession), {
    notifySlack: true,
  });
  const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
  const feedback = redactSecretLikeText(redactedSlackAgentAnalysis?.summary || intake.text);

  if (!job) {
    await completeSlackAgentRun(store, agentRun, {
      report: { action: 'followup_missing_job', accepted: false },
    });
    return {
      ok: true,
      action: 'followup_missing_job',
      accepted: false,
      replyText: '我找到了当前会话，但还没有可继续修改的发布任务。请先确认创建，或继续补充需求。',
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
    };
  }

  if (!isActionableSlackWorkItem(job)) {
    const replyText = inactiveSlackWorkItemReply(job);
    await store.updateSessionMemory(slackSession.id, {
      summary: redactSecretLikeText(sessionMemory.summary) || redactSecretLikeText(intake.text),
      requirements: redactSlackAnalysis(sessionMemory.requirements) || {},
      lastAgentResponse: replyText,
    });
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: job.id,
      provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
      model: slackAgentAnalysis?.modelName || null,
      modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
      report: {
        action: 'followup_inactive_job',
        accepted: false,
        intent: slackAgentAnalysis?.intent || null,
        status: job.status,
      },
    });
    return {
      ok: true,
      action: 'followup_inactive_job',
      accepted: false,
      jobId: job.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      replyText,
      ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
    };
  }

  const patch = {
    intent: redactedSlackAgentAnalysis?.intent || 'modify_existing_preview',
    title: redactedSlackAgentAnalysis?.title || job.title,
    summary: followupSummary(job.summary, feedback),
    previewUrl: null,
    slackSessionId: slackSession.id,
    slackSessionKey: slackSession.sessionKey,
    slackThread: slackThreadForSession(slackSession, job.slackThread || {}),
  };
  await store.updateSessionMemory(slackSession.id, {
    summary: followupSummary(sessionMemory.summary, feedback),
    requirements: redactedSlackAgentAnalysis || { text: redactSecretLikeText(intake.text), action: 'followup' },
    lastPreviewFeedback: feedback,
    lastAgentResponse: null,
  });

  let updatedJob = null;
  let workerStart = null;
  let slackStatusNotification = null;
  let action = 'followup_recorded';
  let replyText = '收到，已记录这轮修改意见。';

  if (canDispatchFixForJob(job)) {
    updatedJob = job.status === 'fixing' ? await store.patchJob(job.id, patch) : await store.moveJobToFixing(job.id, patch);
    if (updatedJob) {
      await store.linkJobToSlackSession(updatedJob, slackSession);
      const round = followupRoundFromSummary(updatedJob.summary);
      const alreadyFixing = job.status === 'fixing';
      slackStatusNotification = await notifySlackJobStatus(env, store, updatedJob, {
        stage: 'fixing',
        text: alreadyFixing ? `已排队第 ${round || 1} 轮修改。` : `正在处理第 ${round || 1} 轮修改。`,
        statusText: alreadyFixing
          ? ':hourglass_flowing_sand: 当前修复正在进行，本轮会在结束后继续处理。'
          : ':hourglass_flowing_sand: 正在更新 PR 和 Preview。',
        cardTitle: alreadyFixing ? `第 ${Math.max(1, Number(round) || 1)} 轮修改已排队` : followupCardTitle(round),
        finalSummary: finalRequirementCardSummary(updatedJob.summary),
        currentChange: followupCardSummary(feedback),
        allowRegression: true,
        skipDuplicate: false,
        dedupeKey: `slack-followup:${updatedJob.id}:${agentRun?.id || Date.now()}`,
      });
      if (alreadyFixing) {
        await recordQueuedSlackFollowup(store, updatedJob, slackSession, feedback, agentRun);
        action = 'followup_fix_queued';
        replyText = '收到，已追加修改意见；当前修复结束后会继续处理这一轮。';
      } else {
        workerStart = await startWorkerForJobIfConfigured(updatedJob, env);
        action = workerStart?.started ? 'followup_fix_dispatched' : 'followup_fix_ready';
        replyText = workerStart?.started ? '收到，已追加修改意见，正在启动修复。' : '收到，已追加修改意见，等待修复开始。';
      }
    }
  }

  if (!updatedJob) {
    updatedJob = await store.patchJob(job.id, patch);
    await store.linkJobToSlackSession(updatedJob, slackSession);
    replyText = '收到，已记录。会继续沿用当前会话。';
  }

  await completeSlackAgentRun(store, agentRun, {
    publishingJobId: updatedJob.id,
    provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
    model: slackAgentAnalysis?.modelName || null,
    modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
    report: {
      action,
      accepted: true,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_followup_recorded',
      action,
      jobId: updatedJob.id,
      slackSessionId: slackSession.id,
      workerStarted: workerStart?.started ?? null,
      workerError: workerStart?.error || null,
    })
  );

  return {
    ok: true,
    action,
    accepted: true,
    jobId: updatedJob.id,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText,
    noReply: action === 'followup_fix_dispatched' || action === 'followup_fix_ready' || action === 'followup_fix_queued',
    job: updatedJob,
    ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(workerStart ? { workerStart } : {}),
  };
}

async function completeSlackAgentRun(store, agentRun, patch = {}) {
  if (!agentRun) return null;
  return await store.completeAgentRun(agentRun.id, patch);
}

async function slackAgentRunStillRunning(store, run = {}) {
  const agentRunId = typeof run === 'string' ? run : run?.id || run?.agentRunId || null;
  if (!agentRunId) return true;
  if (!store?.getAgentRun && !store?.listAgentRunsForSlackSession) return true;

  let current = store.getAgentRun ? await store.getAgentRun(agentRunId) : null;
  if (!current && store.listAgentRunsForSlackSession && run?.slackSessionId) {
    const runs = await store.listAgentRunsForSlackSession(run.slackSessionId);
    current = runs.find((item) => item.id === agentRunId) || null;
  }
  return current ? current.status === 'running' : false;
}

async function failRunningSlackAgentRunsForClosedSession(store, slackSessionId, options = {}) {
  if (!slackSessionId || !store?.listAgentRunsForSlackSession || !store?.failAgentRun) return [];

  const excludeAgentRunId = options.excludeAgentRunId || null;
  const runs = await store.listAgentRunsForSlackSession(slackSessionId);
  const failed = [];
  for (const run of runs) {
    if (
      run.agentKind !== 'slack_agent' ||
      run.status !== 'running' ||
      (excludeAgentRunId && run.id === excludeAgentRunId)
    ) {
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

export async function handleHealth(_request, env = {}) {
  const store = getStore(env);
  return jsonResponse({
    status: 'ok',
    service: 'pages-gateway',
    storeBackend: store.backend || env.PAGES_STORE_BACKEND || 'memory',
  });
}

export async function handleReady(_request, env = {}) {
  const store = getStore(env);

  try {
    const health = store.health ? await store.health() : { ok: true, backend: store.backend || 'unknown' };
    return jsonResponse({
      status: 'ready',
      service: 'pages-gateway',
      storeBackend: health.backend || store.backend || env.PAGES_STORE_BACKEND || 'memory',
    });
  } catch (error) {
    return jsonResponse(
      {
        status: 'not_ready',
        service: 'pages-gateway',
        storeBackend: store.backend || env.PAGES_STORE_BACKEND || 'unknown',
        error: error.message,
      },
      503
    );
  }
}

export async function handleCreatePublishingJob(request, env) {
  const store = getStore(env);
  const body = await readJson(request);
  const { job, created } = await store.createJob(normalizePublishingJobInput(body, request));
  const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;

  return jsonResponse({ job, created, ...(workerStart ? { workerStart } : {}) }, created ? 201 : 200);
}

export async function handleListPublishingJobs(request, env) {
  const url = new URL(request.url);
  const result = await getStore(env).listJobs({
    status: url.searchParams.get('status') || undefined,
    source: url.searchParams.get('source') || undefined,
    q: url.searchParams.get('q') || undefined,
    limit: url.searchParams.get('limit') || undefined,
    offset: url.searchParams.get('offset') || undefined,
  });

  return jsonResponse(result);
}

export async function handleGetPublishingJob(_request, env, params) {
  const job = await getStore(env).getJob(params.jobId);
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ job });
}

export async function handleGetPublishingJobEvents(_request, env, params) {
  const store = getStore(env);
  if (!(await store.getJob(params.jobId))) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ events: await store.listEvents(params.jobId) });
}

export async function handleSlackEvents(request, env) {
  const { body } = await readSlackRequest(request, env);

  if (body.type === 'url_verification' && body.challenge) {
    return slackChallengeResponse(body);
  }

  const process = async () => {
    const workingReaction = await addWorkingReactionForSlackEvent(env, body);
    try {
      const result = await processSlackEventBody(body, env, { workingReaction });
      await postSlackResultReply(env, body, result);
      const settledReaction = await settleImmediateSlackReaction(env, workingReaction, result);
      if (settledReaction) {
        await updateSlackDeliveryReactionState(env, body, workingReaction, {
          status: settledReaction.outcome || 'done',
          doneReaction: settledReaction.nextName || null,
          settledAt: new Date().toISOString(),
        });
      }
      return result;
    } catch (err) {
      const settledReaction = await settleImmediateSlackReaction(env, workingReaction, {
        ok: false,
        action: 'slack_event_processing_failed',
      });
      if (settledReaction) {
        await updateSlackDeliveryReactionState(env, body, workingReaction, {
          status: 'failed',
          doneReaction: settledReaction.nextName || null,
          settledAt: new Date().toISOString(),
        });
      }
      throw err;
    }
  };

  if (shouldProcessSlackEventsAsync(env)) {
    runSlackBackground(env, process);
    return slackAckResponse({ ok: true, accepted: true });
  }

  return jsonResponse(await process());
}

export async function handleSlackInteractions(request, env) {
  const { body } = await readSlackRequest(request, env);
  const store = getStore(env);
  const action = body.actions?.[0] || {};
  const actionId = action.action_id || '';
  const teamId = body.team?.id || body.team_id || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);

  if (actionId === 'pages_confirm_issue') {
    const sessionId = action.value || '';
    const session = await store.getSlackSession(sessionId);
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个会话不属于当前 Slack 用户，不能创建发布任务。',
      });
    }

    if (session.activeJobId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话已经在处理中。继续回复修改意见即可。',
      });
    }

    const sessionMemory = await store.getSessionMemory(session.id);
    const slackAgentAnalysis = draftAnalysisFromMemory(sessionMemory);
    if (!hasConfirmableDraft(slackAgentAnalysis)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话还没有可确认的发布需求。请先继续补充你想做的个人网站内容。',
      });
    }

    const requesterProfile = await fetchSlackRequesterProfile(
      env,
      confirmedSlackJobBodyFromInteraction(body, session, slackAgentAnalysis)
    );
    const { job, created } = await store.createJob(
      slackJobInput(confirmedSlackJobBodyFromInteraction(body, session, slackAgentAnalysis, requesterProfile))
    );
    const issueLink = await store.linkJobToSlackSession(job, session);
    await store.updateSessionMemory(session.id, {
      summary: redactSecretLikeText(slackAgentAnalysis.summary || sessionMemory.summary),
      requirements: redactSlackAnalysis(slackAgentAnalysis),
      lastAgentResponse: '已确认创建发布任务。',
      pendingQuestions: [],
    });

    const slackStatusNotification = created
      ? await notifySlackJobStatus(env, store, job, {
          stage: 'received',
          text: '用户已确认发布需求，正在创建 GitHub issue。',
          statusText: ':hourglass_flowing_sand: 已确认，正在创建 GitHub issue...',
          skipDuplicate: false,
        })
      : null;
    const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;
    const confirmationCardUpdate = await updateSlackInteractionMessage(env, body, session, {
      text: slackIssueConfirmedText(slackAgentAnalysis),
      blocks: slackIssueConfirmedBlocks(session, slackAgentAnalysis),
    });

    return slackAckResponse({
      ok: true,
      ...(created ? {} : { response_type: 'ephemeral', text: '这个需求已经确认过，继续在当前会话补充即可。' }),
      jobId: job.id,
      issueLink,
      created,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(workerStart ? { workerStart } : {}),
      ...(confirmationCardUpdate ? { confirmationCardUpdate } : {}),
    });
  }

  if (actionId === 'pages_select_work_item') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个任务卡片不属于当前 Slack 用户，不能切换。',
      });
    }

    let job = value.jobId ? await store.getJob(value.jobId) : null;
    if (!job || !slackJobVisibleToActor(job, body)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个发布任务不存在，或不属于当前 Slack 用户。',
      });
    }
    job = await reconcileClosedGithubIssueForJob(store, env, job, { notifySlack: true });
    if (!isActionableSlackWorkItem(job)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: inactiveSlackWorkItemReply(job),
      });
    }

    const activeJob = await activateJobForSlackSession(store, job, session);
    await notifySlackJobStatus(env, store, activeJob, {
      stage: activeJob.status,
      text: '已切换到这个发布任务。',
      statusText: ':white_check_mark: 已切换到这个任务。',
      skipDuplicate: false,
      dedupeKey: `slack-select:${activeJob.id}:${session.id}:${body.trigger_id || Date.now()}`,
      slackSessionId: session.id,
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: `已切换到${activeJob.prNumber ? ` PR #${activeJob.prNumber}` : '这个发布任务'}，继续在这个对话里回复修改意见即可。`,
    });
  }

  if (actionId === 'pages_reopen_work_item') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个任务卡片不属于当前 Slack 用户，不能重新打开。',
      });
    }

    let job = value.jobId ? await store.getJob(value.jobId) : null;
    if (!job || !slackJobVisibleToActor(job, body)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个发布任务不存在，或不属于当前 Slack 用户。',
      });
    }

    const target = value.target || reopenTargetForSlackWorkItem(job);
    if (!isReopenableSlackWorkItem(job) || !target) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个发布任务当前不能重新打开。',
      });
    }

    let resource = null;
    try {
      resource = await reopenGithubResourceForJob(env, job, target);
    } catch (err) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: `重新打开失败：${err.message}`,
      });
    }

    job = await restoreJobForReopenedGithubResource(store, job, target, resource || {});
    await store.linkJobToSlackSession(job, session);
    const workerStart = await startWorkerForJobIfConfigured(job, env);
    const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: job.status,
      text: target === 'pr' ? 'GitHub PR 已重新打开，发布任务已恢复。' : 'GitHub issue 已重新打开，发布任务已恢复。',
      statusText: target === 'pr' ? ':white_check_mark: GitHub PR 已重新打开，任务已恢复。' : ':white_check_mark: GitHub issue 已重新打开，任务已恢复。',
      skipDuplicate: false,
      dedupeKey: `slack-reopen:${target}:${job.id}:${body.trigger_id || Date.now()}`,
      slackSessionId: session.id,
    });
    const refreshed = await listReconciledSlackWorkItemsForSession(store, body, env, {
      limit: 5,
      includeInactive: Boolean(value.includeInactive),
    });
    const listUpdate = await updateSlackInteractionMessage(env, body, session, {
      text: slackWorkItemListText(refreshed.jobs || [], { includeInactive: Boolean(value.includeInactive) }),
      blocks: slackWorkItemListBlocks(session, refreshed.jobs || [], { includeInactive: Boolean(value.includeInactive) }),
    });

    return slackAckResponse({
      response_type: 'ephemeral',
      text: target === 'pr' ? '已重新打开 PR，继续在这个对话里回复修改意见即可。' : '已重新打开 Issue，继续在这个对话里回复修改意见即可。',
      jobId: job.id,
      ...(workerStart ? { workerStart } : {}),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(listUpdate ? { listUpdate } : {}),
    });
  }

  if (actionId === 'pages_close_session') {
    const sessionId = action.value || '';
    const session = await store.getSlackSession(sessionId);
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个会话不属于当前 Slack 用户，不能关闭。',
      });
    }

    await failRunningSlackAgentRunsForClosedSession(store, session.id);
    await store.closeSlackSession(session.id);
    await postSlackInteractionThreadReply(env, body, session, '已关闭当前会话。继续发新需求会开启新任务。');
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '已关闭当前会话。继续发新需求会开启新任务。',
    });
  }

  if (actionId === 'pages_continue_modifying') {
    const sessionId = action.value || '';
    const session = await store.getSlackSession(sessionId);
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个会话不属于当前 Slack 用户，不能继续修改。',
      });
    }

    const sessionMemory = await store.getSessionMemory(session.id);
    const slackAgentAnalysis = draftAnalysisFromMemory(sessionMemory);
    const cardUpdate = await updateSlackInteractionMessage(env, body, session, {
      text: slackIssueWaitingMoreText(slackAgentAnalysis),
      blocks: slackIssueWaitingMoreBlocks(session, slackAgentAnalysis),
    });

    return slackAckResponse({
      response_type: 'ephemeral',
      text: '直接继续回复修改意见即可，我会沿用当前会话。',
      ...(cardUpdate ? { cardUpdate } : {}),
    });
  }

  return slackAckResponse({ ok: true });
}

async function listReviewReconcileCandidateJobs(store, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 200);
  const jobs = [];

  for (const status of REVIEW_RECONCILE_JOB_STATUSES) {
    const result = await store.listJobs({ status, limit });
    jobs.push(...(result.jobs || []));
  }

  const seen = new Set();
  return jobs
    .filter((job) => {
      if (!job?.id || seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    })
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return leftTime - rightTime;
    })
    .slice(0, limit);
}

export async function handleReviewGateReconcile(request, env) {
  const authError = verifyInternalCallbackToken(request, env);
  if (authError) return authError;

  const body = await readJson(request);
  const store = getStore(env);
  const nowMs = Date.now();
  const jobs = body.publishingJobId
    ? [await store.getJob(body.publishingJobId)].filter(Boolean)
    : await listReviewReconcileCandidateJobs(store, { limit: body.limit });

  const results = [];
  for (const job of jobs) {
    results.push(await reconcileReviewGateForJob(store, job, env, nowMs));
  }

  return jsonResponse({
    ok: true,
    checked: jobs.length,
    reconciled: results.filter((result) => result.reviewAction).length,
    results,
  });
}

export async function handleExecutorCallback(request, env) {
  const authError = verifyInternalCallbackToken(request, env);
  if (authError) return authError;

  const body = await readJson(request);
  const jobId = required(body.publishingJobId || body.publishing_job_id, 'publishingJobId');

  if (body.status === 'failed') {
    const store = getStore(env);
    const job = await store.failJob(jobId, body.errorCode || body.error_code, body.errorMessage || body.error_message);
    if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
    await store.linkJobToSlackSession(job);
    const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: 'failed',
      text: job.errorMessage || job.errorCode || '发布任务失败',
      statusText: ':x: 发布任务失败',
    });
    const slackNotification = await notifySlackJob(
      env,
      store,
      job,
      `失败：${job.errorMessage || job.errorCode || '发布任务失败'}`,
      `failed:${job.errorCode || 'unknown'}`
    );
    const slackReactionSettlement = await settleJobSlackReactions(env, store, job, 'failed');
    return jsonResponse({
      job,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(slackNotification ? { slackNotification } : {}),
      ...(slackReactionSettlement ? { slackReactionSettlement } : {}),
    });
  }

  const stageResult = required(body.stageResult || body.stage_result, 'stageResult');
  const rule = CALLBACK_STAGE_RESULTS[stageResult];
  if (!rule) return jsonResponse({ error: 'Unsupported stageResult', stageResult }, 400);

  const patch = rule.patch ? rule.patch(body) : {};
  const store = getStore(env);
  const previousJob = await store.getJob(jobId);
  let job = await applyExecutorCallback(store, jobId, stageResult, rule.status, patch);
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  await store.linkJobToSlackSession(job);
  let workerStart = await startWorkerForJobIfConfigured(job, env);
  let queuedFollowupRerun = null;
  let reviewReplay = null;
  let slackStatusNotification = null;

  if (previousJob?.status === 'fixing' && stageResult === 'reviewing') {
    queuedFollowupRerun = await dispatchQueuedFollowupFixIfNeeded(store, job, env);
    if (queuedFollowupRerun) {
      job = queuedFollowupRerun.job;
      workerStart = queuedFollowupRerun.workerStart;
      slackStatusNotification = queuedFollowupRerun.slackStatusNotification;
      await store.linkJobToSlackSession(job);
    }
  }

  if (!queuedFollowupRerun) {
    reviewReplay = stageResult === 'pr_created' ? await dispatchPreviewFromStoredReviewIfReady(job, store, env) : null;
  }

  if (reviewReplay) {
    job = reviewReplay.job;
    workerStart = reviewReplay.workerStart;
    await store.linkJobToSlackSession(job);
  }

  if (!slackStatusNotification) {
    const statusText = reviewReplay
      ? notificationTextForReviewAction(reviewReplay.reviewAction, {
          gate: reviewReplay.gate,
          reviewComment: reviewReplay.reviewComment,
        })
      : notificationTextForCallback(stageResult, job) || `PublishingJob moved to ${job.status}`;
    slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: reviewReplay ? job.status : stageResult,
      text: statusText,
      allowRegression: previousJob?.status === 'fixing' && stageResult === 'reviewing',
      skipDuplicate: previousJob?.status === 'fixing' ? false : undefined,
    });
  }
  const slackText = notificationTextForCallback(stageResult, job);
  const slackNotification = queuedFollowupRerun
    ? null
    : await notifySlackPlainProgress(env, store, job, slackText, `callback:${stageResult}`);
  const slackReactionSettlement =
    stageResult === 'preview_deployed' || job.status === 'preview_deployed'
      ? await settleJobSlackReactions(env, store, job, 'done')
      : null;

  return jsonResponse({
    job,
    ...(workerStart ? { workerStart } : {}),
    ...(reviewReplay
      ? {
          reviewReplay: {
            reviewAction: reviewReplay.reviewAction,
            gate: reviewReplay.gate,
            reviewComment: reviewReplay.reviewComment,
          },
        }
      : {}),
    ...(queuedFollowupRerun
      ? {
          queuedFollowupRerun: {
            queuedFollowupCount: queuedFollowupRerun.queuedFollowupCount,
            skipped: queuedFollowupRerun.skipped || false,
            reason: queuedFollowupRerun.reason || null,
            dispatchEventCreated: queuedFollowupRerun.dispatchEvent?.created ?? null,
          },
        }
      : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(slackNotification ? { slackNotification } : {}),
    ...(slackReactionSettlement ? { slackReactionSettlement } : {}),
  });
}

async function moveJobToChangesRequestedForSiteCheck(store, job, patch = {}) {
  if (!job) return null;
  if (job.status === 'changes_requested') {
    return await store.patchJob(job.id, patch);
  }

  let current = job;
  if (current.status === 'pr_created') {
    current = await store.updateJob(current.id, 'reviewing', patch);
  }
  if (current.status === 'reviewing') {
    return await store.updateJob(current.id, 'changes_requested', patch);
  }
  return current;
}

async function handleGithubSiteCheckWebhook({ siteCheckRun, store, env, result }) {
  const storedRun = await store.recordSiteCheckRun(siteCheckRun);
  const fullHeadSha = siteCheckRun.headSha && siteCheckRun.headSha.length === 40 ? siteCheckRun.headSha : null;
  let job = await store.findJobByPrNumber(siteCheckRun.prNumber, fullHeadSha ? { headSha: fullHeadSha } : {});
  let gate = job
    ? await previewGateForPr(store, siteCheckRun.repoFullName, siteCheckRun.prNumber, fullHeadSha ? { headSha: fullHeadSha } : {})
    : null;
  let workerStart = null;
  let reviewReplay = null;
  let reviewAction = 'site_check_recorded';
  let slackStatusNotification = null;
  let slackNotification = null;

  if (job && fullHeadSha && job.headSha !== fullHeadSha) {
    job = await store.patchJob(job.id, { headSha: fullHeadSha });
  }

  if (job && siteCheckRun.status === 'completed' && siteCheckRun.conclusion === 'success') {
    reviewReplay = await dispatchPreviewFromStoredReviewIfReady(job, store, env);
    if (reviewReplay) {
      job = reviewReplay.job;
      workerStart = reviewReplay.workerStart;
      gate = reviewReplay.gate;
      reviewAction = reviewReplay.reviewAction;
    } else {
      reviewAction = 'site_check_passed';
    }
  } else if (job && siteCheckRun.status === 'completed' && siteCheckRun.conclusion && siteCheckRun.conclusion !== 'success') {
    job = await moveJobToChangesRequestedForSiteCheck(store, job, fullHeadSha ? { headSha: fullHeadSha } : {});
    gate = await previewGateForPr(
      store,
      siteCheckRun.repoFullName,
      siteCheckRun.prNumber,
      fullHeadSha ? { headSha: fullHeadSha } : {}
    );
    reviewAction = 'site_check_failed';
  } else if (job) {
    reviewAction = 'site_check_waiting';
  }

  if (job) {
    await store.linkJobToSlackSession(job);
    const text = notificationTextForReviewAction(reviewAction, { gate, siteCheckRun: storedRun.run });
    slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: job.status,
      text: text || reviewAction,
      dedupeKey: [
        'site-check-status',
        job.id,
        siteCheckRun.checkRunNodeId,
        siteCheckRun.status || 'unknown',
        siteCheckRun.conclusion || 'none',
      ].join(':'),
      skipDuplicate: false,
    });
    slackNotification = await notifySlackPlainProgress(
      env,
      store,
      job,
      text,
      `site-check:${reviewAction}:${siteCheckRun.checkRunNodeId}`
    );
  }

  return jsonResponse({
    ok: true,
    created: true,
    delivery: result.delivery,
    reviewAction,
    siteCheckRun: storedRun.run,
    siteCheckRunCreated: storedRun.created,
    ...(gate ? { gate } : {}),
    ...(job ? { job } : {}),
    ...(workerStart ? { workerStart } : {}),
    ...(reviewReplay
      ? {
          reviewReplay: {
            reviewAction: reviewReplay.reviewAction,
            gate: reviewReplay.gate,
            reviewComment: reviewReplay.reviewComment,
          },
        }
      : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(slackNotification ? { slackNotification } : {}),
  });
}

export async function handleGithubWebhook(request, env) {
  const rawBody = await request.text();
  await verifyGithubWebhookSignature(request, env, rawBody);
  const body = parseGithubWebhookBody(rawBody);
  const repoFullName = body.repository?.full_name || request.headers.get('X-GitHub-Repository') || 'unknown/repo';
  const deliveryId = required(request.headers.get('X-GitHub-Delivery') || body.deliveryId, 'deliveryId');
  const eventName = request.headers.get('X-GitHub-Event') || body.eventName || 'unknown';
  const action = body.action || null;
  const store = getStore(env);
  const result = await store.recordGithubDelivery({ repoFullName, deliveryId, eventName, action });

  if (!result.created) {
    return jsonResponse({ ok: true, created: false, delivery: result.delivery });
  }

  if (eventName === 'issues') {
    return handleGithubIssueWebhook({ body, action, store, env, result });
  }

  if (eventName === 'pull_request') {
    return handleGithubPullRequestWebhook({ body, action, store, env, result });
  }

  const siteCheckRun = normalizeSiteCheckRunWebhook(body, eventName, deliveryId, repoFullName);
  if (siteCheckRun && isAllowedSiteCheckRun(siteCheckRun, env)) {
    return handleGithubSiteCheckWebhook({ siteCheckRun, store, env, result });
  }

  const normalized = normalizeReviewAgentWebhook(body, eventName, deliveryId, repoFullName);
  if (!normalized) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_event' });
  }

  if (!isAllowedReviewAgent(normalized, env)) {
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      ignored: 'review_agent_not_allowed',
      reviewAgentLogin: normalized.reviewAgentLogin,
    });
  }

  const reviewComment = await store.recordReviewAgentComment(normalized);
  const job = await store.findJobByPrNumber(normalized.prNumber, { headSha: normalized.headSha });
  const gate = await previewGateForPr(
    store,
    repoFullName,
    normalized.prNumber,
    normalized.headSha ? { headSha: normalized.headSha } : {}
  );
  let updatedJob = job;
  let workerStart = null;
  let reviewAction = 'recorded';
  let slackStatusNotification = null;
  let slackNotification = null;

  const fullHeadSha = normalized.headSha && normalized.headSha.length === 40 ? normalized.headSha : null;

  if (updatedJob && fullHeadSha && updatedJob.headSha !== fullHeadSha) {
    updatedJob = await store.patchJob(updatedJob.id, { headSha: fullHeadSha });
  }

  if (updatedJob && updatedJob.status === 'pr_created') {
    updatedJob = await store.updateJob(updatedJob.id, 'reviewing', fullHeadSha ? { headSha: fullHeadSha } : {});
    reviewAction = 'reviewing';
  }

  if (updatedJob && gate.blockingCount > 0 && ['reviewing', 'changes_requested'].includes(updatedJob.status)) {
    updatedJob =
      updatedJob.status === 'changes_requested'
        ? updatedJob
        : await store.updateJob(updatedJob.id, 'changes_requested', fullHeadSha ? { headSha: fullHeadSha } : {});
    reviewAction = 'changes_requested';
  } else if (shouldDispatchPreviewForReview(updatedJob, normalized, gate)) {
    if (updatedJob.status !== 'previewing') {
      updatedJob = await store.updateJob(updatedJob.id, 'previewing', fullHeadSha ? { headSha: fullHeadSha } : {});
    }
    workerStart = await startWorkerForJobIfConfigured(updatedJob, env);
    reviewAction = 'preview_dispatched';
  } else if (shouldReportSiteCheckWaiting(updatedJob, normalized, gate)) {
    reviewAction = 'site_check_waiting';
  }

  if (updatedJob) {
    await store.linkJobToSlackSession(updatedJob);
    slackStatusNotification = await notifySlackJobStatus(env, store, updatedJob, {
      stage: updatedJob.status,
      text: notificationTextForReviewAction(reviewAction, { gate, reviewComment: reviewComment.comment }) || reviewAction,
    });
    slackNotification = await notifySlackPlainProgress(
      env,
      store,
      updatedJob,
      notificationTextForReviewAction(reviewAction, { gate, reviewComment: reviewComment.comment }),
      `review:${reviewAction}:${normalized.githubCommentNodeId}`
    );
  }

  return jsonResponse({
    ok: true,
    created: true,
    delivery: result.delivery,
    reviewAction,
    reviewComment: reviewComment.comment,
    reviewCommentCreated: reviewComment.created,
    gate,
    ...(updatedJob ? { job: updatedJob } : {}),
    ...(workerStart ? { workerStart } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(slackNotification ? { slackNotification } : {}),
  });
}
