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
import {
  cancelJobForClosedGithubIssue,
  cancelJobForClosedGithubPr,
  reconcileClosedGithubIssueForJob,
  reopenGithubResourceForJob,
  restoreJobForReopenedGithubResource,
} from '../github/resource-reconciler.js';
import { readJson } from '../http/body.js';
import { getStore, required, verifyInternalCallbackToken } from './context.js';
import { applyExecutorCallback, CALLBACK_STAGE_RESULTS } from '../publishing/callback-rules.js';
import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { readSlackRequest, slackAckResponse, slackChallengeResponse } from '../slack/http.js';
import {
  classifySlackIntake,
  isUnsupportedBulkDestructiveRequest,
  parseSlackWorkItemReference,
  slackStatusReply,
} from '../slack/intake.js';
import {
  notificationTextForCallback,
  notificationTextForReviewAction,
  notifySlackJob,
  notifySlackJobStatus,
} from '../slack/notifier.js';
import {
  addWorkingReactionForSlackEvent,
  fetchSlackRequesterProfile,
  ignoredSlackEventReason,
  notifySlackPlainProgress,
  postSlackInteractionThreadReply,
  postSlackResultReply,
  runSlackBackground,
  settleImmediateSlackReaction,
  settleJobSlackReactions,
  shouldProcessSlackEventsAsync,
  slackDeliveryContextFromBody,
  slackDeliveryPatchForResult,
  slackEventId,
  slackReactionPayloadFromResult,
  updateSlackDeliveryReactionState,
  updateSlackInteractionMessage,
} from '../slack/delivery.js';
import {
  runSlackAgentTurnIfConfigured,
  slackAgentEndpointConfigured,
  updateSlackAgentReplyMessage,
} from '../slack/agent-turn.js';
import {
  completeSlackAgentRun,
  failRunningSlackAgentRunsForClosedSession,
  redactSlackAnalysis,
  slackAgentRunModelPatch,
} from '../slack/agent-run-records.js';
import { activateJobForSlackSession } from '../slack/job-binding.js';
import { selectSlackSession, slackActorFromBody, slackUserIdFromBody, surfaceForSlackBody } from '../slack/session.js';
import { redactSecretLikeText } from '../slack/text.js';
import { slackJobInput } from '../slack/job-input.js';
import {
  confirmedSlackJobBodyFromInteraction,
  draftAnalysisFromMemory,
  hasConfirmableDraft,
  slackIssueConfirmationBlocks,
  slackIssueConfirmationText,
  slackIssueConfirmedBlocks,
  slackIssueConfirmedText,
  slackIssueWaitingMoreBlocks,
  slackIssueWaitingMoreText,
} from '../slack/issue-confirmation.js';
import {
  CREATE_JOB_INTENTS,
  FOLLOWUP_INTENTS,
  LIST_WORK_ITEM_INTENTS,
  NON_FOLLOWUP_ACTIONS,
  SWITCH_WORK_ITEM_INTENTS,
  UNSUPPORTED_DESTRUCTIVE_INTENTS,
} from '../slack/intents.js';
import { listReconciledSlackWorkItemsForSession } from '../slack/work-item-reconciler.js';
import {
  normalizeSlackWorkItemQueryState,
  slackWorkItemIncludesInactive,
  slackWorkItemQueryStateFromText,
} from '../slack/work-item-query.js';
import {
  findVisibleSlackJobByReference,
  inactiveSlackWorkItemReply,
  isActionableSlackWorkItem,
  isReopenableSlackWorkItem,
  parseSlackButtonValue,
  reopenTargetForSlackWorkItem,
  slackJobVisibleToActor,
  slackWorkItemTargetLabel,
  slackWorkItemListBlocks,
  slackWorkItemListText,
  unsupportedDestructiveRequestReply,
} from '../slack/work-items.js';
import { activeJobForSlackSession, dispatchQueuedFollowupFixIfNeeded, handleSlackFollowup } from '../slack/followup.js';

