import { createIssueComment, githubConfigFromEnv, hasGithubAuthConfig } from '@xd/git-client';
import { reconcileClosedGithubIssueForJob } from '../github/resource-reconciler.js';
import { diagnoseGithubActionsForWorkItem } from '../github/actions-diagnostics.js';
import { dispatchPlatformDevFixIfNeeded } from '../platform-dev/automation.js';
import { startWorkerForJobIfConfigured } from '../publishing/worker-dispatcher.js';
import { notifySlackJobStatus } from '../slack/notifier.js';
import { runSlackBackground, updateSlackInteractionMessage } from '../slack/delivery.js';
import { appendAssistantConversationTurn, buildConversationContext } from '../slack/conversation-context.js';
import { completeSlackAgentRun, redactSlackAnalysis, slackAgentRunModelPatch } from '../slack/agent-run-records.js';
import { redactSecretLikeText } from '../slack/text.js';
import { buildSlackWorkItemDiagnosisIssueComment, buildSlackWorkItemHumanTriageIssueComment } from '../slack/diagnostics.js';
import { notifySlackPlatformDevStatus } from '../slack/platform-notifier.js';
import { findVisibleSlackJobByReference, slackJobVisibleToActor } from '../slack/work-items.js';
import { activeWorkItemForSlackSession } from '../slack/followup.js';
import {
  isSitePublishingWorkItem,
  SITE_PUBLISHING_RETIRED_CODE,
  SITE_PUBLISHING_RETIRED_MESSAGE,
} from '../publishing/retirement.js';

export async function failQueuedSlackWorkerStart(store, context = {}, errorMessage = 'Worker start failed') {
  if (context.workItemKind === 'site_publishing' && context.publishingJobId) {
    return (
      (await store?.failJob?.(context.publishingJobId, 'worker_start_failed', errorMessage)) ||
      (await store?.patchJob?.(context.publishingJobId, {
        status: 'failed',
        errorCode: 'worker_start_failed',
        errorMessage,
      }))
    );
  }
  if (context.workItemKind === 'platform_dev' && context.platformDevItemId) {
    return (
      (await store?.failPlatformDevItem?.(context.platformDevItemId, 'worker_start_failed', errorMessage)) ||
      (await store?.patchPlatformDevItem?.(context.platformDevItemId, {
        status: 'failed',
        errorCode: 'worker_start_failed',
        errorMessage,
      }))
    );
  }
  return null;
}

export async function notifyQueuedWorkerStartFailure(env, store, failedItem, context = {}) {
  if (!failedItem) return null;
  if (context.workItemKind === 'platform_dev') {
    return await notifySlackPlatformDevStatus(env, store, failedItem, {
      stage: 'failed',
      text: failedItem.errorMessage || failedItem.errorCode || '平台需求处理失败',
      statusText: ':x: 平台需求处理失败',
      skipDuplicate: false,
      slackSessionId: context.slackSessionId || failedItem.slackSessionId || undefined,
    });
  }
  if (context.workItemKind === 'site_publishing') {
    return await notifySlackJobStatus(env, store, failedItem, {
      stage: 'failed',
      text: failedItem.errorMessage || failedItem.errorCode || '发布任务失败',
      statusText: ':x: 发布任务失败',
      skipDuplicate: false,
    });
  }
  return null;
}

export function queueSlackWorkerStart(env, store, task, context = {}) {
  runSlackBackground(env, async () => {
    let result;
    try {
      result = await task();
    } catch (error) {
      result = { started: false, error: error.message || 'Worker start failed' };
    }
    if (result?.started === false) {
      const failedItem = await failQueuedSlackWorkerStart(store, context, result.error || 'Worker start failed');
      await notifyQueuedWorkerStartFailure(env, store, failedItem, context);
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_interaction_worker_start_failed',
          error: result.error || 'worker_start_failed',
          ...context,
        })
      );
    }
  });
  return { queued: true };
}

export function interactionHandledBlocks({ header = '操作已处理', text = '', contextText = '', links = [] } = {}) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } },
    ...(text ? [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }] : []),
    ...(contextText ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: contextText.slice(0, 2900) }] }] : []),
  ];
  const elements = links
    .filter((link) => link?.url && link?.text)
    .slice(0, 3)
    .map((link) => ({
      type: 'button',
      text: { type: 'plain_text', text: link.text },
      url: link.url,
      action_id: link.actionId || 'open_link',
    }));
  if (elements.length) blocks.push({ type: 'actions', elements });
  return blocks;
}

