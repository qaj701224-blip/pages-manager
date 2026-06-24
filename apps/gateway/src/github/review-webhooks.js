import { jsonResponse } from '@xd/worker-kit';

import { dispatchPlatformDevFixIfNeeded, dispatchQueuedPlatformDevFollowupIfNeeded } from '../platform-dev/automation.js';
import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { notifySlackPlainProgress } from '../slack/delivery.js';
import { notificationTextForReviewAction, notifySlackJobStatus } from '../slack/notifier.js';
import { notifySlackPlatformDevStatus, platformNotificationText } from '../slack/platform-notifier.js';
import { previewGateForPr, shouldDispatchPreviewForReview, shouldReportSiteCheckWaiting } from './review-gate.js';

function shouldIgnoreStalePlatformReview(platformItem = {}, nextStatus = '') {
  return ['agent_queued', 'agent_running', 'branch_committed'].includes(platformItem.status) && nextStatus !== 'ready_to_merge';
}

function compactText(value = '', maxLength = 1200) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function reviewCommentLine(comment = {}) {
  const location = [comment.path, comment.line ? `L${comment.line}` : ''].filter(Boolean).join(':');
  const classification = comment.classification || 'unknown';
  return [`[${classification}]`, location || 'PR', compactText(comment.bodyRedacted || comment.body || '', 900)]
    .filter(Boolean)
    .join(' ');
}

async function platformReviewContextForItem(store, platformItem = {}, normalized = {}) {
  const prNumber = normalized.prNumber || platformItem.githubPrNumber;
  if (!prNumber || !store?.listReviewAgentCommentsForPrNumber) return '';
  const comments = await store.listReviewAgentCommentsForPrNumber(prNumber, {
    repoFullName: normalized.repoFullName,
    headSha: normalized.headSha || platformItem.headSha,
  });
  const open = comments.filter((comment) => comment.status === 'open').slice(0, 12);
  if (!open.length) return '';
  return [
    `Review context for PR #${prNumber}:`,
    ...open.map((comment, index) => `${index + 1}. ${reviewCommentLine(comment)}`),
  ].join('\n');
}