const REVIEW_RECONCILE_JOB_STATUSES = ['pr_created', 'reviewing'];
const REVIEW_FALLBACK_AGENT_LOGIN = 'pages-review-watchdog';
const DEFAULT_REVIEW_AGENT_TIMEOUT_SECONDS = 180;

function isUnaddressedChannelThreadMessage(body = {}) {
  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  return event.type === 'message' && surface.channelType !== 'im' && Boolean(event.thread_ts);
}

async function existingSlackThreadSession(store, body = {}) {
  const actor = slackActorFromBody(body);
  const surface = surfaceForSlackBody(body);
  const sessionKey = `thread:${surface.channelId || 'unknown'}:${surface.threadTs || surface.messageTs || 'unknown'}`;
  const session = store.findSlackSessionByScope
    ? await store.findSlackSessionByScope(actor.teamId, actor.slackUserId, sessionKey)
    : null;
  return session?.status === 'closed' ? null : session;
}

function slackAgentToolArgs(slackAgentAnalysis = {}) {
  const analysis = slackAgentAnalysis || {};
  const toolCall = analysis.toolCall || analysis.tool_call || {};
  const args = toolCall.args || toolCall.arguments || analysis.toolArgs || analysis.tool_args || {};
  return args && typeof args === 'object' ? args : {};
}

function slackAgentToolName(slackAgentAnalysis = {}) {
  const analysis = slackAgentAnalysis || {};
  const toolCall = analysis.toolCall || analysis.tool_call || {};
  const rawName = toolCall.name || analysis.tool || analysis.toolName || analysis.tool_name || analysis.action;
  const name = String(rawName || '')
    .trim()
    .toLowerCase();
  const aliases = {
    list_work_items: 'list_my_work_items',
    list_tasks: 'list_my_work_items',
    search_work_items: 'list_my_work_items',
    switch_pr: 'switch_work_item',
    switch_to_work_item: 'switch_work_item',
    reopen: 'reopen_work_item',
    reopen_issue: 'reopen_work_item',
    reopen_pr: 'reopen_work_item',
    reopen_work_item: 'reopen_work_item',
    restore_work_item: 'reopen_work_item',
    status_query: 'get_current_status',
    get_status: 'get_current_status',
    close: 'close_session',
    reject_unsupported_destructive_request: 'unsupported_destructive_request',
    unsupported_destructive: 'unsupported_destructive_request',
    create_issue: 'confirm_create_issue',
    create_job: 'confirm_create_issue',
    confirm_issue: 'confirm_create_issue',
    confirm_before_issue: 'confirm_create_issue',
    create_or_update_site: 'confirm_create_issue',
    new_site_request: 'confirm_create_issue',
    create_site: 'confirm_create_issue',
    update_site: 'confirm_create_issue',
    update_current_work_item: 'record_followup',
    followup: 'record_followup',
    modify_existing_preview: 'record_followup',
  };
  return aliases[name] || name || null;
}

function slackAgentWorkItemState(intake = {}, slackAgentAnalysis = {}) {
  const analysis = slackAgentAnalysis || {};
  const args = slackAgentToolArgs(slackAgentAnalysis);
  const explicit =
    args.state ||
    args.workItemState ||
    args.work_item_state ||
    analysis.workItemState ||
    analysis.work_item_state ||
    intake.workItemState;
  if (explicit) return normalizeSlackWorkItemQueryState(explicit);

  return slackWorkItemQueryStateFromText(
    [intake.text, args.query, analysis.visibleReply, analysis.summary, analysis.title, analysis.clarifyingQuestion]
      .filter(Boolean)
      .join('\n')
  );
}

