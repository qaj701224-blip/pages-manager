import { appendPlatformDevFollowupIssueComment } from '@xd/git-client';

import { deleteRedisKeyIfValueMatches } from '../db/redis.js';
import { reconcileClosedGithubIssueForJob } from '../github/resource-reconciler.js';
import {
  dispatchPlatformDevFixIfNeeded,
  platformWorkerStartErrorText,
  PLATFORM_SLACK_FOLLOWUP_QUEUED_EVENT,
} from '../platform-dev/automation.js';
import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { notifySlackJobStatus } from './notifier.js';
import { notifySlackPlatformDevStatus } from './platform-notifier.js';
import { completeSlackAgentRun, redactSlackAnalysis, slackAgentRunModelPatch } from './agent-run-records.js';
import { appendAssistantConversationTurn, buildConversationContext } from './conversation-context.js';
import { slackThreadForSession } from './job-binding.js';
import { compactUserFacingText, redactSecretLikeText } from './text.js';
import { inactiveSlackWorkItemReply, isActionableSlackWorkItem } from './work-items.js';

const AGENT_EVENT_CODING_FIX_DISPATCHED = 'coding_fix_dispatched';
const AGENT_EVENT_SLACK_FOLLOWUP_QUEUED = 'slack_followup_queued';
const UNRECOVERABLE_PLATFORM_DEV_STATUSES = new Set(['merged', 'closed_unmerged', 'cancelled']);

function platformDevSlackWorkItem(item = null) {
  if (!item) return null;
  return {
    ...item,
    workItemKind: 'platform_dev',
    issueNumber: item.githubIssueNumber,
    issueUrl: item.githubIssueUrl,
    prNumber: item.githubPrNumber,
    prUrl: item.githubPrUrl,
  };
}

function isRecoverablePlatformDevSlackItem(item = {}) {
  if (!item?.id) return false;
  return !UNRECOVERABLE_PLATFORM_DEV_STATUSES.has(item.status);
}

export async function activeJobForSlackSession(store, slackSession) {
  if (slackSession?.activeJobId) {
    const job = await store.getJob(slackSession.activeJobId);
    if (job) return job;
  }
  if (slackSession?.activeWorkItemKind === 'site_publishing' && slackSession.activeWorkItemId) {
    const job = await store.getJob(slackSession.activeWorkItemId);
    if (job) return job;
  }

  const links = await store.findIssueLinksForSlackSession(slackSession.id);
  const link = links[0];
  return link?.publishingJobId ? await store.getJob(link.publishingJobId) : null;
}

export async function activeWorkItemForSlackSession(store, slackSession) {
  if (slackSession?.activeWorkItemKind === 'platform_dev' && slackSession.activeWorkItemId && store.getPlatformDevItem) {
    const item = await store.getPlatformDevItem(slackSession.activeWorkItemId);
    if (item) {
      return platformDevSlackWorkItem(item);
    }
  }

  if (slackSession?.id && store.listWorkItemLinksForSlackSession && store.getPlatformDevItem) {
    const links = await store.listWorkItemLinksForSlackSession(slackSession.id);
    for (const link of links) {
      if (link?.workItemKind !== 'platform_dev') continue;
      const itemId = link.platformDevItemId || link.workItemId;
      const item = itemId ? await store.getPlatformDevItem(itemId) : null;
      if (isRecoverablePlatformDevSlackItem(item)) return platformDevSlackWorkItem(item);
    }
  }

  return activeJobForSlackSession(store, slackSession);
}

function followupSummary(existingSummary, text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return existingSummary || '';
  const previous = String(existingSummary || '').trim();
  const block = ['## Slack Follow-up', '', cleanText].join('\n');
  return previous ? `${previous}\n\n${block}` : block;
}

