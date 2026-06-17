import { jsonResponse } from '@xd/worker-kit';

import { notifySlackPlainProgress } from '../slack/delivery.js';
import { notificationTextForReviewAction, notifySlackJobStatus } from '../slack/notifier.js';
import { dispatchPreviewFromStoredReviewIfReady, previewGateForPr } from './review-gate.js';

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

export async function handleGithubSiteCheckWebhook({ siteCheckRun, store, env, result }) {
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
