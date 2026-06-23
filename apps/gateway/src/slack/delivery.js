import {
  addSlackReaction,
  mentionSlackUser,
  notifySlackJob,
  postSlackMessage,
  removeSlackReaction,
  updateSlackMessage,
} from './notifier.js';
import { slackUserIdFromBody, surfaceForSlackBody } from './session.js';

export function canSendSlackOutput(env = {}) {
  const hasNotifierUrl = Boolean(env.SLACK_NOTIFIER_URL || env.PAGES_SLACK_NOTIFIER_URL);
  const hasNotifierSecret = Boolean(env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET);
  return Boolean(hasNotifierUrl && hasNotifierSecret);
}

export function shouldPostSlackResultReply(result = {}) {
  if (!result.replyText) return false;
  if (result.reply === false || result.noReply) return false;
  if (result.action === 'ignored_untracked_thread_message') return false;
  return true;
}

export function slackEventId(body = {}) {
  return body.event_id || body.trigger_id || body.event?.client_msg_id || null;
}

function inferSlackChannelType(event = {}) {
  if (event.channel_type) return event.channel_type;
  return String(event.channel || '').startsWith('D') ? 'im' : null;
}

export function ignoredSlackEventReason(body = {}) {
  const event = body.event || {};
  if (body.type && body.type !== 'event_callback') return null;
  if (event.subtype && event.subtype !== 'bot_message') return `ignored_subtype:${event.subtype}`;
  if (event.bot_id || event.subtype === 'bot_message') return 'ignored_bot_event';
  if (event.type === 'app_mention') return null;
  if (event.type === 'message' && inferSlackChannelType(event) === 'im') return null;
  if (event.type === 'message' && event.thread_ts) return null;
  return 'unsupported_event';
}

export function interactionChannelId(body = {}, session = null) {
  return session?.channelId || body.channel?.id || body.container?.channel_id || null;
}

export function interactionThreadTs(body = {}, session = null) {
  return (
    session?.threadTs ||
    body.message?.thread_ts ||
    body.message?.ts ||
    body.container?.thread_ts ||
    body.container?.message_ts ||
    null
  );
}

export function interactionChannelType(channelId, session = null) {
  if (session?.dmChannelId || String(channelId || '').startsWith('D')) return 'im';
  return null;
}

export async function postSlackInteractionThreadReply(env, body = {}, session = null, text = '', options = {}) {
  if (!canSendSlackOutput(env) || !text) return null;
  const channel = interactionChannelId(body, session);
  if (!channel) return null;
  return postSlackMessage(env, {
    channel,
    thread_ts: interactionThreadTs(body, session) || undefined,
    text: mentionSlackUser(text, slackUserIdFromBody(body, null)),
    ...(options.blocks ? { blocks: options.blocks } : {}),
  });
}

export async function updateSlackInteractionMessage(env, body = {}, session = null, options = {}) {
  if (!canSendSlackOutput(env)) return null;
  const channel = interactionChannelId(body, session);
  const ts = body.message?.ts || body.container?.message_ts || null;
  if (!channel || !ts) return null;

  return updateSlackMessage(env, {
    channel,
    ts,
    text: mentionSlackUser(options.text || '已更新。', slackUserIdFromBody(body, null)),
    ...(options.blocks ? { blocks: options.blocks } : {}),
  });
}

function shouldPostSlackPlainProgressMessages(env = {}) {
  return String(env.SLACK_PLAIN_PROGRESS_MESSAGES || 'false').toLowerCase() === 'true';
}

export async function notifySlackPlainProgress(env, store, job, text, key) {
  if (!shouldPostSlackPlainProgressMessages(env)) return null;
  return notifySlackJob(env, store, job, text, key);
}

export function slackDeliveryContextFromBody(body = {}) {
  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  return {
    teamId: body.team_id || body.team?.id || event.team || 'unknown-team',
    eventId: slackEventId(body) || 'unknown-event',
    channelId: surface.channelId || null,
    threadTs: surface.threadTs || surface.messageTs || null,
    slackUserId: slackUserIdFromBody(body, null),
    requestId: body.event_context || body.trigger_id || null,
  };
}