export function followupRoundFromSummary(summary = '') {
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
    await deleteRedisKeyIfValueMatches(store.redis, claim.key, claim.value);
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
  return events.filter((event) => event.type === type).sort((left, right) => agentEventTime(right) - agentEventTime(left))[0];
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

export async function dispatchQueuedFollowupFixIfNeeded(store, reviewedJob, env) {
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

export function finalRequirementCardSummary(summary = '') {
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

function canDispatchFixForJob(job) {
  return ['pr_created', 'reviewing', 'changes_requested', 'fixing', 'preview_deployed'].includes(job.status);
}

function shouldQueueFixForJob(job) {
  return ['generating_page', 'patch_generated', 'branch_committed', 'previewing'].includes(job.status);
}

function canDispatchFixForPlatformDevItem(item = {}) {
  if (!item.agentEligible) return false;
  if (item.requiresHumanGate && item.gateStatus !== 'approved') return false;
  return ['issue_created', 'pr_created', 'ci_failed', 'review_blocked', 'ready_to_merge', 'agent_queued', 'failed'].includes(
    item.status
  );
}

function shouldQueueFixForPlatformDevItem(item = {}) {
  return ['agent_queued', 'agent_running', 'branch_committed', 'ci_running', 'review_waiting'].includes(item.status);
}

function platformFollowupCardSummary(feedback = '') {
  const text = compactUserFacingText(feedback);
  return text ? `本轮补充：${text}` : '本轮补充已记录。';
}

function githubWriteConfigForFollowup(env = {}) {
  const token = env.GITHUB_APP_INSTALLATION_TOKEN || env.GITHUB_TOKEN;
  const repoFullName = env.GITHUB_REPO || env.GITHUB_REPOSITORY;
  if (!token || !repoFullName) return null;
  return {
    apiBaseUrl: env.GITHUB_ENTERPRISE_API_BASE_URL || env.GITHUB_API_BASE_URL || 'https://api.github.com',
    token,
    repoFullName,
  };
}

async function appendPlatformFollowupIssueCommentIfPossible(env, item, feedback) {
  if (!item?.githubIssueNumber) return { skipped: true, reason: 'missing_issue' };
  const config = githubWriteConfigForFollowup(env);
  if (!config) return { skipped: true, reason: 'github_not_configured' };

  try {
    const comment = await appendPlatformDevFollowupIssueComment(
      env.GITHUB_FETCH || env.GITHUB_STATUS_FETCH || fetch,
      config,
      item,
      {
        feedback,
        issueNumber: item.githubIssueNumber,
        mode: 'followup',
        gateApproved: item.gateStatus === 'approved' || item.requiresHumanGate === false,
      }
    );
    return { ok: true, comment };
  } catch (err) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'platform_followup_issue_comment_failed',
        itemId: item.id,
        issueNumber: item.githubIssueNumber,
        error: err.message,
      })
    );
    return { ok: false, error: err.message };
  }
}

function issueSyncStatusText(issueSync, item) {
  if (issueSync?.ok) return `已追加到 GitHub issue #${item.githubIssueNumber}。`;
  if (issueSync?.skipped && issueSync.reason === 'missing_issue') return '已记录补充，等待 GitHub issue 创建完成后继续处理。';
  if (issueSync?.skipped && issueSync.reason === 'github_not_configured') return '已记录补充，但 GitHub 写入暂未配置。';
  if (issueSync?.ok === false) return `已记录补充，但写入 GitHub issue 失败：${issueSync.error}`;
  return '已记录补充。';
}

function platformFollowupReplyText(issueSync, fixDispatch) {
  const startError =
    fixDispatch?.workerStart?.started === false ? platformWorkerStartErrorText(fixDispatch.workerStart.error) : '';
  if (issueSync?.ok && fixDispatch?.workerStart?.started) return '收到，已追加到 Issue，并启动新一轮修改。';
  if (issueSync?.ok && startError) return `收到，已追加到 Issue。${startError}`;
  if (issueSync?.ok) return '收到，已追加到 Issue。';
  if (startError) return `收到，补充已记录。${startError}`;
  return '收到，补充已记录。';
}

async function updateFollowupSessionMemory({
  store,
  slackSession,
  sessionMemory,
  intake,
  patch,
  replyText,
  conversationKind,
}) {
  if (!slackSession?.id || !store?.updateSessionMemory) return null;
  const baseContext = buildConversationContext({ slackSession, sessionMemory, intake });
  return store.updateSessionMemory(slackSession.id, {
    ...patch,
    conversationContext: appendAssistantConversationTurn(baseContext, replyText || patch.lastAgentResponse || '', {
      kind: conversationKind || 'followup',
    }),
  });
}