export async function updateInteractionAsHandled(env, body, session, options = {}) {
  return updateSlackInteractionMessage(env, body, session, {
    text: options.text || options.header || '操作已处理。',
    blocks: interactionHandledBlocks(options),
  });
}

export function linksForWorkItem(item = {}) {
  const workItem = item || {};
  return [
    { text: '查看 Issue', url: workItem.issueUrl || workItem.githubIssueUrl, actionId: 'open_issue' },
    { text: '查看 PR', url: workItem.prUrl || workItem.githubPrUrl, actionId: 'open_pr' },
    { text: '打开 Preview', url: workItem.previewUrl, actionId: 'open_preview' },
  ];
}

export async function updateSessionMemoryWithAssistantTurn(
  store,
  slackSession,
  sessionMemory = {},
  intake = {},
  patch = {},
  replyText = ''
) {
  if (!slackSession?.id || !store?.updateSessionMemory) return null;
  const baseContext = buildConversationContext({ slackSession, sessionMemory, intake });
  const { conversationKind, conversationContext: patchContext = {}, ...memoryPatch } = patch;
  const nextContext = appendAssistantConversationTurn(baseContext, replyText || patch.lastAgentResponse || '', {
    kind: conversationKind || 'agent_reply',
  });
  return store.updateSessionMemory(slackSession.id, {
    ...memoryPatch,
    conversationContext: {
      ...nextContext,
      ...patchContext,
      recentTurns: patchContext.recentTurns || nextContext.recentTurns,
      lastAssistantMessage: patchContext.lastAssistantMessage || nextContext.lastAssistantMessage,
    },
  });
}

export async function eventsForWorkItem(store, item = {}) {
  if (!item?.id) return [];
  if (item.workItemKind === 'platform_dev') {
    return store.listPlatformDevEvents ? await store.listPlatformDevEvents(item.id) : [];
  }
  return store.listEvents ? await store.listEvents(item.id) : [];
}

export function platformDevSlackWorkItem(item = null) {
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

export async function workItemForDiagnosis(store, body, slackSession, toolArgs = {}) {
  const explicitNumber = Number(toolArgs.number || toolArgs.targetNumber || toolArgs.prNumber || toolArgs.issueNumber);
  const explicitKind =
    toolArgs.kind ||
    toolArgs.targetKind ||
    (toolArgs.prNumber ? 'pr' : toolArgs.issueNumber ? 'issue' : toolArgs.target_kind || null);
  if (Number.isFinite(explicitNumber) && explicitNumber > 0) {
    const item = await findVisibleSlackJobByReference(store, body, { kind: explicitKind || 'unknown', number: explicitNumber });
    if (!item) return { forbidden: true, item: null };
    return { item };
  }

  const explicitWorkItemKind = toolArgs.workItemKind || toolArgs.work_item_kind || null;
  const explicitWorkItemId = toolArgs.workItemId || toolArgs.work_item_id || null;
  const explicitJobId =
    toolArgs.jobId || toolArgs.job_id || (explicitWorkItemKind !== 'platform_dev' ? explicitWorkItemId : null);
  if (explicitWorkItemKind === 'platform_dev' && explicitWorkItemId) {
    const item = platformDevSlackWorkItem(store.getPlatformDevItem ? await store.getPlatformDevItem(explicitWorkItemId) : null);
    if (item && !slackJobVisibleToActor(item, body)) return { forbidden: true, item };
    return { item: item || null };
  }
  if (explicitJobId) {
    const job = store.getJob ? await store.getJob(explicitJobId) : null;
    if (job && !slackJobVisibleToActor(job, body)) return { forbidden: true, item: job };
    return { item: job || null };
  }
  return { item: slackSession ? await activeWorkItemForSlackSession(store, slackSession) : null };
}

export function githubWriteConfigForSlackDiagnosis(env = {}) {
  const config = githubConfigFromEnv(env);
  return config.repoFullName && hasGithubAuthConfig(config) ? config : null;
}

export function issueNumberForWorkItem(item = {}) {
  return item.issueNumber || item.githubIssueNumber || null;
}

export async function createSlackWorkItemIssueComment(env, item, body, logMessage) {
  const issueNumber = issueNumberForWorkItem(item);
  if (!issueNumber) return { skipped: true, reason: 'missing_issue' };
  const config = githubWriteConfigForSlackDiagnosis(env);
  if (!config) return { skipped: true, reason: 'github_not_configured' };

  try {
    const comment = await createIssueComment(env.GITHUB_FETCH || env.GITHUB_STATUS_FETCH || fetch, config, issueNumber, body);
    return { ok: true, issueNumber, comment };
  } catch (err) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: logMessage,
        workItemKind: item.workItemKind || 'site_publishing',
        workItemId: item.id || null,
        issueNumber,
        error: err.message,
      })
    );
    return { ok: false, issueNumber, error: err.message };
  }
}

