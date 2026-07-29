import { jsonResponse } from '@xd/worker-kit';
import { reconcileClosedGithubIssueForJob } from '../github/resource-reconciler.js';
import { diagnoseGithubActionsForWorkItem } from '../github/actions-diagnostics.js';
import { getStore } from './context.js';
import { startWorkerForJobIfConfigured, startWorkerForPlatformDevItemIfConfigured } from '../publishing/worker-dispatcher.js';
import { readSlackRequest, slackAckResponse, slackChallengeResponse } from '../slack/http.js';
import { classifySlackIntake } from '../slack/intake.js';
import { notifySlackJobStatus } from '../slack/notifier.js';
import { addWorkingReactionForSlackEvent, fetchSlackRequesterProfile, ignoredSlackEventReason, postSlackResultReply, runSlackBackground, settleImmediateSlackReaction, shouldProcessSlackEventsAsync, slackDeliveryContextFromBody, slackDeliveryPatchForResult, slackEventId, slackReactionPayloadFromResult, updateSlackDeliveryReactionState } from '../slack/delivery.js';
import { runSlackAgentTurnIfConfigured, slackAgentEndpointConfigured, updateSlackAgentReplyMessage } from '../slack/agent-turn.js';
import { buildConversationContext, repeatPreviousMessageFromContext } from '../slack/conversation-context.js';
import { slackAgentCapability, slackAgentExplicitToolName, slackAgentToolArgs, slackAgentWorkItemState } from '../slack/agent-tool-call.js';
import { completeSlackAgentRun, failRunningSlackAgentRunsForClosedSession, redactSlackAnalysis, slackAgentRunModelPatch } from '../slack/agent-run-records.js';
import { selectSlackSession, slackActorFromBody, surfaceForSlackBody } from '../slack/session.js';
import { redactSecretLikeText } from '../slack/text.js';
import { buildSlackWorkItemDiagnosis, buildSlackWorkItemDiagnosisBlocks } from '../slack/diagnostics.js';
import { slackJobInput } from '../slack/job-input.js';
import { slackIssueConfirmationBlocks, slackIssueConfirmationText, slackPlatformIssueConfirmationBlocks, slackPlatformIssueConfirmationText } from '../slack/issue-confirmation.js';
import { CREATE_PLATFORM_INTENTS, CREATE_JOB_INTENTS, FOLLOWUP_INTENTS, LIST_WORK_ITEM_INTENTS, NON_FOLLOWUP_ACTIONS, SWITCH_WORK_ITEM_INTENTS, UNSUPPORTED_DESTRUCTIVE_INTENTS } from '../slack/intents.js';
import { platformDevInput } from '../slack/platform-input.js';
import { notifySlackPlatformDevStatus } from '../slack/platform-notifier.js';
import { unsupportedDestructiveRequestReply } from '../slack/work-items.js';
import { activeWorkItemForSlackSession, handleSlackFollowup } from '../slack/followup.js';
import { buildReviewResultsSummary, buildSlackReviewResultsBlocks, formatSlackReviewResultsText, resolveReviewResultsTarget, reviewResultsMemory } from '../slack/review-results.js';
import { handleSlackListWorkItemsTool, handleSlackReopenWorkItemTool, handleSlackSwitchWorkItemTool } from '../slack/work-item-tools.js';
import { answerRepoQuestion, nextRepoQuestionContext, repoQuestionActionBlocks } from '../slack/repo-question.js';
import { eventsForWorkItem, failQueuedSlackWorkerStart, notifyQueuedWorkerStartFailure, queueSlackWorkerStart, updateSessionMemoryWithAssistantTurn, workItemForDiagnosis } from './shared.js';

const LOCAL_FOLLOWUP_CUE_RE =
  /(?:这个|那个|刚才|当前|接着|继续|续上|改为|改成|换成|不再|不要再|补充|追加|调整|修改|修复|再加|再补|再改)/i;