async function handleSlackPlatformDevFollowup({
  store,
  env,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  item,
  feedback,
  redactedSlackAgentAnalysis,
}) {
  if (!isActionableSlackWorkItem(item)) {
    const replyText = inactiveSlackWorkItemReply(item);
    await updateFollowupSessionMemory({
      store,
      slackSession,
      sessionMemory,
      intake,
      patch: {
        summary: redactSecretLikeText(sessionMemory.summary) || redactSecretLikeText(intake.text),
        requirements: redactSlackAnalysis(sessionMemory.requirements) || {},
        lastAgentResponse: replyText,
      },
      replyText,
      conversationKind: 'inactive_platform_followup',
    });
    await completeSlackAgentRun(store, agentRun, {
      workItemKind: 'platform_dev',
      workItemId: item.id,
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: {
        action: 'followup_inactive_platform_item',
        accepted: false,
        intent: slackAgentAnalysis?.intent || null,
        status: item.status,
      },
    });
    return {
      ok: true,
      action: 'followup_inactive_platform_item',
      accepted: false,
      workItemKind: 'platform_dev',
      workItemId: item.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      replyText,
      ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
    };
  }

  const patch = {
    title: redactedSlackAgentAnalysis?.title || item.title,
    summary: followupSummary(item.summary, feedback),
    slackSessionId: slackSession.id,
    slackSessionKey: slackSession.sessionKey,
    slackThread: slackThreadForSession(slackSession, item.slackThread || {}),
  };
  const memoryPatch = {
    summary: followupSummary(sessionMemory.summary, feedback),
    requirements: redactedSlackAgentAnalysis || { text: redactSecretLikeText(intake.text), action: 'followup' },
    lastPreviewFeedback: feedback,
  };

  let updatedItem = await store.patchPlatformDevItem(item.id, patch);
  await store.linkPlatformDevItemToSlackSession(updatedItem, slackSession);
  const issueSync = await appendPlatformFollowupIssueCommentIfPossible(env, updatedItem, feedback);
  let action = 'platform_followup_recorded';
  let replyText = '收到，已记录这轮补充。';
  let fixDispatch = null;
  let slackStatusNotification = null;

  if (shouldQueueFixForPlatformDevItem(item)) {
    if (store?.recordAgentRunEvent) {
      await store.recordAgentRunEvent({
        workItemKind: 'platform_dev',
        workItemId: updatedItem.id,
        slackSessionId: slackSession.id,
        agentRunId: agentRun?.id || null,
        type: PLATFORM_SLACK_FOLLOWUP_QUEUED_EVENT,
        stage: item.status,
        status: 'queued',
        text: feedback,
        dedupeKey: `platform-slack-followup-queued:${updatedItem.id}:${agentRun?.id || Date.now()}`,
        slackChannelId: updatedItem.slackThread?.channelId || null,
        slackThreadTs: updatedItem.slackThread?.threadTs || null,
      });
    }
    slackStatusNotification = await notifySlackPlatformDevStatus(env, store, updatedItem, {
      stage: item.status,
      text: `${issueSyncStatusText(issueSync, updatedItem)}当前处理结束后会继续修改。`,
      statusText: issueSync?.ok
        ? ':hourglass_flowing_sand: 已追加到 Issue，等待当前处理结束。'
        : ':hourglass_flowing_sand: 已记录补充，等待当前处理结束。',
      finalSummary: finalRequirementCardSummary(updatedItem.summary),
      currentChange: platformFollowupCardSummary(feedback),
      skipDuplicate: false,
      slackSessionId: slackSession.id,
      dedupeKey: `platform-followup-queued:${updatedItem.id}:${agentRun?.id || Date.now()}`,
    });
    action = 'platform_followup_queued';
    replyText = issueSync?.ok ? '收到，已追加到 Issue；当前处理结束后会继续修改。' : '收到，已记录；当前处理结束后会继续修改。';
  } else if (canDispatchFixForPlatformDevItem(updatedItem)) {
    fixDispatch = await dispatchPlatformDevFixIfNeeded(store, updatedItem, env, {
      trigger: 'slack_followup',
      force: true,
      currentChange: platformFollowupCardSummary(feedback),
      issueSyncText: issueSyncStatusText(issueSync, updatedItem),
    });
    updatedItem = fixDispatch?.item || updatedItem;
    slackStatusNotification = fixDispatch?.slackStatusNotification || null;
    action = fixDispatch?.workerStart?.started ? 'platform_followup_fix_dispatched' : 'platform_followup_fix_ready';
    replyText = platformFollowupReplyText(issueSync, fixDispatch);
  } else {
    slackStatusNotification = await notifySlackPlatformDevStatus(env, store, updatedItem, {
      stage: updatedItem.status,
      text: issueSyncStatusText(issueSync, updatedItem),
      statusText: issueSync?.ok ? ':white_check_mark: 已追加到 Issue。' : ':white_check_mark: 已记录补充。',
      finalSummary: finalRequirementCardSummary(updatedItem.summary),
      currentChange: platformFollowupCardSummary(feedback),
      skipDuplicate: false,
      slackSessionId: slackSession.id,
      dedupeKey: `platform-followup-recorded:${updatedItem.id}:${agentRun?.id || Date.now()}`,
    });
  }

  await updateFollowupSessionMemory({
    store,
    slackSession,
    sessionMemory,
    intake,
    patch: {
      ...memoryPatch,
      lastAgentResponse: replyText,
    },
    replyText,
    conversationKind: 'platform_followup',
  });

  await completeSlackAgentRun(store, agentRun, {
    workItemKind: 'platform_dev',
    workItemId: updatedItem.id,
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action,
      accepted: true,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_platform_followup_recorded',
      action,
      itemId: updatedItem.id,
      slackSessionId: slackSession.id,
      workerStarted: fixDispatch?.workerStart?.started ?? null,
      workerError: fixDispatch?.workerStart?.error || null,
      issueCommented: issueSync?.ok || false,
      issueCommentError: issueSync?.error || null,
    })
  );

  return {
    ok: true,
    action,
    accepted: true,
    workItemKind: 'platform_dev',
    workItemId: updatedItem.id,
    platformDevItemId: updatedItem.id,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText,
    noReply:
      Boolean(slackStatusNotification?.ok) &&
      !issueSync?.error &&
      !(fixDispatch?.workerStart && fixDispatch.workerStart.started === false),
    item: updatedItem,
    ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(fixDispatch?.workerStart ? { workerStart: fixDispatch.workerStart } : {}),
  };
}

