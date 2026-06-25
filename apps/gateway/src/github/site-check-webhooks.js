import { jsonResponse } from '@xd/worker-kit';

import { dispatchPlatformDevFixIfNeeded, dispatchQueuedPlatformDevFollowupIfNeeded } from '../platform-dev/automation.js';
import { notifySlackPlainProgress } from '../slack/delivery.js';
import { notificationTextForReviewAction, notifySlackJobStatus } from '../slack/notifier.js';
import { notifySlackPlatformDevStatus, platformNotificationText } from '../slack/platform-notifier.js';
import { dispatchPreviewFromStoredReviewIfReady, previewGateForPr } from './review-gate.js';

const TERMINAL_PLATFORM_STATUSES = new Set(['merged', 'closed_unmerged', 'failed', 'cancelled']);

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

async function moveJobToChangesRequestedForSiteCheck(store, job, patch = {}) {
  if (!job) return null;
  if (job.status === 'changes_requested') {
    return await store.patchJob(job.id, patch);
  }

  let current = job;
  if (current.status === 'pr_created') {
    current = await store.updateJob(current.id, 'reviewing', patch);
    if (!current) return null;
  }
  if (current.status === 'reviewing') {
    return await store.updateJob(current.id, 'changes_requested', patch);
  }
  return current;
}

function platformCheckStatusForRun(platformItem = {}, siteCheckRun = {}) {
  if (siteCheckRun.status === 'completed' && siteCheckRun.conclusion === 'success') {
    if (platformItem.status === 'review_blocked') return 'review_blocked';
    return platformItem.status === 'review_waiting' ? 'ready_to_merge' : 'review_waiting';
  }
  if (siteCheckRun.status === 'completed' && siteCheckRun.conclusion && siteCheckRun.conclusion !== 'success') {
    return 'ci_failed';
  }
  return 'ci_running';
}

function shouldIgnoreStalePlatformCheck(platformItem = {}, nextStatus = '') {
  if (TERMINAL_PLATFORM_STATUSES.has(platformItem.status)) return true;
  if (platformItem.status === 'ready_to_merge' && nextStatus === 'ci_failed') return true;
  return ['agent_queued', 'agent_running', 'branch_committed'].includes(platformItem.status) && nextStatus !== 'ready_to_merge';
}

export async function handleGithubSiteCheckWebhook({ siteCheckRun, store, env, result }) {
  const fullHeadSha = siteCheckRun.headSha && siteCheckRun.headSha.length === 40 ? siteCheckRun.headSha : null;
  let platformItem = store.findPlatformDevItemByPrNumber
    ? await store.findPlatformDevItemByPrNumber(siteCheckRun.prNumber, fullHeadSha ? { headSha: fullHeadSha } : {})
    : null;
  if (!platformItem && siteCheckRun.platformCiOnly) {
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      ignored: 'platform_ci_without_platform_item',
    });
  }

  const storedRun = await store.recordSiteCheckRun(siteCheckRun);
  if (platformItem) {
    const patch = fullHeadSha ? { headSha: fullHeadSha } : {};
    const nextStatus = platformCheckStatusForRun(platformItem, siteCheckRun);
    if (fullHeadSha && platformItem.headSha && !shaMatches(platformItem.headSha, fullHeadSha)) {
      return jsonResponse({
        ok: true,
        created: true,
        delivery: result.delivery,
        reviewAction: 'platform_ci_stale_ignored',
        siteCheckRun: storedRun.run,
        siteCheckRunCreated: storedRun.created,
        item: platformItem,
      });
    }
    if (shouldIgnoreStalePlatformCheck(platformItem, nextStatus)) {
      const patched = fullHeadSha ? await store.patchPlatformDevItem(platformItem.id, patch) : platformItem;
      if (!patched) {
        return jsonResponse({
          ok: true,
          created: true,
          delivery: result.delivery,
          reviewAction: 'platform_item_not_found_after_update',
          siteCheckRun: storedRun.run,
          siteCheckRunCreated: storedRun.created,
        });
      }
      return jsonResponse({
        ok: true,
        created: true,
        delivery: result.delivery,
        reviewAction: 'platform_ci_stale_ignored',
        siteCheckRun: storedRun.run,
        siteCheckRunCreated: storedRun.created,
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
        siteCheckRun: storedRun.run,
        siteCheckRunCreated: storedRun.created,
      });
    }
    await store.linkPlatformDevItemToSlackSession(platformItem);
    const autoFix =
      nextStatus === 'ci_failed'
        ? await dispatchPlatformDevFixIfNeeded(store, platformItem, env, { trigger: 'ci_failed' })
        : await dispatchQueuedPlatformDevFollowupIfNeeded(store, platformItem, env);
    if (autoFix?.item) platformItem = autoFix.item;
    const slackStatusNotification = autoFix?.slackStatusNotification
      ? autoFix.slackStatusNotification
      : await notifySlackPlatformDevStatus(env, store, platformItem, {
          stage: nextStatus,
          text: platformNotificationText(nextStatus, platformItem) || 'CI 状态已更新。',
          skipDuplicate: false,
        });
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      reviewAction: autoFix?.workerStart?.started ? 'platform_ci_fix_dispatched' : 'platform_ci_recorded',
      siteCheckRun: storedRun.run,
      siteCheckRunCreated: storedRun.created,
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