const EXPLICIT_NEW_WORK_ITEM_RE = /(?:新建|创建|另开|新开|另外|新的).*(?:issue|需求|任务)|(?:另开一个|新开一个)/i;

const TERMINAL_SLACK_DELIVERY_STATUSES = new Set(['processed', 'ignored']);

function shouldRetryRecordedSlackDelivery(delivery = {}) {
  return !TERMINAL_SLACK_DELIVERY_STATUSES.has(delivery.processingStatus || 'received');
}

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

function hasSlackFollowupTarget(slackSession, activeWorkItem = null) {
  return hasActiveSlackTarget(slackSession) || Boolean(activeWorkItem?.id);
}

function shouldForceSlackFollowup(intake, slackAgentAnalysis, slackSession, activeWorkItem = null) {
  if (intake?.action !== 'agent_turn') return false;
  if (!hasSlackFollowupTarget(slackSession, activeWorkItem)) return false;
  if (intake?.explicitWorkItemReference) return false;
  if (slackAgentAnalysis?.needsClarification) return false;

  const text = String(intake?.text || '');
  if (!text || EXPLICIT_NEW_WORK_ITEM_RE.test(text)) return false;

  if (!LOCAL_FOLLOWUP_CUE_RE.test(text)) {
    return FOLLOWUP_INTENTS.has(slackAgentAnalysis?.intent);
  }

  if (!slackAgentAnalysis?.intent) return true;
  if (FOLLOWUP_INTENTS.has(slackAgentAnalysis.intent)) return true;
  if (LIST_WORK_ITEM_INTENTS.has(slackAgentAnalysis.intent)) return false;
  if (SWITCH_WORK_ITEM_INTENTS.has(slackAgentAnalysis.intent)) return false;
  if (UNSUPPORTED_DESTRUCTIVE_INTENTS.has(slackAgentAnalysis.intent)) return false;
  if (
    [
      'repo_question',
      'architecture_question',
      'platform_question',
      'status_query',
      'diagnose_work_item',
      'summarize_review_results',
      'reopen_work_item',
      'cancel_request',
      'close_session',
      'repeat_previous_message',
    ].includes(slackAgentAnalysis.intent)
  ) {
    return false;
  }

  return CREATE_PLATFORM_INTENTS.has(slackAgentAnalysis.intent) || CREATE_JOB_INTENTS.has(slackAgentAnalysis.intent);
}