export async function handleSlackFollowup({ store, env, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
  const feedback = redactSecretLikeText(redactedSlackAgentAnalysis?.summary || intake.text);
  const activeWorkItem = await activeWorkItemForSlackSession(store, slackSession);
  if (activeWorkItem?.workItemKind === 'platform_dev') {
    return await handleSlackPlatformDevFollowup({
      store,
      env,
      intake,
      slackSession,
      sessionMemory,
      agentRun,
      slackAgentAnalysis,
      item: activeWorkItem,
      feedback,
      redactedSlackAgentAnalysis,
    });
  }

  const activeJob = activeWorkItem || (await activeJobForSlackSession(store, slackSession));
  const job = await reconcileClosedGithubIssueForJob(store, env, activeJob, { notifySlack: true });

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
    await updateFollowupSessionMemory({
      store,
      slackSession,
      sessionMemory,
      intake,
      patch: {
        summary: redactSecretLikeText(sessionMemory.summary) || redactSecretLikeText(intake.text),
        requirements: redactSlackAnalysis(sessionMemory.requirements) || {},
        lastAgentResponse: replyText,
      },
      replyText,
      conversationKind: 'inactive_site_followup',
    });
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: job.id,
      ...slackAgentRunModelPatch(slackAgentAnalysis),
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
  const memoryPatch = {
    summary: followupSummary(sessionMemory.summary, feedback),
    requirements: redactedSlackAgentAnalysis || { text: redactSecretLikeText(intake.text), action: 'followup' },
    lastPreviewFeedback: feedback,
  };

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
  } else if (shouldQueueFixForJob(job)) {
    updatedJob = await store.patchJob(job.id, patch);
    if (updatedJob) {
      await store.linkJobToSlackSession(updatedJob, slackSession);
      await recordQueuedSlackFollowup(store, updatedJob, slackSession, feedback, agentRun);
      const round = followupRoundFromSummary(updatedJob.summary);
      slackStatusNotification = await notifySlackJobStatus(env, store, updatedJob, {
        stage: job.status,
        text: `已排队第 ${round || 1} 轮修改。当前处理结束后会继续更新。`,
        statusText: ':hourglass_flowing_sand: 已记录新的修改，等待当前处理结束。',
        cardTitle: `第 ${Math.max(1, Number(round) || 1)} 轮修改已排队`,
        finalSummary: finalRequirementCardSummary(updatedJob.summary),
        currentChange: followupCardSummary(feedback),
        allowRegression: true,
        skipDuplicate: false,
        dedupeKey: `slack-followup-queued:${updatedJob.id}:${agentRun?.id || Date.now()}`,
      });
      action = 'followup_fix_queued';
      replyText = '收到，已追加修改意见；当前处理结束后会继续处理这一轮。';
    }
  }

  if (!updatedJob) {
    updatedJob = await store.patchJob(job.id, patch);
    await store.linkJobToSlackSession(updatedJob, slackSession);
    replyText = '收到，已记录。会继续沿用当前会话。';
  }

  await updateFollowupSessionMemory({
    store,
    slackSession,
    sessionMemory,
    intake,
    patch: {
      ...memoryPatch,
      lastAgentResponse: replyText,
    },
    replyText,
    conversationKind: 'site_followup',
  });

  await completeSlackAgentRun(store, agentRun, {
    publishingJobId: updatedJob.id,
    ...slackAgentRunModelPatch(slackAgentAnalysis),
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
