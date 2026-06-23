import { jsonResponse } from '@xd/worker-kit';
import { createIssueComment } from '@xd/git-client';

import {
  parseGithubWebhookBody,
  verifyGithubWebhookSignature,
} from '../github/webhook.js';
import {
  isAllowedReviewAgent,
  isAllowedSiteCheckRun,
  normalizeReviewAgentWebhook,
  normalizeSiteCheckRunWebhook,
} from '../github/review.js';
import {
  dispatchPreviewFromStoredReviewIfReady,
  listReviewReconcileCandidateJobs,
  reconcileReviewGateForJob,
} from '../github/review-gate.js';
import { handleGithubReviewAgentWebhook } from '../github/review-webhooks.js';
import {
  handleGithubIssueWebhook,
  handleGithubPullRequestWebhook,
} from '../github/resource-webhooks.js';
import { handleGithubSiteCheckWebhook } from '../github/site-check-webhooks.js';
import {
  reconcileClosedGithubIssueForJob,
  reopenGithubResourceForJob,
  restoreJobForReopenedGithubResource,
  restorePlatformDevItemForReopenedGithubResource,
} from '../github/resource-reconciler.js';
import { readJson } from '../http/body.js';
import { getStore, required, verifyInternalCallbackToken } from './context.js';
import { dispatchPlatformDevFixIfNeeded, dispatchQueuedPlatformDevFollowupIfNeeded } from '../platform-dev/automation.js';
import { applyExecutorCallback, CALLBACK_STAGE_RESULTS } from '../publishing/callback-rules.js';
import { startWorkerForJobIfConfigured, startWorkerForPlatformDevItemIfConfigured } from '../publishing/worker-dispatcher.js';
import { readSlackRequest, slackAckResponse, slackChallengeResponse } from '../slack/http.js';
import {
  classifySlackIntake,
  isUnsupportedBulkDestructiveRequest,
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
import { slackAgentToolArgs, slackAgentToolName, slackAgentWorkItemState } from '../slack/agent-tool-call.js';
import {
  completeSlackAgentRun,
  failRunningSlackAgentRunsForClosedSession,
  redactSlackAnalysis,
  slackAgentRunModelPatch,
} from '../slack/agent-run-records.js';
import { activateJobForSlackSession } from '../slack/job-binding.js';
import { selectSlackSession, slackActorFromBody, slackUserIdFromBody, surfaceForSlackBody } from '../slack/session.js';
import { redactSecretLikeText } from '../slack/text.js';
import {
  buildSlackWorkItemDiagnosis,
  buildSlackWorkItemDiagnosisBlocks,
  buildSlackWorkItemDiagnosisIssueComment,
  buildSlackWorkItemHumanTriageIssueComment,
} from '../slack/diagnostics.js';
import { slackJobInput } from '../slack/job-input.js';
import {
  confirmedSlackJobBodyFromInteraction,
  draftAnalysisFromMemory,
  hasConfirmableDraft,
  slackIssueConfirmationBlocks,
  slackIssueConfirmationText,
  slackIssueConfirmedBlocks,
  slackIssueConfirmedText,
  confirmedSlackPlatformBodyFromInteraction,
  slackIssueWaitingMoreBlocks,
  slackIssueWaitingMoreText,
  hasConfirmablePlatformDraft,
  slackPlatformIssueConfirmationBlocks,
  slackPlatformIssueConfirmationText,
  slackPlatformIssueConfirmedBlocks,
  slackPlatformIssueConfirmedText,
} from '../slack/issue-confirmation.js';
import {
  CREATE_PLATFORM_INTENTS,
  CREATE_JOB_INTENTS,
  FOLLOWUP_INTENTS,
  LIST_WORK_ITEM_INTENTS,
  NON_FOLLOWUP_ACTIONS,
  SWITCH_WORK_ITEM_INTENTS,
  UNSUPPORTED_DESTRUCTIVE_INTENTS,
} from '../slack/intents.js';
import { platformDevInput } from '../slack/platform-input.js';
import { notifySlackPlatformDevStatus, platformNotificationText } from '../slack/platform-notifier.js';
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
  unsupportedDestructiveRequestReply,
} from '../slack/work-items.js';
import {
  activeWorkItemForSlackSession,
  dispatchQueuedFollowupFixIfNeeded,
  handleSlackFollowup,
} from '../slack/followup.js';
import {
  handleSlackListWorkItemsTool,
  handleSlackReopenWorkItemTool,
  handleSlackSwitchWorkItemTool,
} from '../slack/work-item-tools.js';

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
  if (
    [
      'diagnose_work_item',
      'get_work_item_timeline',
      'explain_work_item_blocker',
      'get_workflow_status',
      'append_diagnosis_comment',
      'retry_work_item',
      'human_triage',
    ].includes(slackAgentAnalysis.intent)
  ) {
    return { name: 'diagnose_current_work_item', args: {} };
  }
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
  if (shouldAskBeforeCreatingPlatformIssue(intake, slackAgentAnalysis, slackSession)) {
    return { name: 'confirm_platform_issue', args: {} };
  }
  return null;
}