function slackAgentToolCallForTurn(intake, slackAgentAnalysis, slackSession, options = {}) {
  const activeWorkItem = options.activeWorkItem || null;
  if (!slackAgentAnalysis) {
    if (shouldForceSlackFollowup(intake, null, slackSession, activeWorkItem)) {
      return { name: 'record_followup', args: {} };
    }
    return null;
  }

  if (shouldForceSlackFollowup(intake, slackAgentAnalysis, slackSession, activeWorkItem)) {
    return { name: 'record_followup', args: {} };
  }

  if (shouldRejectUnsupportedDestructiveSlackTurn(slackAgentAnalysis)) {
    return { name: 'unsupported_destructive_request', args: {} };
  }

  if (intake.action === 'list_work_items') {
    return { name: 'list_my_work_items', args: { state: slackAgentWorkItemState(intake, slackAgentAnalysis) } };
  }
  if (intake.action === 'switch_work_item') return { name: 'switch_work_item', args: {} };
  if (intake.action === 'reopen_work_item') return { name: 'reopen_work_item', args: slackAgentToolArgs(slackAgentAnalysis) };
  if (intake.action === 'repo_question' || intake.action === 'answer_repo_question') {
    return { name: 'answer_repo_question', args: { question: intake.text } };
  }
  if (intake.action === 'diagnose_work_item') {
    return { name: 'diagnose_current_work_item', args: workItemToolArgsFromIntake(intake) };
  }
  if (intake.action === 'summarize_review_results') {
    return {
      name: 'summarize_review_results',
      args: reviewResultsToolArgsForTurn(intake, slackAgentAnalysis),
    };
  }

  if (['repo_question', 'architecture_question', 'platform_question'].includes(slackAgentAnalysis.intent)) {
    return { name: 'answer_repo_question', args: { question: intake.text } };
  }

  const explicitName = slackAgentExplicitToolName(slackAgentAnalysis);
  const capability = slackAgentCapability(slackAgentAnalysis);
  if (explicitName && capability) {
    return {
      name: capability.name,
      args:
        capability.name === 'summarize_review_results'
          ? reviewResultsToolArgsForTurn(intake, slackAgentAnalysis)
          : slackAgentToolArgs(slackAgentAnalysis),
    };
  }
  if (['confirm_create_issue', 'confirm_platform_issue'].includes(capability?.name)) return null;
  if (capability) {
    return {
      name: capability.name,
      args:
        capability.name === 'list_my_work_items'
          ? { state: slackAgentWorkItemState(intake, slackAgentAnalysis) }
          : capability.name === 'answer_repo_question'
            ? { question: intake.text }
            : capability.name === 'summarize_review_results'
              ? reviewResultsToolArgsForTurn(intake, slackAgentAnalysis)
              : slackAgentToolArgs(slackAgentAnalysis),
    };
  }

  if (shouldCloseSlackSession(intake, slackAgentAnalysis)) {
    return intake.explicitWorkItemReference
      ? { name: 'unsupported_destructive_request', args: {} }
      : { name: 'close_session', args: {} };
  }
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
    return { name: 'diagnose_current_work_item', args: slackAgentToolArgs(slackAgentAnalysis) };
  }
  if (LIST_WORK_ITEM_INTENTS.has(slackAgentAnalysis.intent)) {
    return { name: 'list_my_work_items', args: { state: slackAgentWorkItemState(intake, slackAgentAnalysis) } };
  }
  if (SWITCH_WORK_ITEM_INTENTS.has(slackAgentAnalysis.intent)) return { name: 'switch_work_item', args: {} };
  if (slackAgentAnalysis.intent === 'reopen_work_item') return { name: 'reopen_work_item', args: {} };
  if (slackAgentAnalysis.intent === 'cancel_request') return { name: 'cancel_request', args: {} };
  if (hasActiveSlackTarget(slackSession) && isSlackFollowupIntent(slackAgentAnalysis)) {
    return { name: 'record_followup', args: {} };
  }
  if (shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis)) {
    return { name: 'confirm_create_issue', args: {} };
  }
  if (shouldAskBeforeCreatingPlatformIssue(intake, slackAgentAnalysis)) {
    return { name: 'confirm_platform_issue', args: {} };
  }
  return null;
}

function reviewResultsToolArgsFromIntake(intake = {}) {
  const explicitReference = intake.explicitWorkItemReference || null;
  const number = Number(explicitReference?.number || intake.targetNumber || intake.prNumber || intake.issueNumber);
  if (!Number.isFinite(number) || number <= 0) return { kind: 'current', maxItems: 5 };
  return {
    kind:
      explicitReference?.kind ||
      intake.targetKind ||
      (intake.prNumber ? 'pr' : intake.issueNumber ? 'issue' : 'unknown'),
    number,
    maxItems: 5,
    explicitUserTarget: true,
  };
}

function workItemToolArgsFromIntake(intake = {}) {
  const explicitReference = intake.explicitWorkItemReference || null;
  const number = Number(explicitReference?.number || intake.targetNumber || intake.prNumber || intake.issueNumber);
  return {
    ...(intake.jobId ? { jobId: intake.jobId } : {}),
    ...(Number.isFinite(number) && number > 0
      ? {
          kind:
            explicitReference?.kind ||
            intake.targetKind ||
            (intake.prNumber ? 'pr' : intake.issueNumber ? 'issue' : 'unknown'),
          number,
          explicitUserTarget: true,
        }
      : {}),
  };
}