async function platformMemoryContextForItem(store, platformItem = {}, reviewContext = '') {
  if (!platformItem.slackSessionId || !store?.getSessionMemory) return '';
  const memory = await store.getSessionMemory(platformItem.slackSessionId);
  const platformReview = memory.requirements?.platformReview || {};
  return [
    memory.summary ? `Session summary: ${compactText(memory.summary, 1000)}` : '',
    platformReview.lastSummary ? `Last review summary: ${compactText(platformReview.lastSummary, 1400)}` : '',
    reviewContext ? `Latest review comments:\n${reviewContext}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function rememberPlatformReview(store, platformItem = {}, normalized = {}, reviewContext = '') {
  if (!platformItem.slackSessionId || !store?.getSessionMemory || !store?.updateSessionMemory) return null;
  const memory = await store.getSessionMemory(platformItem.slackSessionId);
  const requirements = memory.requirements && typeof memory.requirements === 'object' ? memory.requirements : {};
  const platformReview =
    requirements.platformReview && typeof requirements.platformReview === 'object' ? requirements.platformReview : {};
  const updatedPlatformReview = {
    ...platformReview,
    prNumber: normalized.prNumber || platformItem.githubPrNumber || platformReview.prNumber || null,
    headSha: normalized.headSha || platformItem.headSha || platformReview.headSha || null,
    lastClassification: normalized.classification || platformReview.lastClassification || null,
    lastSummary: compactText(reviewContext || reviewCommentLine(normalized), 2000),
    updatedAt: new Date().toISOString(),
  };
  return await store.updateSessionMemory(platformItem.slackSessionId, {
    requirements: {
      ...requirements,
      platformReview: updatedPlatformReview,
    },
  });
}

function platformStatusContext(platformItem = {}, nextStatus = '') {
  const currentStatus = platformItem.status;
  return [
    `PlatformDevItem ${platformItem.id}`,
    `status: ${currentStatus}${nextStatus && nextStatus !== currentStatus ? ` -> ${nextStatus}` : ''}`,
    platformItem.githubIssueNumber ? `issue: #${platformItem.githubIssueNumber}` : '',
    platformItem.githubPrNumber ? `pr: #${platformItem.githubPrNumber}` : '',
    platformItem.branchName ? `branch: ${platformItem.branchName}` : '',
    platformItem.headSha ? `headSha: ${platformItem.headSha}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function handleGithubReviewAgentWebhook({ normalized, repoFullName, store, env, result }) {
  const reviewComment = await store.recordReviewAgentComment(normalized);
  const commentIsOpen = reviewComment.comment?.status === 'open';
  let platformItem = store.findPlatformDevItemByPrNumber
    ? await store.findPlatformDevItemByPrNumber(normalized.prNumber, { headSha: normalized.headSha })
    : null;
  if (platformItem) {
    const fullHeadSha = normalized.headSha && normalized.headSha.length === 40 ? normalized.headSha : null;
    const patch = fullHeadSha ? { headSha: fullHeadSha } : {};
    const nextStatus =
      commentIsOpen && (normalized.classification === 'blocking' || normalized.classification === 'unknown')
        ? 'review_blocked'
        : platformItem.status === 'pr_created' || platformItem.status === 'ci_running'
          ? 'review_waiting'
          : platformItem.status;
    const statusContext = platformStatusContext(platformItem, nextStatus);
    if (shouldIgnoreStalePlatformReview(platformItem, nextStatus)) {
      const patched = fullHeadSha ? await store.patchPlatformDevItem(platformItem.id, patch) : platformItem;
      if (!patched) {
        return jsonResponse({
          ok: true,
          created: true,
          delivery: result.delivery,
          reviewAction: 'platform_item_not_found_after_update',
          reviewComment: reviewComment.comment,
          reviewCommentCreated: reviewComment.created,
        });
      }
      return jsonResponse({
        ok: true,
        created: true,
        delivery: result.delivery,
        reviewAction: 'platform_review_stale_ignored',
        reviewComment: reviewComment.comment,
        reviewCommentCreated: reviewComment.created,
        item: patched,
      });
    }
    platformItem =
      platformItem.status === nextStatus
        ? await store.patchPlatformDevItem(platformItem.id, patch)
        : await store.updatePlatformDevItem(platformItem.id, nextStatus, patch);
    if (!platformItem) {
      return jsonResponse({
        ok: true,
        created: true,
        delivery: result.delivery,
        reviewAction: 'platform_item_not_found_after_update',
        reviewComment: reviewComment.comment,
        reviewCommentCreated: reviewComment.created,
      });
    }
    await store.linkPlatformDevItemToSlackSession(platformItem);
    const reviewContext = await platformReviewContextForItem(store, platformItem, { ...normalized, repoFullName });
    const memory = await rememberPlatformReview(store, platformItem, normalized, reviewContext);
    const memoryContext = await platformMemoryContextForItem(store, platformItem, reviewContext);
    const contextPatch = {
      reviewContext,
      memoryContext,
      statusContext,
      reviewSummary: memory?.requirements?.platformReview?.lastSummary || reviewContext || null,
    };
    platformItem = await store.patchPlatformDevItem(platformItem.id, contextPatch);
    if (!platformItem) {
      return jsonResponse({
        ok: true,
        created: true,
        delivery: result.delivery,
        reviewAction: 'platform_item_not_found_after_context_update',
        reviewComment: reviewComment.comment,
        reviewCommentCreated: reviewComment.created,
      });
    }
    const autoFix =
      commentIsOpen && nextStatus === 'review_blocked'
        ? await dispatchPlatformDevFixIfNeeded(store, platformItem, env, {
            trigger: 'review_blocked',
            reviewSummary: contextPatch.reviewSummary,
            memorySummary: memory?.summary || null,
          })
        : await dispatchQueuedPlatformDevFollowupIfNeeded(store, platformItem, env);
    if (autoFix?.item) platformItem = autoFix.item;
    const slackStatusNotification = autoFix?.slackStatusNotification
      ? autoFix.slackStatusNotification
      : await notifySlackPlatformDevStatus(env, store, platformItem, {
          stage: nextStatus,
          text: platformNotificationText(nextStatus, platformItem) || 'Review 状态已更新。',
          reviewSummary: contextPatch.reviewSummary,
          memorySummary: memory?.summary || null,
          skipDuplicate: false,
        });
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      reviewAction: autoFix?.workerStart?.started ? 'platform_review_fix_dispatched' : 'platform_review_recorded',
      reviewComment: reviewComment.comment,
      reviewCommentCreated: reviewComment.created,
      item: platformItem,
      ...(autoFix
        ? {
            autoFix: {
              skipped: autoFix.skipped || false,
              reason: autoFix.reason || null,
              workerStarted: autoFix.workerStart?.started ?? null,
            },
          }
        : {}),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    });
  }

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
