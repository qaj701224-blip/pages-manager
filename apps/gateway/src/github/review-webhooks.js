import { jsonResponse } from '@xd/worker-kit';

import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { notifySlackPlainProgress } from '../slack/delivery.js';
import { notificationTextForReviewAction, notifySlackJobStatus } from '../slack/notifier.js';
import { previewGateForPr, shouldDispatchPreviewForReview, shouldReportSiteCheckWaiting } from './review-gate.js';

export async function handleGithubReviewAgentWebhook({ normalized, repoFullName, store, env, result }) {
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