function slackReactionName(value, fallback) {
  const normalized = String(value || fallback || '')
    .trim()
    .replace(/^:+|:+$/g, '');
  return normalized || null;
}

function slackResultType(result = {}) {
  if (result.action === 'close_session') return 'session_closed';
  if (result.action === 'clarification_needed') return 'clarification_requested';
  if (['status', 'status_query', 'diagnose_work_item', 'answer_repo_question'].includes(result.action)) return 'status_returned';
  if (result.action === 'list_work_items' || String(result.action || '').startsWith('switch_work_item')) return 'status_returned';
  if (String(result.action || '').startsWith('followup_')) return 'followup_appended';
  if (result.platformDevItemId || result.workItemKind === 'platform_dev') {
    return result.action === 'create_platform_issue' ? 'platform_issue_created' : 'platform_gate_pending';
  }
  if (result.jobId) return 'job_created';
  if (result.replyText) return 'agent_replied';
  return 'none';
}

function slackProcessingStatus(result = {}, overrides = {}) {
  if (overrides.processingStatus) return overrides.processingStatus;
  if (result.action === 'ignored_slack_event' || result.action === 'ignored_untracked_thread_message') return 'ignored';
  return 'processed';
}

export function slackDeliveryPatchForResult(result = {}, overrides = {}) {
  const processingStatus = slackProcessingStatus(result, overrides);
  return {
    processingStatus,
    resultType: overrides.resultType || slackResultType(result),
    ignoredReason:
      overrides.ignoredReason || (processingStatus === 'ignored' ? result.reason || result.action || 'ignored' : null),
    errorCode: overrides.errorCode || null,
    errorMessage: overrides.errorMessage || null,
    slackSessionId: result.slackSessionId || null,
    publishingJobId: result.jobId || null,
    workItemKind: result.workItemKind || null,
    workItemId: result.workItemId || result.platformDevItemId || null,
    platformDevItemId: result.platformDevItemId || null,
    agentRunId: result.agentRunId || null,
    ...(overrides.payloadRedacted ? { payloadRedacted: overrides.payloadRedacted } : {}),
  };
}

function remoteSlackNotifierUrl(env = {}, path) {
  const base = env.SLACK_NOTIFIER_URL || env.PAGES_SLACK_NOTIFIER_URL;
  if (!base) return null;
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function remoteSlackNotifierToken(env = {}) {
  return env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET;
}

function requesterProfileFromSlackUser(body = {}, slackUser = {}) {
  const event = body.event || {};
  const profile = slackUser.profile || {};
  const slackUserId = slackUser.id || slackUserIdFromBody(body, null);
  const slackTeamId = slackUser.team_id || body.team_id || body.team?.id || event.team || null;
  const displayName = profile.display_name || profile.display_name_normalized || null;
  const realName = profile.real_name || profile.real_name_normalized || slackUser.real_name || null;
  const name = slackUser.name || profile.name || null;

  return {
    source: 'slack.users.info',
    slackTeamId,
    slackUserId,
    name,
    displayName,
    realName,
    email: profile.email || null,
  };
}

async function fetchSlackRequesterProfileFromNotifier(env = {}, slackUserId) {
  const url = remoteSlackNotifierUrl(env, '/internal/slack-notifier/user-info');
  const token = remoteSlackNotifierToken(env);
  if (!url || !token || !slackUserId) return null;

  const fetchImpl = env.SLACK_NOTIFIER_FETCH || fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Pages-Slack-Notifier-Token': token,
    },
    body: JSON.stringify({ user: slackUserId }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.ok === false || !body?.profile) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_user_profile_lookup_failed',
        slackUserId,
        via: 'slack-notifier',
        error: body?.error || response.statusText || `HTTP ${response.status}`,
      })
    );
    return null;
  }

  return body.profile;
}

export async function fetchSlackRequesterProfile(env = {}, body = {}) {
  if (String(env.SLACK_USER_PROFILE_LOOKUP || 'true').toLowerCase() === 'false') return null;

  const slackUserId = slackUserIdFromBody(body, null);
  if (!slackUserId) return null;

  const notifierProfile = await fetchSlackRequesterProfileFromNotifier(env, slackUserId);
  if (notifierProfile) return notifierProfile;

  return requesterProfileFromSlackUser(body, { id: slackUserId });
}

