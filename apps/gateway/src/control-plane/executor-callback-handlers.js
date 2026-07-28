import { jsonResponse } from '@xd/worker-kit';
import { dispatchPreviewFromStoredReviewIfReady, listReviewReconcileCandidateJobs, reconcileReviewGateForJob } from '../github/review-gate.js';
import { readJson } from '../http/body.js';
import { getStore, required, verifyInternalCallbackToken } from './context.js';
import { dispatchQueuedPlatformDevFollowupIfNeeded } from '../platform-dev/automation.js';
import { applyExecutorCallback, CALLBACK_STAGE_RESULTS } from '../publishing/callback-rules.js';
import { startWorkerForJobIfConfigured, startWorkerForPlatformDevItemIfConfigured } from '../publishing/worker-dispatcher.js';
import { notificationTextForCallback, notificationTextForReviewAction, notifySlackJob, notifySlackJobStatus } from '../slack/notifier.js';
import { notifySlackPlainProgress, settleJobSlackReactions } from '../slack/delivery.js';
import { notifySlackPlatformDevStatus, platformNotificationText } from '../slack/platform-notifier.js';
import { dispatchQueuedFollowupFixIfNeeded } from '../slack/followup.js';

const TERMINAL_FAILED_CALLBACK_JOB_STATUSES = new Set(['failed', 'cancelled', 'merged', 'deployed']);

const TERMINAL_FAILED_CALLBACK_PLATFORM_STATUSES = new Set(['failed', 'cancelled', 'merged', 'closed_unmerged']);

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function prNumberMatches(left, right) {
  if (!left || !right) return false;
  return Number(left) === Number(right);
}

function isPreviewFailureCallback(body = {}) {
  const workflowName = body.workflowName || body.workflow_name || '';
  const errorCode = body.errorCode || body.error_code || '';
  return workflowName === 'pages-preview.yml' || errorCode === 'PREVIEW_DEPLOY_FAILED';
}

function shouldIgnoreStaleFailedPreviewCallback(existingJob = {}, body = {}) {
  if (!isPreviewFailureCallback(body)) return false;
  const callbackHeadSha = body.headSha || body.head_sha || null;
  const callbackPrNumber = body.prNumber || body.pr_number || null;
  if (existingJob.headSha && !callbackHeadSha) return true;
  if (existingJob.headSha && callbackHeadSha && !shaMatches(existingJob.headSha, callbackHeadSha)) return true;
  if (existingJob.prNumber && !prNumberMatches(existingJob.prNumber, callbackPrNumber)) return true;
  return false;
}