export async function appendSlackDiagnosisIssueComment(env, item, events = [], githubActions = null) {
  return createSlackWorkItemIssueComment(
    env,
    item,
    buildSlackWorkItemDiagnosisIssueComment(item, { events, githubActions }),
    'slack_diagnosis_issue_comment_failed'
  );
}

export async function appendSlackHumanTriageIssueComment(env, item, events = [], githubActions = null) {
  return createSlackWorkItemIssueComment(
    env,
    item,
    buildSlackWorkItemHumanTriageIssueComment(item, { events, githubActions }),
    'slack_human_triage_issue_comment_failed'
  );
}

export function appendDiagnosisReplyText(result = {}) {
  if (result.ok) return `已把诊断摘要追加到 Issue #${result.issueNumber}。`;
  if (result.skipped && result.reason === 'missing_issue') return '当前任务还没有关联 Issue，暂时不能追加诊断。';
  if (result.skipped && result.reason === 'github_not_configured')
    return '诊断摘要已生成，但 GitHub 写入暂未配置，不能追加到 Issue。';
  if (result.ok === false) return `追加诊断失败：${result.error}`;
  return '诊断摘要暂时不能追加到 Issue。';
}

export function humanTriageReplyText(result = {}) {
  if (result.issueComment?.ok) return `已标记为需要人工排查，并追加到 Issue #${result.issueComment.issueNumber}。`;
  if (result.issueComment?.reason === 'missing_issue') {
    return '已标记为需要人工排查；当前任务还没有关联 Issue，无法追加诊断记录。';
  }
  if (result.issueComment?.reason === 'github_not_configured') {
    return '已标记为需要人工排查；GitHub 写入暂未配置，无法追加到 Issue。';
  }
  if (result.issueComment?.ok === false) {
    return `已标记为需要人工排查；追加到 Issue 失败：${result.issueComment.error}`;
  }
  return '已标记为需要人工排查。';
}

export async function recordHumanTriageRequest(store, item = {}, slackSession = null) {
  if (!store?.recordAgentRunEvent || !item?.id) return null;
  const common = {
    slackSessionId: slackSession?.id || item.slackSessionId || null,
    type: 'human_triage_requested',
    stage: item.status || null,
    status: 'requested',
    text: '用户从 Slack 请求人工排查。',
    dedupeKey: `human-triage:${item.workItemKind || 'site_publishing'}:${item.id}:${Date.now()}`,
    slackChannelId: item.slackThread?.channelId || null,
    slackThreadTs: item.slackThread?.threadTs || null,
  };
  if (item.workItemKind === 'platform_dev') {
    return store.recordAgentRunEvent({
      ...common,
      workItemKind: 'platform_dev',
      workItemId: item.id,
    });
  }
  return store.recordAgentRunEvent({
    ...common,
    publishingJobId: item.id,
  });
}

