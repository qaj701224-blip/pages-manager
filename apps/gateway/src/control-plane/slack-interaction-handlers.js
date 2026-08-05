import {
  reconcileClosedGithubIssueForJob,
  reopenGithubResourceForJob,
  restoreJobForReopenedGithubResource,
  restorePlatformDevItemForReopenedGithubResource,
} from '../github/resource-reconciler.js';
import { getStore } from './context.js';
import { startWorkerForJobIfConfigured, startWorkerForPlatformDevItemIfConfigured } from '../publishing/worker-dispatcher.js';
import { readSlackRequest, slackAckResponse } from '../slack/http.js';
import { notifySlackJobStatus } from '../slack/notifier.js';
import {
  fetchSlackRequesterProfile,
  postSlackInteractionThreadReply,
  runSlackBackground,
  updateSlackInteractionMessage,
} from '../slack/delivery.js';
import { failRunningSlackAgentRunsForClosedSession, redactSlackAnalysis } from '../slack/agent-run-records.js';
import { activateJobForSlackSession } from '../slack/job-binding.js';
import { slackUserIdFromBody } from '../slack/session.js';
import { redactSecretLikeText } from '../slack/text.js';
import { slackJobInput } from '../slack/job-input.js';
import {
  confirmedSlackJobBodyFromInteraction,
  draftAnalysisFromMemory,
  hasConfirmableDraft,
  slackIssueConfirmedBlocks,
  slackIssueConfirmedText,
  slackIssueWaitingMoreBlocks,
  slackIssueWaitingMoreText,
  confirmedSlackPlatformBodyFromInteraction,
  hasConfirmablePlatformDraft,
  slackPlatformIssueConfirmationBlocks,
  slackPlatformIssueConfirmationText,
  slackPlatformIssueConfirmedBlocks,
  slackPlatformIssueConfirmedText,
} from '../slack/issue-confirmation.js';
import { platformDevInput } from '../slack/platform-input.js';
import { notifySlackPlatformDevStatus } from '../slack/platform-notifier.js';
import { listReconciledSlackWorkItemsForSession } from '../slack/work-item-reconciler.js';
import {
  inactiveSlackWorkItemReply,
  isActionableSlackWorkItem,
  isReopenableSlackWorkItem,
  parseSlackButtonValue,
  reopenTargetForSlackWorkItem,
  slackJobVisibleToActor,
  slackWorkItemTargetLabel,
  slackWorkItemListBlocks,
  slackWorkItemListText,
} from '../slack/work-items.js';
import { activeWorkItemForSlackSession } from '../slack/followup.js';
import {
  answerRepoQuestion,
  nextRepoQuestionContext,
  platformDraftFromRepoQuestionContext,
  repoQuestionActionBlocks,
  repoEvidenceDetailsFromContext,
} from '../slack/repo-question.js';
import {
  failQueuedSlackWorkerStart,
  handleSlackAppendDiagnosisCommentTool,
  handleSlackHumanTriageTool,
  handleSlackRetryWorkItemTool,
  linksForWorkItem,
  notifyQueuedWorkerStartFailure,
  queueSlackWorkerStart,
  updateInteractionAsHandled,
  updateSessionMemoryWithAssistantTurn,
} from './shared.js';
import { SITE_PUBLISHING_RETIRED_MESSAGE } from '../publishing/retirement.js';