function hasActiveSlackTarget(slackSession) {
  return Boolean(
    slackSession?.activeJobId ||
      slackSession?.activeWorkItemId ||
      slackSession?.activeIssueNumber ||
      slackSession?.activePrNumber ||
      slackSession?.activePreviewUrl
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

function isPlatformDevAnalysis(slackAgentAnalysis = {}) {
  const lane = String(slackAgentAnalysis?.lane || '').replace('_', '-');
  return lane === 'platform-dev' || CREATE_PLATFORM_INTENTS.has(slackAgentAnalysis?.intent);
}

function shouldCreatePlatformDevItem(intake, slackAgentAnalysis) {
  if (!slackAgentAnalysis) return false;
  if (slackAgentAnalysis.needsClarification) return false;
  return isPlatformDevAnalysis(slackAgentAnalysis) && CREATE_PLATFORM_INTENTS.has(slackAgentAnalysis.intent);
}

function shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis, slackSession) {
  if (!slackAgentAnalysis || slackAgentAnalysis.needsClarification) return false;
  if (isPlatformDevAnalysis(slackAgentAnalysis)) return false;
  if (!CREATE_JOB_INTENTS.has(slackAgentAnalysis.intent)) return false;
  if (intake.command) return false;
  if (!['agent_turn', 'create_job'].includes(intake.action)) return false;
  if (hasActiveSlackTarget(slackSession)) return false;
  return true;
}

function shouldAskBeforeCreatingPlatformIssue(intake, slackAgentAnalysis, slackSession) {
  if (!slackAgentAnalysis || slackAgentAnalysis.needsClarification) return false;
  if (!shouldCreatePlatformDevItem(intake, slackAgentAnalysis)) return false;
  if (intake.command) return false;
  if (!['agent_turn', 'create_platform_issue'].includes(intake.action)) return false;
  if (hasActiveSlackTarget(slackSession)) return false;
  return true;
}

async function handleSlackAgentToolCall(context) {
  const { intake, slackAgentAnalysis, slackSession } = context;
  const toolCall = context.toolCall || slackAgentToolCallForTurn(intake, slackAgentAnalysis, slackSession);
  if (!toolCall?.name) return null;
  if (
    slackAgentAnalysis?.needsClarification &&
    ['confirm_create_issue', 'confirm_platform_issue', 'record_followup', 'switch_work_item', 'reopen_work_item'].includes(
      toolCall.name
    )
  ) {
    return null;
  }

  switch (toolCall.name) {
    case 'close_session':
      return handleCloseSlackSession(context);
    case 'get_current_status':
    case 'diagnose_current_work_item':
    case 'request_retry_work_item':
    case 'request_append_diagnosis_comment':
    case 'request_human_triage':
      return handleSlackWorkItemDiagnosisTool({ ...context, toolArgs: toolCall.args || {} });
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
    case 'confirm_platform_issue':
      return handleSlackAgentNonPublishingTurn({
        ...context,
        action: 'confirm_before_platform_issue',
        replyText: slackPlatformIssueConfirmationText(slackAgentAnalysis),
        blocks: slackPlatformIssueConfirmationBlocks(slackSession, slackAgentAnalysis),
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

  if (intake.action === 'status' || intake.action === 'diagnose_work_item') {
    return respond(
      await handleSlackWorkItemDiagnosisTool({
        store,
        body,
        env,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis: null,
        toolArgs: { jobId: intake.jobId },
      })
    );
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

    if (shouldAskBeforeCreatingPlatformIssue(intake, slackAgentAnalysis, slackSession)) {
      return respond(
        handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: 'confirm_before_platform_issue',
          replyText: slackPlatformIssueConfirmationText(slackAgentAnalysis),
          blocks: slackPlatformIssueConfirmationBlocks(slackSession, slackAgentAnalysis),
          preferReplyText: true,
        })
      );
    }

    if (shouldCreatePlatformDevItem(intake, slackAgentAnalysis)) {
      const redactedIntake = { ...intake, text: redactSecretLikeText(intake.text) };
      const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
      await store.updateSessionMemory(slackSession.id, {
        summary: redactedSlackAgentAnalysis?.summary || redactedIntake.text,
        requirements: redactedSlackAgentAnalysis || { text: redactedIntake.text, action: redactedIntake.action },
        lastAgentResponse: null,
        pendingQuestions: [],
      });
      const requesterProfile = await fetchSlackRequesterProfile(env, body);
      const { item, created } = await store.createPlatformDevItem(
        platformDevInput({
          ...body,
          intake: redactedIntake,
          slackAgentAnalysis: redactedSlackAgentAnalysis,
          slackSession,
          requesterProfile,
        })
      );
      const workItemLink = await store.linkPlatformDevItemToSlackSession(item, slackSession);
      const initialStage = item.requiresHumanGate ? 'gate_pending' : 'received';
      const slackStatusNotification = created
        ? await notifySlackPlatformDevStatus(env, store, item, {
            stage: initialStage,
            text: item.requiresHumanGate ? '平台需求已记录，等待人工确认。' : '平台需求已进入处理队列。',
            statusText: item.requiresHumanGate
              ? ':hourglass_flowing_sand: 已记录，等待人工确认。'
              : ':hourglass_flowing_sand: 正在创建 GitHub issue...',
          })
        : null;
      const workerStart = created ? await startWorkerForPlatformDevItemIfConfigured(item, env) : null;
      await completeSlackAgentRun(store, agentRun, {
        workItemKind: 'platform_dev',
        workItemId: item.id,
        ...slackAgentRunModelPatch(slackAgentAnalysis),
        report: {
          action: 'create_platform_issue',
          accepted: true,
          slackAgentUsed: Boolean(slackAgentAnalysis),
          intent: slackAgentAnalysis?.intent || null,
          modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
        },
      });
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_platform_dev_item_created',
          itemId: item.id,
          created,
          slackSessionId: slackSession.id,
          workerStarted: workerStart?.started ?? null,
          workerError: workerStart?.error || null,
        })
      );
      return respond({
        ok: true,
        action: 'create_platform_issue',
        accepted: true,
        platformDevItemId: item.id,
        workItemKind: 'platform_dev',
        workItemId: item.id,
        slackSessionId: slackSession.id,
        agentRunId: agentRun?.id,
        workItemLink,
        created,
        ...(slackStatusNotification ? { slackStatusNotification } : {}),
        ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
        ...(workerStart ? { workerStart } : {}),
      });
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

async function eventsForWorkItem(store, item = {}) {
  if (!item?.id) return [];
  if (item.workItemKind === 'platform_dev') {
    return store.listPlatformDevEvents ? await store.listPlatformDevEvents(item.id) : [];
  }
  return store.listEvents ? await store.listEvents(item.id) : [];
}

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

async function workItemForDiagnosis(store, body, slackSession, toolArgs = {}) {
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

function githubWriteConfigForSlackDiagnosis(env = {}) {
  const token = env.GITHUB_APP_INSTALLATION_TOKEN || env.GITHUB_TOKEN;
  const repoFullName = env.GITHUB_REPO || env.GITHUB_REPOSITORY;
  if (!token || !repoFullName) return null;
  return {
    apiBaseUrl: env.GITHUB_ENTERPRISE_API_BASE_URL || env.GITHUB_API_BASE_URL || 'https://api.github.com',
    token,
    repoFullName,
  };
}

function issueNumberForWorkItem(item = {}) {
  return item.issueNumber || item.githubIssueNumber || null;
}

async function createSlackWorkItemIssueComment(env, item, body, logMessage) {
  const issueNumber = issueNumberForWorkItem(item);
  if (!issueNumber) return { skipped: true, reason: 'missing_issue' };
  const config = githubWriteConfigForSlackDiagnosis(env);
  if (!config) return { skipped: true, reason: 'github_not_configured' };

  try {
    const comment = await createIssueComment(
      env.GITHUB_FETCH || env.GITHUB_STATUS_FETCH || fetch,
      config,
      issueNumber,
      body
    );
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

async function appendSlackDiagnosisIssueComment(env, item, events = []) {
  return createSlackWorkItemIssueComment(
    env,
    item,
    buildSlackWorkItemDiagnosisIssueComment(item, { events }),
    'slack_diagnosis_issue_comment_failed'
  );
}

async function appendSlackHumanTriageIssueComment(env, item, events = []) {
  return createSlackWorkItemIssueComment(
    env,
    item,
    buildSlackWorkItemHumanTriageIssueComment(item, { events }),
    'slack_human_triage_issue_comment_failed'
  );
}

function appendDiagnosisReplyText(result = {}) {
  if (result.ok) return `已把诊断摘要追加到 Issue #${result.issueNumber}。`;
  if (result.skipped && result.reason === 'missing_issue') return '当前任务还没有关联 Issue，暂时不能追加诊断。';
  if (result.skipped && result.reason === 'github_not_configured') return '诊断摘要已生成，但 GitHub 写入暂未配置，不能追加到 Issue。';
  if (result.ok === false) return `追加诊断失败：${result.error}`;
  return '诊断摘要暂时不能追加到 Issue。';
}

function humanTriageReplyText(result = {}) {
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

async function recordHumanTriageRequest(store, item = {}, slackSession = null) {
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

async function retrySitePublishingWorkItem(store, env, item = {}, slackSession = null) {
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

async function retrySlackWorkItem(store, env, item = {}, slackSession = null) {
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
  return retrySitePublishingWorkItem(store, env, item, slackSession);
}

function retryWorkItemReplyText(result = {}) {
  if (result.retried) return '已重新触发处理流程。我会继续在当前对话更新进度。';
  if (result.reason === 'not_dispatchable' || result.reason === 'not_retryable') {
    return '当前阶段不能直接重试。可以查看 Issue / PR 后补充修复要求，或转人工排查。';
  }
  if (result.reason === 'fix_attempts_exhausted') return '自动修复次数已达到上限，需要人工查看 Issue / PR 后再继续。';
  if (result.reason) return `重试暂未启动：${result.reason}`;
  return '重试暂未启动，请稍后再试或转人工排查。';
}

async function handleSlackWorkItemDiagnosisTool({
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
  const resolved = await workItemForDiagnosis(store, body, slackSession, toolArgs);
  if (resolved.forbidden) {
    await completeSlackAgentRun(store, agentRun, {
      report: { action: 'diagnose_work_item', accepted: false, forbidden: true, jobId: toolArgs.jobId || null },
    });
    return {
      ok: true,
      action: 'diagnose_work_item_forbidden',
      accepted: false,
      replyText: '这个任务不属于当前 Slack 用户，不能查看诊断结果。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
    };
  }

  let item = resolved.item;
  if (item && item.workItemKind !== 'platform_dev') {
    item = await reconcileClosedGithubIssueForJob(store, env, item, { notifySlack: true });
  }
  if (!item) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: { action: 'diagnose_work_item', accepted: false, reason: 'not_found' },
    });
    return {
      ok: true,
      action: 'diagnose_work_item_not_found',
      accepted: false,
      replyText: '我还没有在当前会话里找到可诊断的任务。可以先说「我的任务」查看任务列表。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  const events = await eventsForWorkItem(store, item);
  const replyText = buildSlackWorkItemDiagnosis(item, { events });
  const blocks = buildSlackWorkItemDiagnosisBlocks(slackSession, item, { events });
  if (slackSession?.id && store.updateSessionMemory) {
    await store.updateSessionMemory(slackSession.id, {
      summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
      lastAgentResponse: replyText,
    });
  }
  await completeSlackAgentRun(store, agentRun, {
    ...(item.workItemKind === 'platform_dev'
      ? { workItemKind: 'platform_dev', workItemId: item.id }
      : { publishingJobId: item.id }),
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'diagnose_work_item',
      accepted: false,
      intent: slackAgentAnalysis?.intent || intake.action,
      status: item.status,
      eventCount: events.length,
    },
  });
  return {
    ok: true,
    action: 'diagnose_work_item',
    accepted: false,
    replyText,
    blocks,
    ...(item.workItemKind === 'platform_dev' ? { workItemKind: 'platform_dev', workItemId: item.id } : { jobId: item.id }),
    slackSessionId: slackSession?.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

async function handleSlackAppendDiagnosisCommentTool({
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
  const appendResult = await appendSlackDiagnosisIssueComment(env, item, events);
  const replyText = appendDiagnosisReplyText(appendResult);
  if (slackSession?.id && store.updateSessionMemory) {
    await store.updateSessionMemory(slackSession.id, {
      summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
      lastAgentResponse: replyText,
    });
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
    appendDiagnosis: appendResult,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

async function handleSlackHumanTriageTool({
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
  const triageEvent = await recordHumanTriageRequest(store, item, slackSession);
  const issueComment = await appendSlackHumanTriageIssueComment(env, item, events);
  const result = { triageEvent, issueComment };
  const replyText = humanTriageReplyText(result);
  if (slackSession?.id && store.updateSessionMemory) {
    await store.updateSessionMemory(slackSession.id, {
      summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
      lastAgentResponse: replyText,
    });
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
    humanTriage: result,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

async function handleSlackRetryWorkItemTool({
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
  if (item && item.workItemKind !== 'platform_dev') {
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

  const retryResult = await retrySlackWorkItem(store, env, item, slackSession);
  const replyText = retryWorkItemReplyText(retryResult);
  if (slackSession?.id && store.updateSessionMemory) {
    await store.updateSessionMemory(slackSession.id, {
      summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
      lastAgentResponse: replyText,
    });
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
    retry: retryResult,
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
    await store.updateSessionMemory(session.id, {
      summary: redactSecretLikeText(slackAgentAnalysis.summary || sessionMemory.summary),
      requirements: redactSlackAnalysis({ ...slackAgentAnalysis, lane: 'platform-dev' }),
      lastAgentResponse: '已确认创建平台需求。',
      pendingQuestions: [],
    });

    const initialStage = item.requiresHumanGate ? 'gate_pending' : 'received';
    const slackStatusNotification = created
      ? await notifySlackPlatformDevStatus(env, store, item, {
          stage: initialStage,
          text: item.requiresHumanGate ? '平台需求已确认，等待人工确认。' : '平台需求已确认，正在创建 GitHub issue。',
          statusText: item.requiresHumanGate
            ? ':hourglass_flowing_sand: 已确认，等待人工确认。'
            : ':hourglass_flowing_sand: 已确认，正在创建 GitHub issue...',
          skipDuplicate: false,
        })
      : null;
    const workerStart = created ? await startWorkerForPlatformDevItemIfConfigured(item, env) : null;
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

  if (actionId === 'pages_approve_platform_gate' || actionId === 'pages_reject_platform_gate') {
    const value = parseSlackButtonValue(action.value);
    const itemId = value.workItemId || value.platformDevItemId || value.jobId || '';
    const session = value.sessionId ? await store.getSlackSession(value.sessionId) : null;
    const item = itemId ? await store.getPlatformDevItem(itemId) : null;
    if (!item || !slackJobVisibleToActor(item, body)) {
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
    if (!item.requiresHumanGate) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求不需要人工确认。',
      });
    }
    if (item.gateStatus === 'approved' && actionId === 'pages_approve_platform_gate') {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求已经批准，正在继续处理。',
      });
    }
    if (['rejected', 'cancelled', 'expired'].includes(item.gateStatus || '')) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个平台需求的人工确认已经结束，不能重复操作。',
      });
    }

    const gateType = value.gateType || 'risk';
    if (actionId === 'pages_reject_platform_gate') {
      const gate = store.decideWorkItemGate
        ? await store.decideWorkItemGate('platform_dev', item.id, gateType, {
            status: 'rejected',
            decidedBy: `slack:${teamId}:${slackUserId}`,
            reason: item.gateReason || '人工拒绝自动开发。',
          })
        : null;
      const rejected = await store.updatePlatformDevItem(item.id, 'closed_unmerged', {
        gateStatus: 'rejected',
        gateReason: item.gateReason || '人工拒绝自动开发。',
      });
      await store.linkPlatformDevItemToSlackSession(rejected, session || undefined);
      const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, rejected, {
        stage: 'closed_unmerged',
        text: '人工确认未通过，这个需求不会进入自动开发。',
        statusText: ':white_check_mark: 已停止自动开发。',
        skipDuplicate: false,
        slackSessionId: session?.id || rejected.slackSessionId || null,
      });
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '已记录：这个平台需求不会进入自动开发。',
        gate,
        platformDevItemId: rejected.id,
        ...(slackStatusNotification ? { slackStatusNotification } : {}),
      });
    }

    const gate = store.decideWorkItemGate
      ? await store.decideWorkItemGate('platform_dev', item.id, gateType, {
          status: 'approved',
          decidedBy: `slack:${teamId}:${slackUserId}`,
          reason: item.gateReason || '人工批准自动开发。',
        })
      : null;
    let approved = await store.patchPlatformDevItem(item.id, {
      gateStatus: 'approved',
      gateReason: item.gateReason || '人工批准自动开发。',
    });
    if (approved.status === 'gate_pending') {
      approved = await store.updatePlatformDevItem(approved.id, 'agent_queued', {
        gateStatus: 'approved',
        gateReason: approved.gateReason,
      });
    }
    await store.linkPlatformDevItemToSlackSession(approved, session || undefined);
    const workerStart = await startWorkerForPlatformDevItemIfConfigured(approved, env);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, approved, {
      stage: approved.status,
      text: '人工确认已通过，正在进入后续处理。',
      statusText: ':white_check_mark: 已批准自动开发。',
      skipDuplicate: false,
      slackSessionId: session?.id || approved.slackSessionId || null,
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: workerStart?.started ? '已批准，自动开发已启动。' : '已批准，后续处理已排队。',
      gate,
      platformDevItemId: approved.id,
      ...(workerStart ? { workerStart } : {}),
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
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
        text: value.workItemKind === 'platform_dev' ? '这个平台需求不存在，或不属于当前 Slack 用户。' : '这个发布任务不存在，或不属于当前 Slack 用户。',
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
      toolArgs: value,
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: result.replyText,
      ...result,
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
      toolArgs: value,
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: result.replyText,
      ...result,
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
      toolArgs: value,
    });
    return slackAckResponse({
      response_type: 'ephemeral',
      text: result.replyText,
      ...result,
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
  if ((body.workItemKind || body.work_item_kind) === 'platform_dev' || body.platformDevItemId || body.platform_dev_item_id) {
    return handlePlatformDevExecutorCallback(body, env);
  }

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

const PLATFORM_CALLBACK_STATUS = {
  issue_created: 'issue_created',
  gate_pending: 'gate_pending',
  agent_queued: 'agent_queued',
  agent_running: 'agent_running',
  branch_committed: 'branch_committed',
  pr_created: 'pr_created',
  ci_running: 'ci_running',
  ci_failed: 'ci_failed',
  review_waiting: 'review_waiting',
  review_blocked: 'review_blocked',
  ready_to_merge: 'ready_to_merge',
  merged: 'merged',
  closed_unmerged: 'closed_unmerged',
};

function platformDevPatchFromCallback(body = {}) {
  return {
    githubIssueNumber: body.issueNumber || body.issue_number || body.githubIssueNumber || body.github_issue_number || undefined,
    githubIssueUrl: body.issueUrl || body.issue_url || body.githubIssueUrl || body.github_issue_url || undefined,
    githubPrNumber: body.prNumber || body.pr_number || body.githubPrNumber || body.github_pr_number || undefined,
    githubPrUrl: body.prUrl || body.pr_url || body.githubPrUrl || body.github_pr_url || undefined,
    branchName: body.branchName || body.branch_name || undefined,
    headSha: body.headSha || body.head_sha || undefined,
    errorCode: body.errorCode || body.error_code || undefined,
    errorMessage: body.errorMessage || body.error_message || undefined,
  };
}

function compactPatch(patch = {}) {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

async function handlePlatformDevExecutorCallback(body, env) {
  const store = getStore(env);
  const itemId = required(
    body.platformDevItemId || body.platform_dev_item_id || body.workItemId || body.work_item_id,
    'platformDevItemId'
  );

  if (body.status === 'failed') {
    const item = await store.failPlatformDevItem(
      itemId,
      body.errorCode || body.error_code,
      body.errorMessage || body.error_message
    );
    if (!item) return jsonResponse({ error: 'PlatformDevItem not found' }, 404);
    await store.linkPlatformDevItemToSlackSession(item);
    const slackStatusNotification = await notifySlackPlatformDevStatus(env, store, item, {
      stage: 'failed',
      text: item.errorMessage || item.errorCode || '平台需求处理失败',
      statusText: ':x: 平台需求处理失败',
      skipDuplicate: false,
    });
    return jsonResponse({
      item,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
    });
  }

  const stageResult = required(body.stageResult || body.stage_result, 'stageResult');
  const status = PLATFORM_CALLBACK_STATUS[stageResult];
  if (!status) return jsonResponse({ error: 'Unsupported platform stageResult', stageResult }, 400);

  let item = await store.getPlatformDevItem(itemId);
  if (!item) return jsonResponse({ error: 'PlatformDevItem not found' }, 404);

  const patch = compactPatch(platformDevPatchFromCallback(body));
  if (item.status === status) {
    item = await store.patchPlatformDevItem(item.id, patch);
  } else {
    item = await store.updatePlatformDevItem(item.id, status, patch);
  }
  await store.linkPlatformDevItemToSlackSession(item);
  const queuedFollowupRerun =
    ['pr_created', 'ci_failed', 'review_blocked', 'ready_to_merge'].includes(status)
      ? await dispatchQueuedPlatformDevFollowupIfNeeded(store, item, env)
      : null;
  if (queuedFollowupRerun?.item) item = queuedFollowupRerun.item;
  const slackStatusNotification = queuedFollowupRerun?.slackStatusNotification
    ? queuedFollowupRerun.slackStatusNotification
    : await notifySlackPlatformDevStatus(env, store, item, {
    stage: stageResult,
    text: platformNotificationText(stageResult, item) || `平台需求进入：${item.status}`,
    skipDuplicate: false,
      });

  return jsonResponse({
    item,
    ...(queuedFollowupRerun
      ? {
          queuedFollowupRerun: {
            skipped: queuedFollowupRerun.skipped || false,
            reason: queuedFollowupRerun.reason || null,
            workerStarted: queuedFollowupRerun.workerStart?.started ?? null,
          },
        }
      : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
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

  return handleGithubReviewAgentWebhook({ normalized, repoFullName, store, env, result });
}