export async function retrySitePublishingWorkItem(store, env, item = {}, slackSession = null) {
  let job = item;
  let retryStage = item.status;
  if (['issue_created', 'indexing'].includes(item.status) && store.updateJob) {
    job = await store.updateJob(item.id, 'generating_page', { errorCode: null, errorMessage: null });
    retryStage = 'generating_page';
  } else if (
    ['pr_created', 'reviewing', 'changes_requested', 'preview_deployed'].includes(item.status) &&
    store.moveJobToFixing
  ) {
    job = await store.moveJobToFixing(item.id, {
      errorCode: null,
      errorMessage: null,
      previewUrl: item.status === 'preview_deployed' ? null : item.previewUrl,
    });
    retryStage = 'fixing';
  } else if (!['received', 'generating_page', 'fixing', 'previewing'].includes(item.status)) {
    return { retried: false, reason: 'not_retryable', item };
  }
  if (!job) return { retried: false, reason: 'not_retryable', item };
  await store.linkJobToSlackSession?.(job, slackSession || undefined);
  const workerStart = await startWorkerForJobIfConfigured(job, env);
  if (workerStart?.started === false) {
    const message = workerStart.error || 'Worker start failed';
    job =
      (await store.failJob?.(job.id, 'worker_start_failed', message, {
        summary: job.summary,
        previewUrl: null,
      })) ||
      (await store.patchJob?.(job.id, {
        status: 'failed',
        errorCode: 'worker_start_failed',
        errorMessage: message,
        previewUrl: null,
      })) ||
      job;
    await store.linkJobToSlackSession?.(job, slackSession || undefined);
    const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: 'failed',
      text: `重试启动失败：${message}`,
      statusText: ':x: 重试启动失败',
      allowRegression: true,
      skipDuplicate: false,
      slackSessionId: slackSession?.id || job.slackSessionId || null,
      dedupeKey: `slack-diagnosis-retry-failed:${job.id}:${Date.now()}`,
    });
    return {
      retried: false,
      reason: message,
      item: job,
      workerStart,
      slackStatusNotification,
    };
  }
  const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
    stage: retryStage,
    text: workerStart?.started ? '已重新触发处理流程。' : '已记录重试请求，等待处理流程启动。',
    statusText: workerStart?.started ? ':hourglass_flowing_sand: 已重试，正在处理。' : ':warning: 已记录重试请求。',
    skipDuplicate: false,
    slackSessionId: slackSession?.id || job.slackSessionId || null,
    dedupeKey: `slack-diagnosis-retry:${job.id}:${Date.now()}`,
  });
  return {
    retried: Boolean(workerStart?.started),
    reason: workerStart?.started ? null : workerStart?.error || 'worker_not_started',
    item: job,
    workerStart,
    slackStatusNotification,
  };
}

export async function retrySlackWorkItem(store, env, item = {}, slackSession = null, options = {}) {
  if (item.workItemKind === 'platform_dev') {
    const result = await dispatchPlatformDevFixIfNeeded(store, item, env, {
      trigger: 'manual_retry',
      force: true,
      issueSyncText: '已收到重试请求，',
      currentChange: '用户从 Slack 请求重试当前任务。',
    });
    return {
      retried: Boolean(result.workerStart?.started),
      reason: result.reason || result.workerStart?.error || null,
      item: result.item || item,
      workerStart: result.workerStart || null,
      slackStatusNotification: result.slackStatusNotification || null,
    };
  }
  if (options.retireSitePublishing !== false && isSitePublishingWorkItem(item)) {
    return {
      retried: false,
      retired: true,
      reason: SITE_PUBLISHING_RETIRED_CODE,
      message: SITE_PUBLISHING_RETIRED_MESSAGE,
      item,
    };
  }
  return retrySitePublishingWorkItem(store, env, item, slackSession);
}

export function retryWorkItemReplyText(result = {}) {
  if (result.retired) return result.message || SITE_PUBLISHING_RETIRED_MESSAGE;
  if (result.retried) return '已重新触发处理流程。我会继续在当前对话更新进度。';
  if (result.reason === 'not_dispatchable' || result.reason === 'not_retryable') {
    return '当前阶段不能直接重试。可以查看 Issue / PR 后补充修复要求，或转人工排查。';
  }
  if (result.reason === 'fix_attempts_exhausted') return '自动修复次数已达到上限，需要人工查看 Issue / PR 后再继续。';
  if (result.reason) return `重试暂未启动：${result.reason}`;
  return '重试暂未启动，请稍后再试或转人工排查。';
}