function slackAgentToolCallForTurn(intake, slackAgentAnalysis, slackSession) {
  if (!slackAgentAnalysis) return null;

  const explicitName = slackAgentToolName(slackAgentAnalysis);
  if (explicitName) {
    return {
      name: explicitName,
      args: slackAgentToolArgs(slackAgentAnalysis),
    };
  }

  if (shouldCloseSlackSession(intake, slackAgentAnalysis)) return { name: 'close_session', args: {} };
  if (slackAgentAnalysis.intent === 'status_query') return { name: 'get_current_status', args: {} };
  if (shouldRejectUnsupportedDestructiveSlackTurn(intake, slackAgentAnalysis)) {
    return { name: 'unsupported_destructive_request', args: {} };
  }
  if (LIST_WORK_ITEM_INTENTS.has(slackAgentAnalysis.intent)) {
    return { name: 'list_my_work_items', args: { state: slackAgentWorkItemState(intake, slackAgentAnalysis) } };
  }
  if (SWITCH_WORK_ITEM_INTENTS.has(slackAgentAnalysis.intent)) return { name: 'switch_work_item', args: {} };
  if (slackAgentAnalysis.intent === 'reopen_work_item') return { name: 'reopen_work_item', args: {} };
  if (slackAgentAnalysis.intent === 'cancel_request') return { name: 'cancel_request', args: {} };
  if (hasActiveSlackTarget(slackSession) && isSlackFollowupIntent(slackAgentAnalysis, intake, slackSession)) {
    return { name: 'record_followup', args: {} };
  }
  if (shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis, slackSession)) {
    return { name: 'confirm_create_issue', args: {} };
  }
  return null;
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

function slackWorkItemJobResponse(job = {}) {
  return {
    id: job.id,
    status: job.status,
    siteSlug: job.siteSlug,
    issueNumber: job.issueNumber,
    prNumber: job.prNumber,
    previewUrl: job.previewUrl,
  };
}

