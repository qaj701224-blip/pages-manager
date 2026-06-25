import {
  reconcileClosedGithubIssueForJob,
  reopenGithubResourceForJob,
  restoreJobForReopenedGithubResource,
  restorePlatformDevItemForReopenedGithubResource,
} from '../github/resource-reconciler.js';
import { startWorkerForJobIfConfigured, startWorkerForPlatformDevItemIfConfigured } from '../publishing/worker-dispatcher.js';
import { parseSlackWorkItemReference } from './intake.js';
import { completeSlackAgentRun, redactSlackAnalysis, slackAgentRunModelPatch } from './agent-run-records.js';
import { appendAssistantConversationTurn, buildConversationContext } from './conversation-context.js';
import { activateJobForSlackSession, slackThreadForSession } from './job-binding.js';
import { notifySlackJobStatus } from './notifier.js';
import { notifySlackPlatformDevStatus } from './platform-notifier.js';
import { listReconciledSlackWorkItemsForSession } from './work-item-reconciler.js';
import {
  normalizeSlackWorkItemQueryState,
  slackWorkItemIncludesInactive,
  slackWorkItemQueryStateFromText,
} from './work-item-query.js';
import {
  findVisibleSlackJobByReference,
  inactiveSlackWorkItemReply,
  isActionableSlackWorkItem,
  isReopenableSlackWorkItem,
  reopenTargetForSlackWorkItem,
  slackWorkItemListBlocks,
  slackWorkItemListText,
  slackWorkItemTargetLabel,
} from './work-items.js';

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

function slackWorkItemListMemory(jobs = [], result = {}, workItemState = 'active') {
  return {
    action: 'list_work_items',
    workItemState,
    total: Number(result.total || jobs.length || 0),
    shown: jobs.map(slackWorkItemJobResponse),
    createdAt: new Date().toISOString(),
  };
}

function slackWorkItemStateFromTool(intake = {}, slackAgentAnalysis = {}, toolArgs = {}) {
  const explicit =
    toolArgs.state ||
    toolArgs.workItemState ||
    toolArgs.work_item_state ||
    slackAgentAnalysis?.workItemState ||
    slackAgentAnalysis?.work_item_state ||
    intake.workItemState;
  if (explicit) return normalizeSlackWorkItemQueryState(explicit);

  return slackWorkItemQueryStateFromText(
    [intake.text, toolArgs.query, slackAgentAnalysis?.visibleReply, slackAgentAnalysis?.summary, slackAgentAnalysis?.title]
      .filter(Boolean)
      .join('\n')
  );
}