export async function handleSlackInteractions(request, env, options = {}) {
  const { body } = await readSlackRequest(request, env);
  const action = body.actions?.[0] || {};
  const actionId = action.action_id || '';
  const teamId = body.team?.id || body.team_id || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);

  if (actionId === 'pages_confirm_issue' && options.retireSitePublishing !== false) {
    return slackAckResponse({
      response_type: 'ephemeral',
      text: SITE_PUBLISHING_RETIRED_MESSAGE,
    });
  }

  const store = getStore(env);

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
    await updateSessionMemoryWithAssistantTurn(
      store,
      session,
      sessionMemory,
      { action: 'confirm_create_issue', text: slackAgentAnalysis.summary || sessionMemory.summary || '' },
      {
        summary: redactSecretLikeText(slackAgentAnalysis.summary || sessionMemory.summary),
        requirements: redactSlackAnalysis(slackAgentAnalysis),
        lastAgentResponse: '已确认创建发布任务。',
        pendingQuestions: [],
        conversationKind: 'confirmation_card',
      },
      '已确认创建发布任务。'
    );

    const slackStatusNotification = created
      ? await notifySlackJobStatus(env, store, job, {
          stage: 'received',
          text: '用户已确认发布需求，正在创建 GitHub issue。',
          statusText: ':hourglass_flowing_sand: 已确认，正在创建 GitHub issue...',
          skipDuplicate: false,
        })
      : null;
    const workerStart = created
      ? queueSlackWorkerStart(env, store, () => startWorkerForJobIfConfigured(job, env), {
          workItemKind: 'site_publishing',
          publishingJobId: job.id,
        })
      : null;
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

  if (actionId === 'pages_confirm_platform_issue') {
    const sessionId = action.value || '';
    const session = await store.getSlackSession(sessionId);
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个会话不属于当前 Slack 用户，不能创建平台需求。',
      });
    }

    if (session.activeWorkItemId || session.activeJobId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话已经在处理中。继续回复修改意见即可。',
      });
    }

    const sessionMemory = await store.getSessionMemory(session.id);
    const slackAgentAnalysis = {
      ...draftAnalysisFromMemory(sessionMemory),
      ...(sessionMemory.requirements || {}),
      lane: 'platform-dev',
    };
    if (!hasConfirmablePlatformDraft(slackAgentAnalysis)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话还没有可确认的平台需求。请先继续补充想改造的产品目标或代码范围。',
      });
    }

    const requesterProfile = await fetchSlackRequesterProfile(
      env,
      confirmedSlackPlatformBodyFromInteraction(body, session, slackAgentAnalysis)
    );
    const { item, created } = await store.createPlatformDevItem(
      platformDevInput(confirmedSlackPlatformBodyFromInteraction(body, session, slackAgentAnalysis, requesterProfile))
    );
    const workItemLink = await store.linkPlatformDevItemToSlackSession(item, session);
    await updateSessionMemoryWithAssistantTurn(
      store,
      session,
      sessionMemory,
      { action: 'confirm_platform_issue', text: slackAgentAnalysis.summary || sessionMemory.summary || '' },
      {
        summary: redactSecretLikeText(slackAgentAnalysis.summary || sessionMemory.summary),
        requirements: redactSlackAnalysis({ ...slackAgentAnalysis, lane: 'platform-dev' }),
        lastAgentResponse: '已确认创建平台 Issue。',
        pendingQuestions: [],
        conversationKind: 'confirmation_card',
      },
      '已确认创建平台 Issue。'
    );

    const autoDevPending = item.autoDevStatus !== 'triggered';
    const slackStatusNotification = created
      ? await notifySlackPlatformDevStatus(env, store, item, {
          stage: 'issue_creating',
          text: autoDevPending ? '平台需求已确认，正在创建 GitHub issue。' : '平台需求已确认，正在创建 GitHub issue。',
          statusText: autoDevPending
            ? ':hourglass_flowing_sand: 已确认，正在创建 GitHub issue...'
            : ':hourglass_flowing_sand: 已确认，正在创建 GitHub issue...',
          skipDuplicate: false,
        })
      : null;
    const workerStart = created
      ? queueSlackWorkerStart(env, store, () => startWorkerForPlatformDevItemIfConfigured(item, env), {
          workItemKind: 'platform_dev',
          platformDevItemId: item.id,
          slackSessionId: session.id,
        })
      : null;
    const confirmationCardUpdate = await updateSlackInteractionMessage(env, body, session, {
      text: slackPlatformIssueConfirmedText(slackAgentAnalysis),
      blocks: slackPlatformIssueConfirmedBlocks(session, slackAgentAnalysis),
    });

    return slackAckResponse({
      ok: true,
      ...(created ? {} : { response_type: 'ephemeral', text: '这个平台需求已经确认过，继续在当前会话补充即可。' }),
      platformDevItemId: item.id,
      workItemKind: 'platform_dev',
      workItemId: item.id,
      workItemLink,
      created,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(workerStart ? { workerStart } : {}),
      ...(confirmationCardUpdate ? { confirmationCardUpdate } : {}),
    });
  }

  if (actionId === 'pages_repo_deep_dive') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个仓库问答不属于当前 Slack 用户，不能继续深挖。',
      });
    }
    const sessionMemory = (await store.getSessionMemory?.(session.id)) || {};
    const lastTurn = Array.isArray(sessionMemory.repoQuestionContext?.turns)
      ? sessionMemory.repoQuestionContext.turns.at(-1)
      : null;
    if (!lastTurn?.question) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话还没有可继续深挖的仓库问答。',
      });
    }
    runSlackBackground(env, async () => {
      try {
        const result = await answerRepoQuestion(env, {
          question: `继续深挖：${lastTurn.question}`,
          sessionMemory,
          deepDive: true,
        });
        const replyText = redactSecretLikeText(result.replyText);
        await updateSessionMemoryWithAssistantTurn(
          store,
          session,
          sessionMemory,
          { action: 'repo_question_deep_dive', text: lastTurn.question },
          {
            summary: sessionMemory.summary || lastTurn.question,
            lastAgentResponse: replyText,
            repoQuestionContext: nextRepoQuestionContext(sessionMemory.repoQuestionContext || {}, {
              ...result,
              replyText,
            }),
            conversationKind: 'repo_answer',
          },
          replyText
        );
        await postSlackInteractionThreadReply(env, body, session, replyText);
      } catch (err) {
        console.log(
          JSON.stringify({
            service: 'pages-gateway',
            message: 'slack_repo_deep_dive_failed',
            slackSessionId: session.id,
            error: err.message,
          })
        );
        await postSlackInteractionThreadReply(env, body, session, '继续深挖失败了，可以稍后重试或补充更具体的问题。');
      }
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '收到，我会继续深挖，稍后把结果发到当前对话。',
      action: 'repo_question_deep_dive_queued',
      accepted: true,
      slackSessionId: session.id,
    });
  }

  if (actionId === 'pages_repo_view_evidence') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个仓库问答不属于当前 Slack 用户，不能查看依据。',
      });
    }
    const sessionMemory = (await store.getSessionMemory?.(session.id)) || {};
    const replyText = redactSecretLikeText(repoEvidenceDetailsFromContext(sessionMemory));
    await updateSessionMemoryWithAssistantTurn(
      store,
      session,
      sessionMemory,
      { action: 'repo_question_view_evidence', text: '查看依据' },
      {
        summary: sessionMemory.summary || '查看仓库问答依据',
        lastAgentResponse: replyText,
        conversationKind: 'repo_evidence',
      },
      replyText
    );
    const threadReply = await postSlackInteractionThreadReply(env, body, session, replyText);
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '已把本轮依据片段发到当前对话。',
      action: 'repo_question_view_evidence',
      accepted: true,
      slackSessionId: session.id,
      ...(threadReply ? { threadReply } : {}),
    });
  }

  if (actionId === 'pages_repo_generate_plan') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个仓库问答不属于当前 Slack 用户，不能生成改造方案。',
      });
    }
    const sessionMemory = (await store.getSessionMemory?.(session.id)) || {};
    const lastTurn = Array.isArray(sessionMemory.repoQuestionContext?.turns)
      ? sessionMemory.repoQuestionContext.turns.at(-1)
      : null;
    if (!lastTurn?.question) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话还没有可生成方案的仓库问答。',
      });
    }
    runSlackBackground(env, async () => {
      try {
        const result = await answerRepoQuestion(env, {
          question: `生成改造方案：${lastTurn.question}`,
          sessionMemory,
          mode: 'implementation_plan',
          plan: true,
        });
        const replyText = redactSecretLikeText(result.replyText);
        const repoQuestionContext = nextRepoQuestionContext(sessionMemory.repoQuestionContext || {}, {
          ...result,
          replyText,
        });
        await updateSessionMemoryWithAssistantTurn(
          store,
          session,
          sessionMemory,
          { action: 'repo_question_generate_plan', text: lastTurn.question },
          {
            summary: sessionMemory.summary || lastTurn.question,
            lastAgentResponse: replyText,
            repoQuestionContext,
            conversationKind: 'repo_implementation_plan',
          },
          replyText
        );
        const blocks = repoQuestionActionBlocks(session, result, { allowCreateIssueAction: true });
        await postSlackInteractionThreadReply(env, body, session, replyText, { blocks });
      } catch (err) {
        console.log(
          JSON.stringify({
            service: 'pages-gateway',
            message: 'slack_repo_generate_plan_failed',
            slackSessionId: session.id,
            error: err.message,
          })
        );
        await postSlackInteractionThreadReply(env, body, session, '生成改造方案失败了，可以稍后重试或补充更具体的问题。');
      }
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '收到，我会生成改造方案，稍后发到当前对话。',
      action: 'repo_question_generate_plan_queued',
      accepted: true,
      slackSessionId: session.id,
    });
  }

  if (actionId === 'pages_repo_create_platform_issue') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个仓库问答不属于当前 Slack 用户，不能创建需求。',
      });
    }
    if (session.activeWorkItemId || session.activeJobId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话已经在处理中。继续回复修改意见即可。',
      });
    }
    const sessionMemory = (await store.getSessionMemory?.(session.id)) || {};
    const draft = platformDraftFromRepoQuestionContext(sessionMemory);
    if (!draft) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '当前会话还没有可转换的平台需求。',
      });
    }
    await updateSessionMemoryWithAssistantTurn(
      store,
      session,
      sessionMemory,
      { action: 'repo_question_platform_issue_draft', text: draft.summary || sessionMemory.summary || '' },
      {
        summary: redactSecretLikeText(draft.summary || sessionMemory.summary || ''),
        requirements: redactSlackAnalysis(draft),
        lastAgentResponse: slackPlatformIssueConfirmationText(draft),
        pendingQuestions: [],
        repoQuestionContext: sessionMemory.repoQuestionContext || {},
        conversationKind: 'confirmation_card',
      },
      slackPlatformIssueConfirmationText(draft)
    );
    const cardUpdate = await updateSlackInteractionMessage(env, body, session, {
      text: slackPlatformIssueConfirmationText(draft),
      blocks: slackPlatformIssueConfirmationBlocks(session, draft),
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '已整理成平台需求，请在卡片上确认后再创建 GitHub issue。',
      action: 'repo_question_platform_issue_draft',
      accepted: false,
      slackSessionId: session.id,
      ...(cardUpdate ? { cardUpdate } : {}),
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

    if (value.workItemKind === 'platform_dev') {
      const item = value.jobId ? await store.getPlatformDevItem(value.jobId) : null;
      if (!item || !slackJobVisibleToActor(item, body)) {
        return slackAckResponse({
          response_type: 'ephemeral',
          text: '这个平台需求不存在，或不属于当前 Slack 用户。',
        });
      }
      const activeItem = await store.patchPlatformDevItem(item.id, {
        slackSessionId: session.id,
        slackSessionKey: session.sessionKey,
      });
      if (!activeItem) {
        return slackAckResponse({
          response_type: 'ephemeral',
          text: '这个平台需求刚刚被更新或删除了，请重新打开任务列表后再选择。',
        });
      }
      await store.linkPlatformDevItemToSlackSession(activeItem, session);
      await notifySlackPlatformDevStatus(env, store, activeItem, {
        stage: activeItem.status,
        text: '已切换到这个平台需求。',
        statusText: ':white_check_mark: 已切换到这个需求。',
        skipDuplicate: false,
        slackSessionId: session.id,
      });
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '已切换到这个平台需求，继续在这个对话里补充即可。',
      });
    }

    let job = value.jobId ? await store.getJob(value.jobId) : null;
    if (!job || !slackJobVisibleToActor(job, body)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个发布任务不存在，或不属于当前 Slack 用户。',
      });
    }
    if (options.retireSitePublishing !== false) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: SITE_PUBLISHING_RETIRED_MESSAGE,
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

  if (actionId === 'pages_trigger_platform_auto_dev') {
    const value = parseSlackButtonValue(action.value);
    const itemId = value.workItemId || value.platformDevItemId || value.jobId || '';
    const session = value.sessionId ? await store.getSlackSession(value.sessionId) : null;
    const item = itemId ? await store.getPlatformDevItem(itemId) : null;
    const visibleToRequester = item ? slackJobVisibleToActor(item, body) : false;
    if (!item || !visibleToRequester) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求不存在，或不属于当前 Slack 用户。',
      });
    }
    if (session && (session.teamId !== teamId || session.primarySlackUserId !== slackUserId)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个确认操作不属于当前 Slack 用户。',
      });
    }
    if (item.autoDevStatus === 'triggered') {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求已经触发自动开发，正在继续处理。',
      });
    }
    if (!item.agentEligible) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求当前不能进入自动开发，请在 Issue 中继续人工处理。',
        platformDevItemId: item.id,
      });
    }
    const triggeredAt = new Date().toISOString();
    const triggerResult = store.triggerPlatformDevAutoDev
      ? await store.triggerPlatformDevAutoDev(item.id, {
          autoDevTriggeredBy: `slack:${teamId}:${slackUserId}`,
          autoDevTriggeredAt: triggeredAt,
          autoDevReason: item.autoDevReason || '用户手动触发自动开发。',
        })
      : {
          item: await store.patchPlatformDevItem(item.id, {
            autoDevStatus: 'triggered',
            autoDevTriggeredBy: `slack:${teamId}:${slackUserId}`,
            autoDevTriggeredAt: triggeredAt,
            autoDevReason: item.autoDevReason || '用户手动触发自动开发。',
          }),
          triggered: true,
          alreadyTriggered: false,
        };
    let approved = triggerResult?.item || null;
    if (triggerResult && !triggerResult.triggered) {
      if (triggerResult.alreadyTriggered) {
        return slackAckResponse({
          response_type: 'ephemeral',
          text: '这个平台需求已经触发自动开发，正在继续处理。',
          platformDevItemId: item.id,
        });
      }
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求当前无法触发自动开发，请刷新状态后重试。',
        platformDevItemId: item.id,
      });
    }
    if (!approved) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求已不存在，无法继续触发。',
        platformDevItemId: item.id,
      });
    }
    let workerStart = null;
    if (approved.status === 'auto_dev_pending') {
      approved = await store.updatePlatformDevItem(approved.id, 'agent_queued', {
        autoDevStatus: 'triggered',
        autoDevTriggeredBy: `slack:${teamId}:${slackUserId}`,
        autoDevTriggeredAt: triggeredAt,
        autoDevReason: approved.autoDevReason || '用户手动触发自动开发。',
      });
      if (!approved) {
        return slackAckResponse({
          response_type: 'ephemeral',
          text: '这个平台需求已不存在，无法继续触发。',
          platformDevItemId: item.id,
        });
      }
      workerStart = queueSlackWorkerStart(env, store, () => startWorkerForPlatformDevItemIfConfigured(approved, env), {
        workItemKind: 'platform_dev',
        platformDevItemId: approved.id,
      });
    } else if (approved.status !== 'received') {
      workerStart = queueSlackWorkerStart(env, store, () => startWorkerForPlatformDevItemIfConfigured(approved, env), {
        workItemKind: 'platform_dev',
        platformDevItemId: approved.id,
      });
    }
    await store.linkPlatformDevItemToSlackSession(approved, session || undefined);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, approved, {
      stage: approved.status,
      text:
        approved.status === 'received'
          ? '已手动触发自动开发，等待当前 issue 创建完成后继续。'
          : '已手动触发自动开发，正在进入后续处理。',
      statusText:
        approved.status === 'received'
          ? ':white_check_mark: 已触发，等待 issue 创建完成。'
          : ':white_check_mark: 已触发自动开发。',
      skipDuplicate: false,
      slackSessionId: session?.id || approved.slackSessionId || null,
    });
    const triggerCardUpdate = await updateInteractionAsHandled(env, body, session, {
      header: '自动开发已触发',
      text: '*处理结果*\n已触发自动开发，任务正在进入后续处理。',
      contextText: '后续进度会在当前对话更新。',
      links: [
        { text: '查看 Issue', url: approved.githubIssueUrl, actionId: 'open_issue' },
        { text: '查看 PR', url: approved.githubPrUrl, actionId: 'open_pr' },
      ],
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text:
        approved.status === 'received'
          ? '已触发，当前 issue 创建完成后会继续自动开发。'
          : workerStart?.started
            ? '已触发，自动开发已启动。'
            : '已触发，后续处理已排队。',
      platformDevItemId: approved.id,
      ...(workerStart ? { workerStart } : {}),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(triggerCardUpdate ? { triggerCardUpdate } : {}),
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

    let job =
      value.workItemKind === 'platform_dev' && value.jobId
        ? await store.getPlatformDevItem(value.jobId)
        : value.jobId
          ? await store.getJob(value.jobId)
          : null;
    if (job && value.workItemKind === 'platform_dev') {
      job = {
        ...job,
        workItemKind: 'platform_dev',
        issueNumber: job.githubIssueNumber,
        issueUrl: job.githubIssueUrl,
        prNumber: job.githubPrNumber,
        prUrl: job.githubPrUrl,
      };
    }
    if (!job || !slackJobVisibleToActor(job, body)) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text:
          value.workItemKind === 'platform_dev'
            ? '这个平台需求不存在，或不属于当前 Slack 用户。'
            : '这个发布任务不存在，或不属于当前 Slack 用户。',
      });
    }

    if (options.retireSitePublishing !== false && job.workItemKind !== 'platform_dev') {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: SITE_PUBLISHING_RETIRED_MESSAGE,
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

    let workerStart = null;
    let slackStatusNotification = null;
    if (job.workItemKind === 'platform_dev') {
      job = await restorePlatformDevItemForReopenedGithubResource(store, job, target, resource || {});
      await store.linkPlatformDevItemToSlackSession(job, session);
      workerStart = await startWorkerForPlatformDevItemIfConfigured(job, env);
      if (workerStart?.started === false) {
        job =
          (await failQueuedSlackWorkerStart(
            store,
            { workItemKind: 'platform_dev', platformDevItemId: job.id, slackSessionId: session.id },
            workerStart.error || 'Worker start failed'
          )) || job;
        slackStatusNotification = await notifyQueuedWorkerStartFailure(env, store, job, {
          workItemKind: 'platform_dev',
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
          text: `重新打开后启动处理失败：${workerStart.error || 'Worker start failed'}`,
          workItemKind: 'platform_dev',
          workItemId: job.id,
          workerStart,
          ...(slackStatusNotification ? { slackStatusNotification } : {}),
          ...(listUpdate ? { listUpdate } : {}),
        });
      }
      slackStatusNotification = await notifySlackPlatformDevStatus(env, store, job, {
        stage: job.status,
        text: target === 'pr' ? 'GitHub PR 已重新打开，任务已恢复。' : 'GitHub issue 已重新打开，任务已恢复。',
        statusText:
          target === 'pr'
            ? ':white_check_mark: GitHub PR 已重新打开，任务已恢复。'
            : ':white_check_mark: GitHub issue 已重新打开，任务已恢复。',
        skipDuplicate: false,
        dedupeKey: `slack-platform-reopen:${target}:${job.id}:${body.trigger_id || Date.now()}`,
        slackSessionId: session.id,
      });
    } else {
      job = await restoreJobForReopenedGithubResource(store, job, target, resource || {});
      await store.linkJobToSlackSession(job, session);
      workerStart = await startWorkerForJobIfConfigured(job, env);
      if (workerStart?.started === false) {
        job =
          (await failQueuedSlackWorkerStart(
            store,
            { workItemKind: 'site_publishing', publishingJobId: job.id, slackSessionId: session.id },
            workerStart.error || 'Worker start failed'
          )) || job;
        slackStatusNotification = await notifyQueuedWorkerStartFailure(env, store, job, {
          workItemKind: 'site_publishing',
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
          text: `重新打开后启动处理失败：${workerStart.error || 'Worker start failed'}`,
          jobId: job.id,
          workerStart,
          ...(slackStatusNotification ? { slackStatusNotification } : {}),
          ...(listUpdate ? { listUpdate } : {}),
        });
      }
      slackStatusNotification = await notifySlackJobStatus(env, store, job, {
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
    }
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
      ...(job.workItemKind === 'platform_dev' ? { workItemKind: 'platform_dev', workItemId: job.id } : {}),
      ...(workerStart ? { workerStart } : {}),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(listUpdate ? { listUpdate } : {}),
    });
  }

  if (actionId === 'pages_request_append_diagnosis') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个诊断操作不属于当前 Slack 用户。',
      });
    }
    const result = await handleSlackAppendDiagnosisCommentTool({
      store,
      body: {
        team: { id: teamId },
        user: { id: slackUserId },
        channel_id: body.channel?.id || body.container?.channel_id || null,
        thread_ts: body.message?.thread_ts || body.message?.ts || null,
      },
      env,
      intake: { action: 'append_diagnosis_comment', text: '追加诊断到 Issue' },
      slackSession: session,
      sessionMemory: (await store.getSessionMemory?.(session.id)) || {},
      agentRun: null,
      slackAgentAnalysis: null,
      retireSitePublishing: options.retireSitePublishing !== false,
      toolArgs: value,
    });
    const cardUpdate =
      result.action === 'append_diagnosis_comment'
        ? await updateInteractionAsHandled(env, body, session, {
            header: '诊断已追加',
            text: '*处理结果*\n已把本轮诊断追加到 Issue。',
            contextText: '后续可以继续在当前对话补充问题。',
            links: linksForWorkItem(result.workItem),
          })
        : null;
    return slackAckResponse({
      response_type: 'ephemeral',
      text: result.replyText,
      ...result,
      ...(cardUpdate ? { cardUpdate } : {}),
    });
  }

  if (actionId === 'pages_request_retry_work_item') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个重试操作不属于当前 Slack 用户。',
      });
    }
    const result = await handleSlackRetryWorkItemTool({
      store,
      body: {
        team: { id: teamId },
        user: { id: slackUserId },
        channel_id: body.channel?.id || body.container?.channel_id || null,
        thread_ts: body.message?.thread_ts || body.message?.ts || null,
      },
      env,
      intake: { action: 'retry_work_item', text: '重试当前任务' },
      slackSession: session,
      sessionMemory: (await store.getSessionMemory?.(session.id)) || {},
      agentRun: null,
      slackAgentAnalysis: null,
      retireSitePublishing: options.retireSitePublishing !== false,
      toolArgs: value,
    });
    const cardUpdate =
      result.action === 'retry_work_item'
        ? await updateInteractionAsHandled(env, body, session, {
            header: '已请求重试',
            text: '*处理结果*\n已请求重新处理这个任务。',
            contextText: '后续进度会在当前对话更新。',
            links: linksForWorkItem(result.workItem),
          })
        : null;
    return slackAckResponse({
      response_type: 'ephemeral',
      text: result.replyText,
      ...result,
      ...(cardUpdate ? { cardUpdate } : {}),
    });
  }

  if (actionId === 'pages_request_human_triage') {
    const value = parseSlackButtonValue(action.value);
    const session = await store.getSlackSession(value.sessionId || '');
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个人工排查操作不属于当前 Slack 用户。',
      });
    }
    const result = await handleSlackHumanTriageTool({
      store,
      body: {
        team: { id: teamId },
        user: { id: slackUserId },
        channel_id: body.channel?.id || body.container?.channel_id || null,
        thread_ts: body.message?.thread_ts || body.message?.ts || null,
      },
      env,
      intake: { action: 'human_triage', text: '转人工排查' },
      slackSession: session,
      sessionMemory: (await store.getSessionMemory?.(session.id)) || {},
      agentRun: null,
      slackAgentAnalysis: null,
      retireSitePublishing: options.retireSitePublishing !== false,
      toolArgs: value,
    });
    const cardUpdate =
      result.action === 'human_triage'
        ? await updateInteractionAsHandled(env, body, session, {
            header: '已请求人工排查',
            text: '*处理结果*\n已记录人工排查请求。',
            contextText: '需要补充信息时，可以继续在当前对话回复。',
            links: linksForWorkItem(result.workItem),
          })
        : null;
    return slackAckResponse({
      response_type: 'ephemeral',
      text: result.replyText,
      ...result,
      ...(cardUpdate ? { cardUpdate } : {}),
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
    const activeWorkItem = await activeWorkItemForSlackSession(store, session);
    await store.closeSlackSession(session.id);
    await postSlackInteractionThreadReply(env, body, session, '已关闭当前会话。继续发新需求会开启新任务。');
    const closeCardUpdate = await updateInteractionAsHandled(env, body, session, {
      header: '会话已关闭',
      text: '*处理结果*\n当前会话已关闭。',
      contextText: '继续发新需求会开启新任务。',
      links: linksForWorkItem(activeWorkItem),
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '已关闭当前会话。继续发新需求会开启新任务。',
      ...(closeCardUpdate ? { closeCardUpdate } : {}),
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
    const platformDraft = hasConfirmablePlatformDraft(slackAgentAnalysis);
    const platformSession =
      session.activeWorkItemKind === 'platform_dev' ||
      (!session.activeWorkItemKind && Boolean(session.activeWorkItemId && !session.activeJobId));
    if (options.retireSitePublishing !== false && !platformDraft && !platformSession) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: SITE_PUBLISHING_RETIRED_MESSAGE,
      });
    }
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