async function handleSlackListWorkItemsTool({
  store,
  body,
  env,
  intake,
  slackSession,
  agentRun,
  slackAgentAnalysis,
  toolArgs = {},
}) {
  const workItemState = normalizeSlackWorkItemQueryState(
    toolArgs.state || toolArgs.workItemState || toolArgs.work_item_state || slackAgentWorkItemState(intake, slackAgentAnalysis)
  );
  const includeInactive = slackWorkItemIncludesInactive(workItemState);
  const result = await listReconciledSlackWorkItemsForSession(store, body, env, {
    limit: 5,
    workItemState,
    includeInactive,
  });
  await completeSlackAgentRun(store, agentRun, {
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'list_my_work_items',
      accepted: false,
      intent: slackAgentAnalysis?.intent || intake.action,
      workItemState,
      total: result.total,
    },
  });
  return {
    ok: true,
    action: 'list_work_items',
    accepted: false,
    replyText: slackWorkItemListText(result.jobs || [], { workItemState, includeInactive }),
    blocks: slackWorkItemListBlocks(slackSession, result.jobs || [], { workItemState, includeInactive }),
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    workItemState,
    jobs: (result.jobs || []).map(slackWorkItemJobResponse),
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

function numberFromSlackToolArg(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function slackWorkItemReferenceFromTool(intake = {}, slackAgentAnalysis = {}, toolArgs = {}) {
  const queryText = [toolArgs.query, toolArgs.text, intake.text, slackAgentAnalysis?.summary].filter(Boolean).join('\n');
  const explicitKind = String(
    toolArgs.kind || toolArgs.type || toolArgs.targetKind || toolArgs.target_kind || intake.targetKind || ''
  )
    .trim()
    .toLowerCase();
  const explicitNumber =
    numberFromSlackToolArg(toolArgs.number || toolArgs.targetNumber || toolArgs.target_number || intake.targetNumber) ||
    numberFromSlackToolArg(toolArgs.issueNumber || toolArgs.issue_number || intake.issueNumber) ||
    numberFromSlackToolArg(
      toolArgs.prNumber || toolArgs.pr_number || toolArgs.pullRequestNumber || toolArgs.pull_request_number || intake.prNumber
    );

  if (explicitNumber) {
    const hasIssueNumber = Boolean(toolArgs.issueNumber || toolArgs.issue_number || intake.issueNumber);
    const hasPrNumber = Boolean(
      toolArgs.prNumber || toolArgs.pr_number || toolArgs.pullRequestNumber || toolArgs.pull_request_number || intake.prNumber
    );
    const kind =
      ['issue', 'issues', 'github_issue'].includes(explicitKind) || hasIssueNumber
        ? 'issue'
        : ['pr', 'pull_request', 'pull-request', 'pullrequest'].includes(explicitKind) || hasPrNumber
          ? 'pr'
          : 'unknown';
    return { kind, number: explicitNumber };
  }

  return parseSlackWorkItemReference(queryText);
}

async function handleSlackSwitchWorkItemTool({
  store,
  body,
  env,
  intake,
  slackSession,
  agentRun,
  slackAgentAnalysis,
  toolArgs = {},
}) {
  const reference = slackWorkItemReferenceFromTool(intake, slackAgentAnalysis, toolArgs);
  let job = reference ? await findVisibleSlackJobByReference(store, body, reference) : null;
  job = await reconcileClosedGithubIssueForJob(store, env, job, { notifySlack: true });
  const targetLabel =
    reference?.kind === 'issue'
      ? `Issue #${reference.number}`
      : reference?.kind === 'pr'
        ? `PR #${reference.number}`
        : reference?.number
          ? `#${reference.number}`
          : null;
  if (!job) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: {
        action: 'switch_work_item_not_found',
        accepted: false,
        intent: slackAgentAnalysis?.intent || null,
        reference,
      },
    });
    return {
      ok: true,
      action: 'switch_work_item_not_found',
      accepted: false,
      replyText: targetLabel
        ? `我没有找到你可继续操作的 ${targetLabel}。可以说「我的 PR」查看当前可选任务。`
        : '我还没识别出要继续哪个 Issue 或 PR。可以说「继续 PR #数字」或「继续 issue #数字」。',
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }
  if (!isActionableSlackWorkItem(job)) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: {
        action: 'switch_work_item_inactive',
        accepted: false,
        intent: slackAgentAnalysis?.intent || null,
        reference,
        jobId: job.id,
        status: job.status,
      },
    });
    return {
      ok: true,
      action: 'switch_work_item_inactive',
      accepted: false,
      replyText: inactiveSlackWorkItemReply(job),
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
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
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: { action: 'switch_work_item', accepted: true, intent: slackAgentAnalysis?.intent || intake.action, reference },
  });
  return {
    ok: true,
    action: 'switch_work_item',
    accepted: true,
    jobId: activeJob.id,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText: `已切换到 ${slackWorkItemTargetLabel(activeJob)}，继续在这里回复修改意见即可。`,
    noReply: Boolean(slackStatusNotification?.ok),
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
  };
}