export async function addWorkingReactionForSlackEvent(env, body = {}) {
  if (!canSendSlackOutput(env)) return null;
  if (String(env.SLACK_REACTION_ON_RECEIVE || 'false').toLowerCase() !== 'true') return null;
  if (ignoredSlackEventReason(body)) return null;

  const event = body.event || {};
  const channel = event.channel || body.channel_id;
  const timestamp = event.ts || body.event_ts;
  const name = slackReactionName(env.SLACK_WORKING_REACTION, 'eyes');
  if (!channel || !timestamp || !name) return null;

  const reaction = { channel, timestamp, name };
  let result = null;
  try {
    result = await addSlackReaction(env, reaction);
  } catch (error) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_reaction_failed',
        channel,
        timestamp,
        reaction: name,
        error: error.message,
      })
    );
    return {
      ok: false,
      error: error.message,
      reaction,
      status: 'failed',
    };
  }
  if (!result?.ok) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_reaction_failed',
        channel,
        timestamp,
        reaction: name,
        error: result?.error || 'unknown_error',
      })
    );
  }
  return {
    ...result,
    reaction,
    status: result?.ok && !result.skipped ? 'working' : 'failed',
  };
}

async function updateSlackReaction(env, currentReaction, nextName) {
  if (!canSendSlackOutput(env) || !currentReaction?.channel || !currentReaction?.timestamp) return null;
  const normalizedNextName = slackReactionName(nextName, null);
  const removed = currentReaction.name
    ? await removeSlackReaction(env, {
        channel: currentReaction.channel,
        timestamp: currentReaction.timestamp,
        name: currentReaction.name,
      })
    : null;
  const added = normalizedNextName
    ? await addSlackReaction(env, {
        channel: currentReaction.channel,
        timestamp: currentReaction.timestamp,
        name: normalizedNextName,
      })
    : null;

  for (const [action, result] of [
    ['remove', removed],
    ['add', added],
  ]) {
    if (result && !result.ok) {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_reaction_update_failed',
          action,
          channel: currentReaction.channel,
          timestamp: currentReaction.timestamp,
          reaction: action === 'add' ? normalizedNextName : currentReaction.name,
          error: result.error || 'unknown_error',
        })
      );
    }
  }

  return {
    removed,
    added,
    nextName: normalizedNextName,
  };
}

function shouldKeepWorkingReactionForResult(result = {}) {
  if (!result || result.accepted === false) return false;
  if (result.action === 'switch_work_item') return false;
  if (result.jobId) return true;
  return String(result.action || '').startsWith('followup_');
}

export async function settleImmediateSlackReaction(env, workingReaction, result = {}) {
  const reaction = workingReaction?.reaction;
  if (!reaction || workingReaction?.status !== 'working') return null;
  if (shouldKeepWorkingReactionForResult(result)) return null;
  if (result.action === 'ignored_slack_event' || result.action === 'ignored_untracked_thread_message') {
    return { ...(await updateSlackReaction(env, reaction, null)), outcome: 'ignored' };
  }
  const failed = result.ok === false || result.action === 'slack_event_processing_failed';
  const doneReaction = failed
    ? slackReactionName(env.SLACK_FAILED_REACTION, 'x')
    : slackReactionName(env.SLACK_DONE_REACTION, 'white_check_mark');
  return { ...(await updateSlackReaction(env, reaction, doneReaction)), outcome: failed ? 'failed' : 'done' };
}

