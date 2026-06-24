import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { notificationTextForReviewAction, notifySlackJobStatus } from '../slack/notifier.js';
import { notifySlackPlainProgress } from '../slack/delivery.js';
import { classifyReviewAgentComment } from './review.js';

const REVIEW_RECONCILE_JOB_STATUSES = ['pr_created', 'reviewing'];
const REVIEW_FALLBACK_AGENT_LOGIN = 'pages-review-watchdog';
const DEFAULT_REVIEW_AGENT_TIMEOUT_SECONDS = 180;

export function shouldDispatchPreviewForReview(updatedJob, normalized, gate) {
  if (!updatedJob || updatedJob.previewUrl || !gate.canPreview) return false;
  if (!['review_summary', 'issue_comment'].includes(normalized.sourceType)) return false;
  if (!['note', 'suggestion'].includes(normalized.classification)) return false;
  return ['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(updatedJob.status);
}

export function shouldReportSiteCheckWaiting(updatedJob, normalized, gate) {
  if (!updatedJob || updatedJob.previewUrl || gate.canPreview) return false;
  if (gate.blockingCount > 0 || gate.unknownCount > 0) return false;
  if (gate.siteCheck?.passed) return false;
  if (!['review_summary', 'issue_comment'].includes(normalized.sourceType)) return false;
  if (!['note', 'suggestion'].includes(normalized.classification)) return false;
  return ['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(updatedJob.status);
}

export async function previewGateForPr(store, repoFullName, prNumber, options = {}) {
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
  if (!updatedJob) return null;
  const workerStart = await startWorkerForJobIfConfigured(updatedJob, env);

  return {
    reviewAction,
    job: updatedJob,
    workerStart,
    gate: trigger.gate,
    reviewComment: trigger.reviewComment,
  };
}

export async function dispatchPreviewFromStoredReviewIfReady(job, store, env) {
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

export async function reconcileReviewGateForJob(store, job, env, nowMs = Date.now()) {
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
  if (!result?.job) {
    return {
      jobId: job?.id || null,
      prNumber: job?.prNumber || null,
      headSha: job?.headSha || null,
      skipped: 'job_not_found_after_update',
      gate: fallback.trigger.gate,
      reviewComment: fallback.trigger.reviewComment,
      reviewCommentCreated: fallback.reviewCommentCreated,
    };
  }
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

export async function listReviewReconcileCandidateJobs(store, options = {}) {
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