async function handleSlackReopenWorkItemTool({
  store,
  body,
  env,
  intake,
  slackSession,
  agentRun,
  slackAgentAnalysis,
  toolArgs = {},
}) {
  const reference = slackWorkItemReferenceFromTool(intake, slackAgentAnalysis, toolArgs);
  let job = reference ? await findVisibleSlackJobByReference(store, body, reference) : null;
  job = await reconcileClosedGithubIssueForJob(store, env, job, { notifySlack: true });
  const targetLabel =
    reference?.kind === 'issue'
      ? `Issue #${reference.number}`
      : reference?.kind === 'pr'
        ? `PR #${reference.number}`
        : reference?.number
          ? `#${reference.number}`
          : '指定任务';

  const complete = async (report, extra = {}) =>
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: extra.jobId || null,
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: {
        action: 'reopen_work_item',
        intent: slackAgentAnalysis?.intent || intake.action,
        reference,
        ...report,
      },
    });

  if (!job) {
    await complete({ accepted: false, reason: 'not_found' });
    return {
      ok: true,
      action: 'reopen_work_item_not_found',
      accepted: false,
      replyText: `我没有找到你可以恢复的 ${targetLabel}。可以说「查看我已关闭的任务」确认可恢复项。`,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  const target = reopenTargetForSlackWorkItem(job);
  if (!isReopenableSlackWorkItem(job) || !target) {
    await complete({ accepted: false, reason: 'not_reopenable', status: job.status }, { jobId: job.id });
    return {
      ok: true,
      action: 'reopen_work_item_not_reopenable',
      accepted: false,
      jobId: job.id,
      replyText: inactiveSlackWorkItemReply(job),
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  let resource = null;
  try {
    resource = await reopenGithubResourceForJob(env, job, target);
  } catch (err) {
    await complete({ accepted: false, reason: 'github_reopen_failed', error: err.message }, { jobId: job.id });
    return {
      ok: true,
      action: 'reopen_work_item_failed',
      accepted: false,
      jobId: job.id,
      replyText: `重新打开失败：${err.message}`,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  job = await restoreJobForReopenedGithubResource(store, job, target, resource || {});
  await store.linkJobToSlackSession(job, slackSession);
  const workerStart = await startWorkerForJobIfConfigured(job, env);
  const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
    stage: job.status,
    text: target === 'pr' ? 'GitHub PR 已重新打开，发布任务已恢复。' : 'GitHub issue 已重新打开，发布任务已恢复。',
    statusText:
      target === 'pr'
        ? ':white_check_mark: GitHub PR 已重新打开，任务已恢复。'
        : ':white_check_mark: GitHub issue 已重新打开，任务已恢复。',
    skipDuplicate: false,
    dedupeKey: `slack-agent-reopen:${target}:${job.id}:${agentRun?.id || Date.now()}`,
    slackSessionId: slackSession.id,
  });
  await complete({ accepted: true, target }, { jobId: job.id });

  return {
    ok: true,
    action: 'reopen_work_item',
    accepted: true,
    jobId: job.id,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText:
      target === 'pr'
        ? '已重新打开 PR，继续在这个对话里回复修改意见即可。'
        : '已重新打开 Issue，继续在这个对话里回复修改意见即可。',
    noReply: Boolean(slackStatusNotification?.ok),
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    ...(workerStart ? { workerStart } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
  };
}

async function handleSlackAgentToolCall(context) {
  const { intake, slackAgentAnalysis, slackSession } = context;
  const toolCall = context.toolCall || slackAgentToolCallForTurn(intake, slackAgentAnalysis, slackSession);
  if (!toolCall?.name) return null;
  if (
    slackAgentAnalysis?.needsClarification &&
    ['confirm_create_issue', 'record_followup', 'switch_work_item', 'reopen_work_item'].includes(toolCall.name)
  ) {
    return null;
  }

  switch (toolCall.name) {
    case 'close_session':
      return handleCloseSlackSession(context);
    case 'get_current_status':
      return handleSlackAgentStatusQuery(context);
    case 'unsupported_destructive_request':
      return handleSlackAgentNonPublishingTurn({
        ...context,
        action: 'unsupported_destructive_request',
        replyText: unsupportedDestructiveRequestReply(),
        preferReplyText: true,
      });
    case 'list_my_work_items':
      return handleSlackListWorkItemsTool({ ...context, toolArgs: toolCall.args || {} });
    case 'switch_work_item':
      return handleSlackSwitchWorkItemTool({ ...context, toolArgs: toolCall.args || {} });
    case 'reopen_work_item':
      return handleSlackReopenWorkItemTool({ ...context, toolArgs: toolCall.args || {} });
    case 'cancel_request':
      return handleSlackAgentNonPublishingTurn({
        ...context,
        action: 'cancel_request',
        replyText: '收到取消意图。当前还没有自动取消发布任务；如果已经创建了 issue，可以先在 issue 里补充“取消”。',
      });
    case 'record_followup':
      return handleSlackFollowup(context);
    case 'confirm_create_issue':
      return handleSlackAgentNonPublishingTurn({
        ...context,
        action: 'confirm_before_issue',
        replyText: slackIssueConfirmationText(slackAgentAnalysis),
        blocks: slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis),
        preferReplyText: true,
      });
    default:
      return null;
  }
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

  const useSlackAgentForToolLikeTurn = slackAgentEndpointConfigured(env) && intake.shouldAnalyze !== false;

  if (intake.action === 'list_work_items' && !useSlackAgentForToolLikeTurn) {
    return respond(
      await handleSlackListWorkItemsTool({
        store,
        body,
        env,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis: null,
        toolArgs: { state: intake.workItemState },
      })
    );
  }

  if (intake.action === 'switch_work_item' && !useSlackAgentForToolLikeTurn) {
    return respond(
      await handleSlackSwitchWorkItemTool({
        store,
        body,
        env,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis: null,
      })
    );
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

      const toolResult = await handleSlackAgentToolCall({
        store,
        body,
        env,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis,
      });
      if (toolResult) return respond(toolResult);

      if (!slackAgentAnalysis && hasActiveSlackTarget(slackSession) && isSlackFollowupIntent(null, intake, slackSession)) {
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
          text: 'Slack 发布需求已进入处理队列。',
          statusText: ':hourglass_flowing_sand: 正在整理发布任务...',
        })
      : null;
    const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: job.id,
      ...slackAgentRunModelPatch(slackAgentAnalysis),
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
    ...slackAgentRunModelPatch(slackAgentAnalysis),
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
    ...slackAgentRunModelPatch(slackAgentAnalysis),
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

export async function handleSlackEvents(request, env) {
  const { body } = await readSlackRequest(request, env);

  if (body.type === 'url_verification' && body.challenge) {
    return slackChallengeResponse(body);
  }

  const store = getStore(env);
  const process = async () => {
    const workingReaction = await addWorkingReactionForSlackEvent(env, body);
    try {
      const result = await processSlackEventBody(body, env, { workingReaction });
      await postSlackResultReply(env, body, result);
      const settledReaction = await settleImmediateSlackReaction(env, workingReaction, result);
      if (settledReaction) {
        await updateSlackDeliveryReactionState(store, body, workingReaction, {
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
        await updateSlackDeliveryReactionState(store, body, workingReaction, {
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
      text: `已切换到 ${slackWorkItemTargetLabel(activeJob)}，继续在这个对话里回复修改意见即可。`,
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
      statusText:
        target === 'pr'
          ? ':white_check_mark: GitHub PR 已重新打开，任务已恢复。'
          : ':white_check_mark: GitHub issue 已重新打开，任务已恢复。',
      skipDuplicate: false,
      dedupeKey: `slack-reopen:${target}:${job.id}:${body.trigger_id || Date.now()}`,
      slackSessionId: session.id,
    });
    const refreshed = await listReconciledSlackWorkItemsForSession(store, body, env, {
      limit: 5,
      includeInactive: Boolean(value.includeInactive),
      workItemState: value.workItemState,
    });
    const listUpdate = await updateSlackInteractionMessage(env, body, session, {
      text: slackWorkItemListText(refreshed.jobs || [], {
        includeInactive: Boolean(value.includeInactive),
        workItemState: value.workItemState,
      }),
      blocks: slackWorkItemListBlocks(session, refreshed.jobs || [], {
        includeInactive: Boolean(value.includeInactive),
        workItemState: value.workItemState,
      }),
    });

    return slackAckResponse({
      response_type: 'ephemeral',
      text:
        target === 'pr'
          ? '已重新打开 PR，继续在这个对话里回复修改意见即可。'
          : '已重新打开 Issue，继续在这个对话里回复修改意见即可。',
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