export async function settleJobSlackReactions(env, store, job, outcome = 'done') {
  if (!job?.id || !store?.listSlackDeliveries || !store?.updateSlackDelivery) return null;
  const doneReaction =
    outcome === 'failed'
      ? slackReactionName(env.SLACK_FAILED_REACTION, 'x')
      : slackReactionName(env.SLACK_DONE_REACTION, 'white_check_mark');
  const candidates = new Map();
  const addCandidates = async (options = {}) => {
    const result = await store.listSlackDeliveries({ ...options, limit: 100 });
    for (const delivery of result?.deliveries || []) {
      const key = `${delivery.teamId || 'unknown-team'}:${delivery.eventId || 'unknown-event'}`;
      candidates.set(key, delivery);
    }
  };

  await addCandidates({ publishingJobId: job.id });
  if (job.slackSessionId) {
    await addCandidates({ slackSessionId: job.slackSessionId });
  }
  if (job.slackThread?.channelId) {
    await addCandidates({ channelId: job.slackThread.channelId });
  }

  const deliveries = [...candidates.values()].filter((delivery) => {
    if (delivery.publishingJobId === job.id) return true;
    if (job.slackSessionId && delivery.slackSessionId === job.slackSessionId) return true;
    return (
      job.slackThread?.channelId &&
      delivery.channelId === job.slackThread.channelId &&
      (!job.slackThread?.threadTs || !delivery.threadTs || delivery.threadTs === job.slackThread.threadTs)
    );
  });
  const settled = [];

  for (const delivery of deliveries) {
    const state = delivery.payloadRedacted?.workingReaction;
    if (!state || state.status !== 'working' || !state.reaction?.channel || !state.reaction?.timestamp) continue;

    let reactionResult = null;
    try {
      reactionResult = await updateSlackReaction(env, state.reaction, doneReaction);
    } catch (error) {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_reaction_settlement_failed',
          jobId: job.id,
          eventId: delivery.eventId,
          error: error.message,
        })
      );
      continue;
    }
    const nextPayload = {
      ...(delivery.payloadRedacted || {}),
      workingReaction: {
        ...state,
        status: outcome,
        doneReaction,
        settledAt: new Date().toISOString(),
      },
    };
    await store.updateSlackDelivery(
      {
        teamId: delivery.teamId,
        eventId: delivery.eventId,
      },
      {
        payloadRedacted: nextPayload,
      }
    );
    settled.push({
      eventId: delivery.eventId,
      reactionResult,
    });
  }

  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_reaction_settlement_checked',
      jobId: job.id,
      outcome,
      candidateCount: candidates.size,
      matchedCount: deliveries.length,
      settledCount: settled.length,
    })
  );

  return settled.length ? { outcome, settledCount: settled.length, settled } : null;
}

export async function postSlackResultReply(env, body = {}, result = {}) {
  if (!canSendSlackOutput(env) || !shouldPostSlackResultReply(result)) return null;

  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  const channel = surface.channelId;
  if (!channel) return null;

  return postSlackMessage(env, {
    channel,
    thread_ts: surface.threadTs || event.ts || undefined,
    text: mentionSlackUser(result.replyText, slackUserIdFromBody(body, null)),
    ...(result.blocks ? { blocks: result.blocks } : {}),
  });
}

export function runSlackBackground(env, task) {
  const promise = Promise.resolve()
    .then(task)
    .catch((err) => {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_event_background_failed',
          error: err.message,
        })
      );
    });

  if (typeof env.waitUntil === 'function') {
    env.waitUntil(promise);
  }

  return promise;
}

export function shouldProcessSlackEventsAsync(env = {}) {
  if (env.SLACK_EVENTS_PROCESSING_MODE === 'sync') return false;
  if (env.SLACK_EVENTS_PROCESSING_MODE === 'async') return true;
  return Boolean(env.SLACK_SIGNING_SECRET);
}

export function slackReactionPayloadFromResult(workingReaction, patch = {}) {
  if (!workingReaction?.reaction) return null;
  return {
    workingReaction: {
      reaction: workingReaction.reaction,
      status: workingReaction.status || 'working',
      addedAt: new Date().toISOString(),
      ...patch,
    },
  };
}

export async function updateSlackDeliveryReactionState(store, body = {}, workingReaction, patch = {}) {
  if (!workingReaction?.reaction || !store?.updateSlackDelivery) return null;
  return store.updateSlackDelivery(slackDeliveryContextFromBody(body), {
    payloadRedacted: slackReactionPayloadFromResult(workingReaction, patch),
  });
}