export async function handleSlackListWorkItemsTool({
  store,
  body,
  env,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  toolArgs = {},
}) {
  const workItemState = slackWorkItemStateFromTool(intake, slackAgentAnalysis, toolArgs);
  const includeInactive = slackWorkItemIncludesInactive(workItemState);
  const result = await listReconciledSlackWorkItemsForSession(store, body, env, {
    limit: 5,
    workItemState,
    includeInactive,
  });
  const jobs = result.jobs || [];
  const replyText = slackWorkItemListText(jobs, { workItemState, includeInactive });
  if (slackSession?.id && store.updateSessionMemory) {
    const previousSummary = slackAgentAnalysis?.summary || intake.text || '';
    const conversationContext = appendAssistantConversationTurn(
      buildConversationContext({ slackSession, sessionMemory, intake }),
      replyText,
      { kind: 'work_item_list' }
    );
    const lastWorkItemList = slackWorkItemListMemory(jobs, result, workItemState);
    conversationContext.lastWorkItemList = {
      scope: 'current_session',
      workItemState: lastWorkItemList.workItemState,
      total: lastWorkItemList.total,
      shown: lastWorkItemList.shown,
    };
    await store.updateSessionMemory(slackSession.id, {
      summary: previousSummary,
      lastAgentResponse: replyText,
      lastWorkItemList,
      conversationContext,
    });
  }
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
    replyText,
    blocks: slackWorkItemListBlocks(slackSession, jobs, { workItemState, includeInactive, slackAgentAnalysis }),
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    workItemState,
    jobs: jobs.map(slackWorkItemJobResponse),
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

export async function handleSlackSwitchWorkItemTool({
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
  if (job?.workItemKind !== 'platform_dev') {
    job = await reconcileClosedGithubIssueForJob(store, env, job, { notifySlack: true });
  }
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

  if (job.workItemKind === 'platform_dev') {
    const activeItem = await store.patchPlatformDevItem(job.id, {
      slackSessionId: slackSession.id,
      slackSessionKey: slackSession.sessionKey,
      slackThread: slackThreadForSession(slackSession, job.slackThread || {}),
    });
    await store.linkPlatformDevItemToSlackSession(activeItem, slackSession);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, activeItem, {
      stage: activeItem.status,
      text: '已切换到这个平台需求。',
      statusText: ':white_check_mark: 已切换到这个需求。',
      skipDuplicate: false,
      slackSessionId: slackSession.id,
    });
    await completeSlackAgentRun(store, agentRun, {
      workItemKind: 'platform_dev',
      workItemId: activeItem.id,
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: { action: 'switch_work_item', accepted: true, intent: slackAgentAnalysis?.intent || intake.action, reference },
    });
    return {
      ok: true,
      action: 'switch_work_item',
      accepted: true,
      workItemKind: 'platform_dev',
      workItemId: activeItem.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      replyText: '已切换到这个平台需求，继续在这里补充即可。',
      noReply: Boolean(slackStatusNotification?.ok),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
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

export async function handleSlackReopenWorkItemTool({
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
  if (job?.workItemKind !== 'platform_dev') {
    job = await reconcileClosedGithubIssueForJob(store, env, job, { notifySlack: true });
  }
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
  if (job.workItemKind === 'platform_dev') {
    if (!isReopenableSlackWorkItem(job) || !target) {
      await complete({
        accepted: false,
        reason: 'not_reopenable',
        workItemKind: 'platform_dev',
        workItemId: job.id,
        status: job.status,
      });
      return {
        ok: true,
        action: 'reopen_work_item_not_reopenable',
        accepted: false,
        workItemKind: 'platform_dev',
        workItemId: job.id,
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
      await complete({
        accepted: false,
        reason: 'github_reopen_failed',
        workItemKind: 'platform_dev',
        workItemId: job.id,
        error: err.message,
      });
      return {
        ok: true,
        action: 'reopen_work_item_failed',
        accepted: false,
        workItemKind: 'platform_dev',
        workItemId: job.id,
        replyText: `重新打开失败：${err.message}`,
        slackSessionId: slackSession.id,
        agentRunId: agentRun?.id,
        ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
      };
    }
    job = await restorePlatformDevItemForReopenedGithubResource(store, job, target, resource || {});
    await store.linkPlatformDevItemToSlackSession(job, slackSession);
    const workerStart = await startWorkerForPlatformDevItemIfConfigured(job, env);
    if (workerStart?.started === false) {
      const failedItem =
        (await store.failPlatformDevItem?.(job.id, 'worker_start_failed', workerStart.error || 'Worker start failed')) ||
        (await store.patchPlatformDevItem?.(job.id, {
          status: 'failed',
          errorCode: 'worker_start_failed',
          errorMessage: workerStart.error || 'Worker start failed',
        })) ||
        job;
      await store.linkPlatformDevItemToSlackSession(failedItem, slackSession);
      const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, failedItem, {
        stage: 'failed',
        text: failedItem.errorMessage || failedItem.errorCode || '平台需求处理失败',
        statusText: ':x: 平台需求处理失败',
        skipDuplicate: false,
        slackSessionId: slackSession.id,
        dedupeKey: `slack-agent-platform-reopen-failed:${target}:${failedItem.id}:${agentRun?.id || Date.now()}`,
      });
      await complete({
        accepted: false,
        reason: 'worker_start_failed',
        workItemKind: 'platform_dev',
        workItemId: failedItem.id,
        error: workerStart.error || 'Worker start failed',
      });
      return {
        ok: true,
        action: 'reopen_work_item_worker_start_failed',
        accepted: false,
        workItemKind: 'platform_dev',
        workItemId: failedItem.id,
        replyText: `重新打开后启动处理失败：${workerStart.error || 'Worker start failed'}`,
        noReply: Boolean(slackStatusNotification?.ok),
        slackSessionId: slackSession.id,
        agentRunId: agentRun?.id,
        ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
        workerStart,
        ...(slackStatusNotification ? { slackStatusNotification } : {}),
      };
    }
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, job, {
      stage: job.status,
      text: target === 'pr' ? 'GitHub PR 已重新打开，任务已恢复。' : 'GitHub issue 已重新打开，任务已恢复。',
      statusText:
        target === 'pr'
          ? ':white_check_mark: GitHub PR 已重新打开，任务已恢复。'
          : ':white_check_mark: GitHub issue 已重新打开，任务已恢复。',
      skipDuplicate: false,
      slackSessionId: slackSession.id,
      dedupeKey: `slack-agent-platform-reopen:${target}:${job.id}:${agentRun?.id || Date.now()}`,
    });
    return {
      ok: true,
      action: 'reopen_work_item',
      accepted: true,
      workItemKind: 'platform_dev',
      workItemId: job.id,
      replyText: target === 'pr' ? '已重新打开 PR，平台需求会继续处理。' : '已重新打开 Issue，平台需求会继续处理。',
      noReply: Boolean(slackStatusNotification?.ok),
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
      ...(workerStart ? { workerStart } : {}),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    };
  }
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
  if (workerStart?.started === false) {
    const failedJob =
      (await store.failJob?.(job.id, 'worker_start_failed', workerStart.error || 'Worker start failed')) ||
      (await store.patchJob?.(job.id, {
        status: 'failed',
        errorCode: 'worker_start_failed',
        errorMessage: workerStart.error || 'Worker start failed',
      })) ||
      job;
    await store.linkJobToSlackSession(failedJob, slackSession);
    const slackStatusNotification = await notifySlackJobStatus(env, store, failedJob, {
      stage: 'failed',
      text: failedJob.errorMessage || failedJob.errorCode || '发布任务失败',
      statusText: ':x: 发布任务失败',
      skipDuplicate: false,
      dedupeKey: `slack-agent-reopen-failed:${target}:${failedJob.id}:${agentRun?.id || Date.now()}`,
      slackSessionId: slackSession.id,
    });
    await complete(
      {
        accepted: false,
        reason: 'worker_start_failed',
        error: workerStart.error || 'Worker start failed',
      },
      { jobId: failedJob.id }
    );
    return {
      ok: true,
      action: 'reopen_work_item_worker_start_failed',
      accepted: false,
      jobId: failedJob.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      replyText: `重新打开后启动处理失败：${workerStart.error || 'Worker start failed'}`,
      noReply: Boolean(slackStatusNotification?.ok),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
      workerStart,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    };
  }
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