function shouldIgnoreStaleFailedPlatformCallback(existingItem = {}, body = {}) {
  const callbackHeadSha = body.headSha || body.head_sha || null;
  const callbackWorkflowRunId = body.workflowRunId || body.workflow_run_id || null;

  if (existingItem.workflowRunId && !callbackWorkflowRunId && !callbackHeadSha) return true;
  if (
    existingItem.workflowRunId &&
    callbackWorkflowRunId &&
    String(existingItem.workflowRunId) !== String(callbackWorkflowRunId)
  ) {
    return true;
  }
  if (existingItem.headSha && !callbackHeadSha && !callbackWorkflowRunId) return true;
  if (existingItem.headSha && callbackHeadSha && !shaMatches(existingItem.headSha, callbackHeadSha)) return true;
  return false;
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
  if ((body.workItemKind || body.work_item_kind) === 'platform_dev' || body.platformDevItemId || body.platform_dev_item_id) {
    return handlePlatformDevExecutorCallback(body, env);
  }

  const jobId = required(body.publishingJobId || body.publishing_job_id, 'publishingJobId');

  if (body.status === 'failed') {
    const store = getStore(env);
    const existingJob = await store.getJob(jobId);
    if (!existingJob) return jsonResponse({ error: 'PublishingJob not found' }, 404);
    if (TERMINAL_FAILED_CALLBACK_JOB_STATUSES.has(existingJob.status)) {
      await store.linkJobToSlackSession(existingJob);
      return jsonResponse({
        job: existingJob,
        ignored: true,
        ignoredStatus: existingJob.status,
        ignoredCallbackStatus: 'failed',
      });
    }
    if (shouldIgnoreStaleFailedPreviewCallback(existingJob, body)) {
      await store.linkJobToSlackSession(existingJob);
      return jsonResponse({
        job: existingJob,
        ignored: true,
        ignoredStatus: existingJob.status,
        ignoredCallbackStatus: 'failed',
        ignoredReason: 'stale_preview_callback',
      });
    }
    const job = await store.failJob(jobId, body.errorCode || body.error_code, body.errorMessage || body.error_message, {
      workflowName: body.workflowName || body.workflow_name || undefined,
      workflowRunId: body.workflowRunId || body.workflow_run_id || undefined,
    });
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
  const callbackResult = await applyExecutorCallback(store, jobId, stageResult, rule.status, patch);
  let job = callbackResult.job;
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  await store.linkJobToSlackSession(job);
  let workerStart = null;
  if (!callbackResult.ignored) {
    try {
      workerStart = await startWorkerForJobIfConfigured(job, env);
    } catch (error) {
      workerStart = { started: false, error: error.message || 'Worker start failed' };
    }
  }
  if (!callbackResult.ignored && workerStart?.started === false) {
    job =
      (await store.failJob?.(job.id, 'worker_start_failed', workerStart.error || 'Worker start failed', {
        workflowName: job.workflowName,
        workflowRunId: job.workflowRunId,
      })) || job;
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
    return jsonResponse(
      {
        job,
        workerStart,
        ...(slackStatusNotification ? { slackStatusNotification } : {}),
        ...(slackNotification ? { slackNotification } : {}),
        ...(slackReactionSettlement ? { slackReactionSettlement } : {}),
      },
      502
    );
  }
  let queuedFollowupRerun = null;
  let reviewReplay = null;
  let slackStatusNotification = null;

  if (!callbackResult.ignored && previousJob?.status === 'fixing' && stageResult === 'reviewing') {
    queuedFollowupRerun = await dispatchQueuedFollowupFixIfNeeded(store, job, env);
    if (queuedFollowupRerun) {
      job = queuedFollowupRerun.job;
      workerStart = queuedFollowupRerun.workerStart;
      slackStatusNotification = queuedFollowupRerun.slackStatusNotification;
      await store.linkJobToSlackSession(job);
    }
  }

  if (!callbackResult.ignored && !queuedFollowupRerun) {
    reviewReplay = stageResult === 'pr_created' ? await dispatchPreviewFromStoredReviewIfReady(job, store, env) : null;
  }

  if (reviewReplay) {
    job = reviewReplay.job;
    workerStart = reviewReplay.workerStart;
    await store.linkJobToSlackSession(job);
  }

  if (!callbackResult.ignored && !slackStatusNotification) {
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
  const slackNotification = callbackResult.ignored || queuedFollowupRerun
    ? null
    : await notifySlackPlainProgress(env, store, job, slackText, `callback:${stageResult}`);
  const slackReactionSettlement =
    !callbackResult.ignored && (stageResult === 'preview_deployed' || job.status === 'preview_deployed')
      ? await settleJobSlackReactions(env, store, job, 'done')
      : null;

  return jsonResponse({
    job,
    ...(callbackResult.ignored ? { ignored: true, ignoredStageResult: stageResult } : {}),
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

const PLATFORM_CALLBACK_STATUS = {
  issue_created: 'issue_created',
  auto_dev_pending: 'auto_dev_pending',
  agent_queued: 'agent_queued',
  agent_running: 'agent_running',
  branch_committed: 'branch_committed',
  pr_created: 'pr_created',
  ci_running: 'ci_running',
  ci_failed: 'ci_failed',
  review_waiting: 'review_waiting',
  review_blocked: 'review_blocked',
  ready_to_merge: 'ready_to_merge',
  merged: 'merged',
  closed_unmerged: 'closed_unmerged',
};

function platformDevPatchFromCallback(body = {}) {
  return {
    githubIssueNumber: body.issueNumber || body.issue_number || body.githubIssueNumber || body.github_issue_number || undefined,
    githubIssueUrl: body.issueUrl || body.issue_url || body.githubIssueUrl || body.github_issue_url || undefined,
    githubPrNumber: body.prNumber || body.pr_number || body.githubPrNumber || body.github_pr_number || undefined,
    githubPrUrl: body.prUrl || body.pr_url || body.githubPrUrl || body.github_pr_url || undefined,
    branchName: body.branchName || body.branch_name || undefined,
    headSha: body.headSha || body.head_sha || undefined,
    workflowName: body.workflowName || body.workflow_name || undefined,
    workflowRunId: body.workflowRunId || body.workflow_run_id || undefined,
    errorCode: body.errorCode || body.error_code || undefined,
    errorMessage: body.errorMessage || body.error_message || undefined,
  };
}

function compactPatch(patch = {}) {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

async function handlePlatformDevExecutorCallback(body, env) {
  const store = getStore(env);
  const itemId = required(
    body.platformDevItemId || body.platform_dev_item_id || body.workItemId || body.work_item_id,
    'platformDevItemId'
  );

  if (body.status === 'failed') {
    const existingItem = await store.getPlatformDevItem(itemId);
    if (!existingItem) return jsonResponse({ error: 'PlatformDevItem not found' }, 404);
    if (TERMINAL_FAILED_CALLBACK_PLATFORM_STATUSES.has(existingItem.status)) {
      await store.linkPlatformDevItemToSlackSession(existingItem);
      return jsonResponse({
        item: existingItem,
        ignored: true,
        ignoredStatus: existingItem.status,
        ignoredCallbackStatus: 'failed',
      });
    }
    if (shouldIgnoreStaleFailedPlatformCallback(existingItem, body)) {
      await store.linkPlatformDevItemToSlackSession(existingItem);
      return jsonResponse({
        item: existingItem,
        ignored: true,
        ignoredStatus: existingItem.status,
        ignoredCallbackStatus: 'failed',
        ignoredReason: 'stale_platform_agent_callback',
      });
    }
    const item = await store.failPlatformDevItem(
      itemId,
      body.errorCode || body.error_code,
      body.errorMessage || body.error_message,
      {
        workflowName: body.workflowName || body.workflow_name || undefined,
        workflowRunId: body.workflowRunId || body.workflow_run_id || undefined,
        branchName: body.branchName || body.branch_name || undefined,
        headSha: body.headSha || body.head_sha || undefined,
      }
    );
    if (!item) return jsonResponse({ error: 'PlatformDevItem not found' }, 404);
    await store.linkPlatformDevItemToSlackSession(item);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, item, {
      stage: 'failed',
      text: item.errorMessage || item.errorCode || '平台需求处理失败',
      statusText: ':x: 平台需求处理失败',
      skipDuplicate: false,
    });
    return jsonResponse({
      item,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    });
  }

  const stageResult = required(body.stageResult || body.stage_result, 'stageResult');
  const status = PLATFORM_CALLBACK_STATUS[stageResult];
  if (!status) return jsonResponse({ error: 'Unsupported platform stageResult', stageResult }, 400);

  let item = await store.getPlatformDevItem(itemId);
  if (!item) return jsonResponse({ error: 'PlatformDevItem not found' }, 404);

  const patch = compactPatch(platformDevPatchFromCallback(body));
  if (item.status === status) {
    item = await store.patchPlatformDevItem(item.id, patch);
  } else {
    item = await store.updatePlatformDevItem(item.id, status, patch);
  }
  if (!item) return jsonResponse({ error: 'PlatformDevItem not found after update' }, 404);
  let workerStart = null;
  if (stageResult === 'auto_dev_pending' && item.autoDevStatus === 'triggered' && item.agentEligible) {
    item = await store.updatePlatformDevItem(item.id, 'agent_queued', {
      autoDevStatus: 'triggered',
      autoDevReason: item.autoDevReason || '用户手动触发自动开发。',
    });
    if (!item) return jsonResponse({ error: 'PlatformDevItem not found after auto-dev trigger dispatch' }, 404);
    try {
      workerStart = await startWorkerForPlatformDevItemIfConfigured(item, env);
    } catch (error) {
      workerStart = { started: false, error: error.message || 'Worker start failed' };
    }
    if (workerStart?.started === false) {
      item =
        (await store.failPlatformDevItem?.(item.id, 'worker_start_failed', workerStart.error || 'Worker start failed', {
          workflowName: item.workflowName || undefined,
          workflowRunId: item.workflowRunId || undefined,
        })) || item;
      await store.linkPlatformDevItemToSlackSession(item);
      const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, item, {
        stage: 'failed',
        text: item.errorMessage || item.errorCode || '平台需求处理失败',
        statusText: ':x: 平台需求处理失败',
        skipDuplicate: false,
      });
      return jsonResponse(
        {
          item,
          workerStart,
          ...(slackStatusNotification ? { slackStatusNotification } : {}),
        },
        502
      );
    }
  }
  await store.linkPlatformDevItemToSlackSession(item);
  const queuedFollowupRerun =
    ['pr_created', 'ci_failed', 'review_blocked', 'ready_to_merge'].includes(status)
      ? await dispatchQueuedPlatformDevFollowupIfNeeded(store, item, env)
      : null;
  if (queuedFollowupRerun?.item) item = queuedFollowupRerun.item;
  const notificationStage = stageResult === 'auto_dev_pending' && item.status !== stageResult ? item.status : stageResult;
  const slackStatusNotification = queuedFollowupRerun?.slackStatusNotification
    ? queuedFollowupRerun.slackStatusNotification
    : await notifySlackPlatformDevStatus(env, store, item, {
        stage: notificationStage,
        text: platformNotificationText(notificationStage, item) || `平台需求进入：${item.status}`,
        skipDuplicate: false,
      });

  return jsonResponse({
    item,
    ...(queuedFollowupRerun
      ? {
          queuedFollowupRerun: {
            skipped: queuedFollowupRerun.skipped || false,
            reason: queuedFollowupRerun.reason || null,
            workerStarted: queuedFollowupRerun.workerStart?.started ?? null,
          },
        }
      : {}),
    ...(workerStart ? { workerStart } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
  });
}