function reviewResultsToolArgsForTurn(intake = {}, slackAgentAnalysis = {}) {
  const agentArgs = slackAgentToolArgs(slackAgentAnalysis);
  const intakeArgs = reviewResultsToolArgsFromIntake(intake);
  if (intakeArgs.explicitUserTarget) return { ...agentArgs, ...intakeArgs };
  return Object.keys(agentArgs).length ? agentArgs : intakeArgs;
}

function hasActiveSlackTarget(slackSession) {
  return Boolean(
    slackSession?.activeJobId ||
      slackSession?.activeWorkItemId ||
      slackSession?.activeWorkItemKind ||
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

function isSlackFollowupIntent(analysis) {
  if (analysis?.needsClarification) return false;
  return FOLLOWUP_INTENTS.has(analysis?.intent);
}

function shouldCloseSlackSession(intake, slackAgentAnalysis) {
  return intake.action === 'close_session' || slackAgentAnalysis?.intent === 'close_session';
}

function shouldRejectUnsupportedDestructiveSlackTurn(slackAgentAnalysis) {
  return UNSUPPORTED_DESTRUCTIVE_INTENTS.has(slackAgentAnalysis?.intent);
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

function shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis) {
  if (!slackAgentAnalysis || slackAgentAnalysis.needsClarification) return false;
  if (isPlatformDevAnalysis(slackAgentAnalysis)) return false;
  if (!CREATE_JOB_INTENTS.has(slackAgentAnalysis.intent)) return false;
  if (intake.command) return false;
  if (!['agent_turn', 'create_job'].includes(intake.action)) return false;
  return true;
}

function shouldAskBeforeCreatingPlatformIssue(intake, slackAgentAnalysis) {
  if (!slackAgentAnalysis || slackAgentAnalysis.needsClarification) return false;
  if (!shouldCreatePlatformDevItem(intake, slackAgentAnalysis)) return false;
  if (intake.command) return false;
  if (!['agent_turn', 'create_platform_issue'].includes(intake.action)) return false;
  return true;
}

async function handleSlackAgentToolCall(context) {
  const { intake, slackAgentAnalysis, slackSession, store } = context;
  const activeWorkItem =
    slackSession?.id && store && intake?.action === 'agent_turn'
      ? await activeWorkItemForSlackSession(store, slackSession)
      : null;
  const toolCall =
    context.toolCall || slackAgentToolCallForTurn(intake, slackAgentAnalysis, slackSession, { activeWorkItem });
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
      if (intake.explicitWorkItemReference) {
        return handleSlackAgentNonPublishingTurn({
          ...context,
          action: 'unsupported_destructive_request',
          replyText: unsupportedDestructiveRequestReply(),
          preferReplyText: true,
        });
      }
      return handleCloseSlackSession(context);
    case 'get_current_status':
    case 'diagnose_current_work_item':
    case 'request_retry_work_item':
    case 'request_append_diagnosis_comment':
    case 'request_human_triage':
      return handleSlackWorkItemDiagnosisTool({
        ...context,
        toolArgs: { ...slackAgentToolArgs(slackAgentAnalysis), ...(toolCall.args || {}) },
      });
    case 'summarize_review_results':
      return handleSlackReviewResultsTool({ ...context, toolArgs: toolCall.args || {} });
    case 'unsupported_destructive_request':
      return handleSlackAgentNonPublishingTurn({
        ...context,
        action: 'unsupported_destructive_request',
        replyText: unsupportedDestructiveRequestReply(),
        preferReplyText: true,
      });
    case 'list_my_work_items':
      return handleSlackListWorkItemsTool({ ...context, toolArgs: toolCall.args || {} });
    case 'answer_repo_question':
      return handleSlackRepoQuestionTool({ ...context, toolArgs: toolCall.args || {} });
    case 'repeat_previous_message':
      return handleSlackRepeatPreviousMessageTool({ ...context, toolArgs: toolCall.args || {} });
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

async function handleSlackRepeatPreviousMessageTool({
  store,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  toolArgs = {},
}) {
  const context = buildConversationContext({ slackSession, sessionMemory, intake });
  const target = toolArgs.target || toolArgs.messageTarget || toolArgs.message_target || 'previous_visible_message';
  const repeated = repeatPreviousMessageFromContext(context, target);
  const replyText = repeated || '当前会话里我没有找到可复读的上一条消息。';

  await updateSessionMemoryWithAssistantTurn(
    store,
    slackSession,
    sessionMemory,
    intake,
    {
      summary: redactSecretLikeText(sessionMemory.summary || intake.text),
      lastAgentResponse: replyText,
      pendingQuestions: [],
      conversationKind: 'repeat_previous_message',
    },
    replyText
  );
  await completeSlackAgentRun(store, agentRun, {
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'repeat_previous_message',
      accepted: Boolean(repeated),
      intent: slackAgentAnalysis?.intent || intake.action,
      target,
    },
  });

  return {
    ok: true,
    action: 'repeat_previous_message',
    accepted: Boolean(repeated),
    replyText,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
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
      if (!shouldRetryRecordedSlackDelivery(delivery.delivery)) {
        return {
          ok: true,
          action: 'duplicate_slack_event',
          accepted: false,
          reply: false,
          delivery: delivery.delivery,
        };
      }
      await updateDelivery({
        processingStatus: 'processing',
        resultType: 'none',
        ignoredReason: null,
        errorCode: null,
        errorMessage: null,
        retryNum: Number(delivery.delivery?.retryNum || 0) + 1,
        retryReason: `retry_${delivery.delivery?.processingStatus || 'received'}`,
      });
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
        toolArgs: workItemToolArgsFromIntake(intake),
      })
    );
  }

  if (intake.action === 'summarize_review_results' && !useSlackAgentForToolLikeTurn) {
    return respond(
      await handleSlackReviewResultsTool({
        store,
        body,
        env,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis: null,
        toolArgs: reviewResultsToolArgsFromIntake(intake),
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

    if (shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis)) {
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

    if (shouldAskBeforeCreatingPlatformIssue(intake, slackAgentAnalysis)) {
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
      await updateSessionMemoryWithAssistantTurn(store, slackSession, sessionMemory, intake, {
        summary: redactedSlackAgentAnalysis?.summary || redactedIntake.text,
        requirements: redactedSlackAgentAnalysis || { text: redactedIntake.text, action: redactedIntake.action },
        lastAgentResponse: '',
        pendingQuestions: [],
        conversationKind: 'platform_issue_created',
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
      const autoDevPending = item.autoDevStatus !== 'triggered';
      const slackStatusNotification = created
        ? await notifySlackPlatformDevStatus(env, store, item, {
            stage: 'issue_creating',
            text: autoDevPending ? '平台需求已记录，正在创建 GitHub issue。' : '平台需求已进入处理队列。',
            statusText: autoDevPending
              ? ':hourglass_flowing_sand: 正在创建 GitHub issue...'
              : ':hourglass_flowing_sand: 正在创建 GitHub issue...',
          })
        : null;
      const workerStart = created
        ? queueSlackWorkerStart(env, store, () => startWorkerForPlatformDevItemIfConfigured(item, env), {
            workItemKind: 'platform_dev',
            platformDevItemId: item.id,
            slackSessionId: slackSession.id,
          })
        : null;
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
    await updateSessionMemoryWithAssistantTurn(
      store,
      slackSession,
      sessionMemory,
      intake,
      {
        summary: redactedSlackAgentAnalysis?.summary || redactedIntake.text,
        requirements: redactedSlackAgentAnalysis || { text: redactedIntake.text, action: redactedIntake.action },
        lastAgentResponse: redactedSlackAgentAnalysis?.needsClarification ? redactedSlackAgentAnalysis.summary : '',
        conversationKind: 'site_issue_created',
      },
      redactedSlackAgentAnalysis?.needsClarification ? redactedSlackAgentAnalysis.summary : ''
    );
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
    let workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;
    if (workerStart?.started === false) {
      const failedJob = await failQueuedSlackWorkerStart(
        store,
        {
          workItemKind: 'site_publishing',
          publishingJobId: job.id,
          slackSessionId: slackSession.id,
        },
        workerStart.error || 'Worker start failed'
      );
      await notifyQueuedWorkerStartFailure(env, store, failedJob, {
        workItemKind: 'site_publishing',
        publishingJobId: job.id,
        slackSessionId: slackSession.id,
      });
      workerStart = { ...workerStart, failedJobId: failedJob?.id || job.id };
      const error = new Error(workerStart.error || 'Worker start failed');
      error.name = 'SlackWorkerStartError';
      throw error;
    }
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
  await updateSessionMemoryWithAssistantTurn(
    store,
    slackSession,
    sessionMemory,
    intake,
    {
      summary: redactSecretLikeText(sessionMemory.summary || intake.text),
      lastAgentResponse: '会话已关闭。',
      pendingQuestions: [],
      conversationKind: 'session_closed',
    },
    '会话已关闭。'
  );
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

async function handleSlackRepoQuestionTool({
  store,
  env,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  toolArgs = {},
}) {
  const question = toolArgs.question || toolArgs.query || slackAgentAnalysis?.summary || intake.text;
  const result = await answerRepoQuestion(env, { question, text: intake.text, sessionMemory });
  const replyText = redactSecretLikeText(result.replyText);
  const repoQuestionContext = nextRepoQuestionContext(sessionMemory?.repoQuestionContext || {}, {
    ...result,
    replyText,
  });
  const blocks = repoQuestionActionBlocks(slackSession, result);

  if (slackSession?.id && store.updateSessionMemory) {
    await updateSessionMemoryWithAssistantTurn(
      store,
      slackSession,
      sessionMemory,
      intake,
      {
        summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
        lastAgentResponse: replyText,
        repoQuestionContext,
        conversationKind: 'repo_answer',
      },
      replyText
    );
  }
  await completeSlackAgentRun(store, agentRun, {
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'answer_repo_question',
      accepted: true,
      intent: slackAgentAnalysis?.intent || intake.action,
      evidenceCount: result.evidence?.length || 0,
    },
  });

  return {
    ...result,
    replyText,
    ...(blocks ? { blocks } : {}),
    slackSessionId: slackSession?.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

async function handleSlackReviewResultsTool({
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
  const resolved = await resolveReviewResultsTarget(store, body, slackSession, toolArgs, { sessionMemory });
  if (resolved.forbidden) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: {
        action: 'summarize_review_results',
        accepted: false,
        forbidden: true,
        targetKind: resolved.targetKind,
        targetNumber: resolved.targetNumber || null,
      },
    });
    return {
      ok: true,
      action: 'summarize_review_results_forbidden',
      accepted: false,
      replyText: '这个 PR 或 Issue 不属于当前 Slack 用户，不能查看 Review 结果。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  if (!resolved.item) {
    await completeSlackAgentRun(store, agentRun, {
      ...slackAgentRunModelPatch(slackAgentAnalysis),
      report: { action: 'summarize_review_results', accepted: false, reason: 'not_found' },
    });
    return {
      ok: true,
      action: 'summarize_review_results_not_found',
      accepted: false,
      replyText: '我还没有在当前会话里找到关联 PR，所以还没有可查看的 Review 结果。可以先说「我的 PR」查看当前任务。',
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
      ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
    };
  }

  const summary = await buildReviewResultsSummary(store, env, resolved.item, toolArgs);
  const replyText = formatSlackReviewResultsText(summary);
  const blocks = buildSlackReviewResultsBlocks(slackSession, summary);
  if (slackSession?.id && store.updateSessionMemory) {
    const existingRequirements =
      sessionMemory?.requirements && typeof sessionMemory.requirements === 'object' ? sessionMemory.requirements : {};
    await updateSessionMemoryWithAssistantTurn(
      store,
      slackSession,
      sessionMemory,
      intake,
      {
        summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
        requirements: {
          ...existingRequirements,
          reviewResults: reviewResultsMemory(summary),
        },
        lastAgentResponse: replyText,
        conversationKind: 'review_results',
      },
      replyText
    );
  }
  await completeSlackAgentRun(store, agentRun, {
    ...(summary.workItemKind === 'platform_dev'
      ? { workItemKind: 'platform_dev', workItemId: summary.workItemId || resolved.item.id }
      : { publishingJobId: summary.workItemId || resolved.item.id }),
    ...slackAgentRunModelPatch(slackAgentAnalysis),
    report: {
      action: 'summarize_review_results',
      accepted: true,
      intent: slackAgentAnalysis?.intent || intake.action,
      found: summary.found,
      reason: summary.reason || null,
      prNumber: summary.prNumber || null,
      headSha: summary.headSha || null,
      conclusion: summary.conclusion || null,
      counts: summary.counts || null,
      omitted: summary.omitted || null,
    },
  });
  return {
    ok: true,
    action: 'summarize_review_results',
    accepted: true,
    replyText,
    blocks,
    reviewResults: summary,
    ...(summary.workItemKind === 'platform_dev'
      ? { workItemKind: 'platform_dev', workItemId: summary.workItemId || resolved.item.id }
      : { jobId: summary.workItemId || resolved.item.id }),
    slackSessionId: slackSession?.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
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
  const githubActions = await diagnoseGithubActionsForWorkItem(env, item, { events });
  const diagnosisOptions = { events, githubActions };
  const replyText = buildSlackWorkItemDiagnosis(item, diagnosisOptions);
  const blocks = buildSlackWorkItemDiagnosisBlocks(slackSession, item, { ...diagnosisOptions, slackAgentAnalysis });
  if (slackSession?.id && store.updateSessionMemory) {
    await updateSessionMemoryWithAssistantTurn(
      store,
      slackSession,
      sessionMemory,
      intake,
      {
        summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory?.summary || intake.text),
        lastAgentResponse: replyText,
        conversationKind: 'diagnosis',
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
      action: 'diagnose_work_item',
      accepted: false,
      intent: slackAgentAnalysis?.intent || intake.action,
      status: item.status,
      eventCount: events.length,
      githubActions: {
        available: githubActions.available,
        reason: githubActions.reason || null,
        workflowName: githubActions.workflowName || null,
        runId: githubActions.runId || null,
        conclusion: githubActions.conclusion || null,
      },
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
  await updateSessionMemoryWithAssistantTurn(
    store,
    slackSession,
    sessionMemory,
    intake,
    {
      summary: redactedSlackAgentAnalysis?.summary || redactSecretLikeText(sessionMemory.summary) || redactedIntakeText,
      requirements: redactedSlackAgentAnalysis || redactSlackAnalysis(sessionMemory.requirements) || {},
      lastAgentResponse: finalReplyText,
      pendingQuestions: redactedSlackAgentAnalysis?.needsClarification
        ? [finalReplyText]
        : redactSlackAnalysis(sessionMemory.pendingQuestions) || [],
      conversationKind: action || 'agent_reply',
    },
    finalReplyText
  );
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
      if (store?.updateSlackDelivery) {
        await store.updateSlackDelivery(slackDeliveryContextFromBody(body), {
          processingStatus: 'failed',
          resultType: 'none',
          errorCode: 'slack_delivery_failed',
          errorMessage: err.message,
        });
      }
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