export async function handleSlackAppendDiagnosisCommentTool({
  store,
  body,
  env,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  retireSitePublishing = true,
  toolArgs = {},
}) {
  const resolved = await workItemForDiagnosis(store, body, slackSession, toolArgs);
  if (resolved.forbidden) {
    await completeSlackAgentRun(store, agentRun, {
      report: { action: 'append_diagnosis_comment', accepted: false, forbidden: true },
    });
    return {
      ok: true,
      action: 'append_diagnosis_comment_forbidden',
      accepted: false,
      replyText: '这个任务不属于当前 Slack 用户，不能追加诊断。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
    };
  }

  let item = resolved.item;
  if (retireSitePublishing && isSitePublishingWorkItem(item)) {
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: item.id,
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: {
        action: 'append_diagnosis_comment',
        accepted: false,
        reason: SITE_PUBLISHING_RETIRED_CODE,
        status: item.status,
      },
    });
    return {
      ok: true,
      action: 'site_publishing_retired',
      accepted: false,
      jobId: item.id,
      replyText: SITE_PUBLISHING_RETIRED_MESSAGE,
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      workItem: item,
    };
  }
  if (item && item.workItemKind !== 'platform_dev') {
    item = await reconcileClosedGithubIssueForJob(store, env, item, { notifySlack: true });
  }
  if (!item) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: { action: 'append_diagnosis_comment', accepted: false, reason: 'not_found' },
    });
    return {
      ok: true,
      action: 'append_diagnosis_comment_not_found',
      accepted: false,
      replyText: '我还没有在当前会话里找到可追加诊断的任务。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  const events = await eventsForWorkItem(store, item);
  const githubActions = await diagnoseGithubActionsForWorkItem(env, item, { events });
  const appendResult = await appendSlackDiagnosisIssueComment(env, item, events, githubActions);
  const replyText = appendDiagnosisReplyText(appendResult);
  if (slackSession?.id && store.updateSessionMemory) {
    await updateSessionMemoryWithAssistantTurn(
      store,
      slackSession,
      sessionMemory,
      intake,
      {
        summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
        lastAgentResponse: replyText,
        conversationKind: 'diagnosis_comment',
      },
      replyText
    );
  }
  await completeSlackAgentRun(store, agentRun, {
    ...(item.workItemKind === 'platform_dev'
      ? { workItemKind: 'platform_dev', workItemId: item.id }
      : { publishingJobId: item.id }),
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'append_diagnosis_comment',
      accepted: Boolean(appendResult.ok),
      intent: slackAgentAnalysis?.intent || intake.action,
      status: item.status,
      issueNumber: appendResult.issueNumber || issueNumberForWorkItem(item),
      ...(appendResult.reason ? { reason: appendResult.reason } : {}),
      ...(appendResult.error ? { error: appendResult.error } : {}),
    },
  });

  return {
    ok: true,
    action: appendResult.ok ? 'append_diagnosis_comment' : 'append_diagnosis_comment_failed',
    accepted: Boolean(appendResult.ok),
    replyText,
    ...(item.workItemKind === 'platform_dev' ? { workItemKind: 'platform_dev', workItemId: item.id } : { jobId: item.id }),
    ...(slackSession ? { slackSessionId: slackSession.id } : {}),
    ...(agentRun ? { agentRunId: agentRun.id } : {}),
    workItem: item,
    appendDiagnosis: appendResult,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

export async function handleSlackHumanTriageTool({
  store,
  body,
  env,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  retireSitePublishing = true,
  toolArgs = {},
}) {
  const resolved = await workItemForDiagnosis(store, body, slackSession, toolArgs);
  if (resolved.forbidden) {
    await completeSlackAgentRun(store, agentRun, {
      report: { action: 'human_triage', accepted: false, forbidden: true },
    });
    return {
      ok: true,
      action: 'human_triage_forbidden',
      accepted: false,
      replyText: '这个任务不属于当前 Slack 用户，不能转人工排查。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
    };
  }

  let item = resolved.item;
  if (retireSitePublishing && isSitePublishingWorkItem(item)) {
    await completeSlackAgentRun(store, agentRun, {
      publishingJobId: item.id,
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: {
        action: 'human_triage',
        accepted: false,
        reason: SITE_PUBLISHING_RETIRED_CODE,
        status: item.status,
      },
    });
    return {
      ok: true,
      action: 'site_publishing_retired',
      accepted: false,
      jobId: item.id,
      replyText: SITE_PUBLISHING_RETIRED_MESSAGE,
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      workItem: item,
    };
  }
  if (item && item.workItemKind !== 'platform_dev') {
    item = await reconcileClosedGithubIssueForJob(store, env, item, { notifySlack: true });
  }
  if (!item) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: { action: 'human_triage', accepted: false, reason: 'not_found' },
    });
    return {
      ok: true,
      action: 'human_triage_not_found',
      accepted: false,
      replyText: '我还没有在当前会话里找到可转人工排查的任务。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  const events = await eventsForWorkItem(store, item);
  const githubActions = await diagnoseGithubActionsForWorkItem(env, item, { events });
  const triageEvent = await recordHumanTriageRequest(store, item, slackSession);
  const issueComment = await appendSlackHumanTriageIssueComment(env, item, events, githubActions);
  const result = { triageEvent, issueComment };
  const replyText = humanTriageReplyText(result);
  if (slackSession?.id && store.updateSessionMemory) {
    await updateSessionMemoryWithAssistantTurn(
      store,
      slackSession,
      sessionMemory,
      intake,
      {
        summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
        lastAgentResponse: replyText,
        conversationKind: 'human_triage',
      },
      replyText
    );
  }
  await completeSlackAgentRun(store, agentRun, {
    ...(item.workItemKind === 'platform_dev'
      ? { workItemKind: 'platform_dev', workItemId: item.id }
      : { publishingJobId: item.id }),
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'human_triage',
      accepted: true,
      intent: slackAgentAnalysis?.intent || intake.action,
      status: item.status,
      issueNumber: issueComment.issueNumber || issueNumberForWorkItem(item),
      ...(issueComment.reason ? { issueCommentReason: issueComment.reason } : {}),
      ...(issueComment.error ? { issueCommentError: issueComment.error } : {}),
    },
  });

  return {
    ok: true,
    action: 'human_triage',
    accepted: true,
    replyText,
    ...(item.workItemKind === 'platform_dev' ? { workItemKind: 'platform_dev', workItemId: item.id } : { jobId: item.id }),
    ...(slackSession ? { slackSessionId: slackSession.id } : {}),
    ...(agentRun ? { agentRunId: agentRun.id } : {}),
    workItem: item,
    humanTriage: result,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

export async function handleSlackRetryWorkItemTool({
  store,
  body,
  env,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  retireSitePublishing = true,
  toolArgs = {},
}) {
  const resolved = await workItemForDiagnosis(store, body, slackSession, toolArgs);
  if (resolved.forbidden) {
    await completeSlackAgentRun(store, agentRun, {
      report: { action: 'retry_work_item', accepted: false, forbidden: true },
    });
    return {
      ok: true,
      action: 'retry_work_item_forbidden',
      accepted: false,
      replyText: '这个任务不属于当前 Slack 用户，不能重试。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
    };
  }

  let item = resolved.item;
  if (item && item.workItemKind !== 'platform_dev' && !retireSitePublishing) {
    item = await reconcileClosedGithubIssueForJob(store, env, item, { notifySlack: true });
  }
  if (!item) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: { action: 'retry_work_item', accepted: false, reason: 'not_found' },
    });
    return {
      ok: true,
      action: 'retry_work_item_not_found',
      accepted: false,
      replyText: '我还没有在当前会话里找到可重试的任务。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  const retryResult = await retrySlackWorkItem(store, env, item, slackSession, { retireSitePublishing });
  const replyText = retryWorkItemReplyText(retryResult);
  if (slackSession?.id && store.updateSessionMemory) {
    await updateSessionMemoryWithAssistantTurn(
      store,
      slackSession,
      sessionMemory,
      intake,
      {
        summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
        lastAgentResponse: replyText,
        conversationKind: 'retry_work_item',
      },
      replyText
    );
  }
  await completeSlackAgentRun(store, agentRun, {
    ...(retryResult.item?.workItemKind === 'platform_dev'
      ? { workItemKind: 'platform_dev', workItemId: retryResult.item.id }
      : { publishingJobId: retryResult.item?.id || item.id }),
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'retry_work_item',
      accepted: Boolean(retryResult.retried),
      intent: slackAgentAnalysis?.intent || intake.action,
      status: retryResult.item?.status || item.status,
      ...(retryResult.reason ? { reason: retryResult.reason } : {}),
    },
  });

  return {
    ok: true,
    action: retryResult.retried ? 'retry_work_item' : 'retry_work_item_failed',
    accepted: Boolean(retryResult.retried),
    replyText,
    noReply: Boolean(retryResult.slackStatusNotification?.ok),
    ...(retryResult.item?.workItemKind === 'platform_dev'
      ? { workItemKind: 'platform_dev', workItemId: retryResult.item.id }
      : { jobId: retryResult.item?.id || item.id }),
    ...(slackSession ? { slackSessionId: slackSession.id } : {}),
    ...(agentRun ? { agentRunId: agentRun.id } : {}),
    workItem: retryResult.item || item,
    retry: retryResult,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}
