import {
  buildSlackAgentReplyBlocks,
  mentionSlackUser,
  startSlackAgentReply,
  updateSlackAgentReply,
} from './notifier.js';
import { slackUserIdFromBody, surfaceForSlackBody } from './session.js';
import { canSendSlackOutput, shouldPostSlackResultReply } from './delivery.js';
import { slackThreadForSession } from './job-binding.js';

const SLACK_AGENT_REPLY_START_TEXT = '正在整理需求...';
const SHORT_QUERY_TURN_RE = new RegExp(
  [
    '我的\\s*(?:PR|issue|任务)',
    '当前会话|有哪些|为什么|为啥|怎么|如何|哪里|在哪|是什么',
    '实现|架构|保存|存储|读取|触发|调用|代码|repo',
    '原因|失败|没成功|没有成功|没出来|卡住|卡在哪|卡在',
    '诊断|排查|查一下|看一下|状态|进度|日志|log|workflow|actions|重试',
  ].join('|'),
  'i'
);

function hasActiveSlackTarget(slackSession) {
  return Boolean(
    slackSession?.activeJobId || slackSession?.activeIssueNumber || slackSession?.activePrNumber || slackSession?.activePreviewUrl
  );
}

function slackAgentEndpoint(env = {}) {
  if (env.SLACK_AGENT_TURN_URL) return { url: env.SLACK_AGENT_TURN_URL, mode: 'turn' };
  if (env.SLACK_AGENT_ANALYZE_URL) return { url: env.SLACK_AGENT_ANALYZE_URL, mode: 'analyze' };
  return null;
}

function slackAgentRequestPayload(body, intake, context = {}) {
  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  const slackSession = context.slackSession || null;
  const agentRun = context.agentRun || null;

  return {
    ...body,
    agentRunId: agentRun?.id || null,
    slackSessionId: slackSession?.id || null,
    teamId: body.team_id || body.team?.id || event.team || null,
    slackUserId: slackUserIdFromBody(body, null),
    channelId: surface.channelId || null,
    threadTs: surface.threadTs || null,
    messageTs: surface.messageTs || null,
    messageText: intake.text,
    text: intake.text,
    employeeSlug: body.employeeSlug || body.employee_slug,
    siteSlug: body.siteSlug || body.site_slug,
    slackSession,
    sessionMemory: context.sessionMemory || null,
    issueLinks: context.issueLinks || [],
    activeIssueLink: context.issueLinks?.[0] || null,
    agentRun,
  };
}

async function readSlackAgentResponse(response) {
  const text = await response.text();
  if (!text) return {};

  const contentType = response.headers?.get?.('Content-Type') || '';
  if (/\bapplication\/x-ndjson\b/i.test(contentType)) {
    const events = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const final = [...events].reverse().find((event) => event.type === 'analysis_final' && event.analysis);
    return {
      ok: true,
      turn: {
        events,
        analysis: final?.analysis || null,
        visibleText: events
          .filter((event) => event.type === 'reply_delta' && event.text)
          .map((event) => event.text)
          .join(''),
      },
      analysis: final?.analysis || null,
    };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function normalizeSlackAgentTurnResult(result = {}, mode = 'analyze') {
  if (mode === 'turn') {
    const turn = result.turn || result.data?.turn || result;
    const finalEvent = Array.isArray(turn.events)
      ? [...turn.events].reverse().find((event) => event.type === 'analysis_final' && event.analysis)
      : null;
    const analysis = result.analysis || turn.analysis || finalEvent?.analysis || null;
    return {
      analysis,
      turn: {
        ...turn,
        analysis,
        events: Array.isArray(turn.events) ? turn.events : [],
      },
    };
  }

  return { analysis: result?.analysis || null, turn: null };
}

function shouldStartSlackAgentReplyForTurn(intake, endpoint, slackSession) {
  if (endpoint?.mode !== 'turn' || intake.action !== 'agent_turn') return false;
  if (SHORT_QUERY_TURN_RE.test(intake.text || '')) return false;
  return !hasActiveSlackTarget(slackSession);
}

async function startSlackAgentReplyMessage(env, store, body, slackSession, agentRun) {
  if (!canSendSlackOutput(env) || !store?.recordSlackAgentReplyMessage || !agentRun?.id || !slackSession?.id) return null;
  const existing = store.getSlackAgentReplyMessage ? await store.getSlackAgentReplyMessage(agentRun.id) : null;
  if (existing?.messageTs) return { ok: true, action: 'existing', message: existing };

  const thread = slackThreadForSession(slackSession, surfaceForSlackBody(body));
  if (!thread.channelId) return null;

  const text = mentionSlackUser(SLACK_AGENT_REPLY_START_TEXT, slackUserIdFromBody(body, null));
  let result;
  try {
    result = await startSlackAgentReply(
      env,
      { channel: thread.channelId, thread_ts: thread.threadTs || thread.messageTs || undefined, text },
      {
        text,
        status: 'running',
        blocks: buildSlackAgentReplyBlocks({ text: SLACK_AGENT_REPLY_START_TEXT }, { title: '需求整理', status: 'running' }),
      }
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_agent_reply_start_failed',
        slackSessionId: slackSession.id,
        agentRunId: agentRun.id,
        error: err.message,
      })
    );
    return { ok: false, error: err.message };
  }

  if (!result?.ok || result.skipped) return result || null;
  const messageTs = result.ts || result.messageTs || result.message?.messageTs || null;
  if (!messageTs) return { ...result, ok: false, error: 'Slack agent reply start did not return a message timestamp' };

  const message = await store.recordSlackAgentReplyMessage(agentRun.id, {
    slackSessionId: slackSession.id,
    channel: result.channel || thread.channelId,
    threadTs: thread.threadTs || thread.messageTs || null,
    messageTs,
    textSnapshot: SLACK_AGENT_REPLY_START_TEXT,
    lastSequence: 1,
    status: 'running',
  });

  await store.recordAgentRunEvent?.({
    slackSessionId: slackSession.id,
    agentRunId: agentRun.id,
    type: 'slack_reply_posted',
    stage: 'slack_agent_turn',
    text: SLACK_AGENT_REPLY_START_TEXT,
    status: 'recorded',
    dedupeKey: `slack-reply-posted:${agentRun.id}`,
    slackChannelId: message.channel,
    slackThreadTs: message.threadTs,
    slackMessageTs: message.messageTs,
  });

  return { ...result, action: 'posted', message };
}

export async function updateSlackAgentReplyMessage(env, store, body, replyMessage, result = {}, options = {}) {
  if (!replyMessage?.messageTs || !shouldPostSlackResultReply(result)) return null;

  const text = mentionSlackUser(result.replyText, slackUserIdFromBody(body, null));
  let updateResult;
  try {
    updateResult = await updateSlackAgentReply(env, replyMessage, {
      text,
      status: options.status || 'completed',
      blocks:
        result.blocks ||
        buildSlackAgentReplyBlocks({ text: result.replyText }, { title: '需求整理', status: options.status || 'completed' }),
    });
  } catch (err) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_agent_reply_update_failed',
        slackSessionId: replyMessage.slackSessionId,
        agentRunId: replyMessage.agentRunId,
        error: err.message,
      })
    );
    return { ok: false, error: err.message };
  }

  if (!updateResult?.ok || updateResult.skipped) return updateResult || null;

  const sequence = options.sequence || replyMessage.lastSequence || 1;
  const messageTs = updateResult.ts || updateResult.messageTs || updateResult.message?.messageTs || replyMessage.messageTs;
  const message = store?.recordSlackAgentReplyMessage
    ? await store.recordSlackAgentReplyMessage(replyMessage.agentRunId, {
        slackSessionId: replyMessage.slackSessionId,
        channel: updateResult.channel || replyMessage.channel,
        threadTs: replyMessage.threadTs,
        messageTs,
        textSnapshot: result.replyText,
        lastSequence: sequence,
        status: options.status || 'completed',
      })
    : replyMessage;

  await store?.recordAgentRunEvent?.({
    slackSessionId: replyMessage.slackSessionId,
    agentRunId: replyMessage.agentRunId,
    type: options.status === 'failed' ? 'slack_reply_failed' : 'slack_reply_updated',
    stage: 'slack_agent_turn',
    text: result.replyText,
    status: options.status || 'completed',
    dedupeKey: `slack-reply-${options.status === 'failed' ? 'failed' : 'updated'}:${replyMessage.agentRunId}:${sequence}`,
    slackChannelId: message.channel,
    slackThreadTs: message.threadTs,
    slackMessageTs: message.messageTs,
  });

  return { ...updateResult, action: 'updated', message };
}

async function recordSlackAgentTurnEvent(store, turn = {}, event = {}, replyMessage = null, fallbackSequence = 1) {
  if (!store?.recordAgentRunEvent || !turn?.agentRunId || !event?.type) return null;
  const sequence = Number(event.sequence) || fallbackSequence;
  return await store.recordAgentRunEvent({
    slackSessionId: event.slackSessionId || turn.slackSessionId || null,
    agentRunId: event.agentRunId || turn.agentRunId,
    type: event.type,
    stage: 'slack_agent_turn',
    text: event.text || event.analysis?.summary || event.type,
    status: event.type === 'reply_failed' ? 'failed' : event.type === 'reply_completed' ? 'completed' : 'recorded',
    dedupeKey: event.dedupeKey || `${event.agentRunId || turn.agentRunId}:${sequence}`,
    slackChannelId: replyMessage?.channel || null,
    slackThreadTs: replyMessage?.threadTs || null,
    slackMessageTs: replyMessage?.messageTs || null,
  });
}

async function recordSlackAgentTurnEvents(store, turn = {}, replyMessage = null) {
  if (!store?.recordAgentRunEvent || !turn?.agentRunId) return [];
  const recorded = [];
  for (const event of turn.events || []) {
    const result = await recordSlackAgentTurnEvent(store, turn, event, replyMessage, recorded.length + 1);
    if (result) recorded.push(result);
  }
  return recorded;
}

async function failSlackAgentReplyMessage(env, store, body, replyMessage) {
  if (!replyMessage?.messageTs) return null;
  return updateSlackAgentReplyMessage(
    env,
    store,
    body,
    replyMessage,
    {
      ok: false,
      action: 'slack_agent_failed',
      replyText: '处理失败：这轮需求整理失败了，请稍后重试，或直接补充更具体的信息。',
    },
    {
      sequence: replyMessage.lastSequence || 1,
      status: 'failed',
    }
  );
}

function slackAgentReplyUpdateIntervalMs(env = {}) {
  const configured = Number(env.SLACK_AGENT_REPLY_UPDATE_INTERVAL_MS);
  if (Number.isFinite(configured)) return Math.max(0, configured);
  return 750;
}

function slackAgentTurnContentType(response) {
  return response.headers?.get?.('Content-Type') || response.headers?.get?.('content-type') || '';
}

async function slackAgentRunStillRunning(store, run = {}) {
  const agentRunId = typeof run === 'string' ? run : run?.id || run?.agentRunId || null;
  if (!agentRunId) return true;
  if (!store?.getAgentRun && !store?.listAgentRunsForSlackSession) return true;

  let current = store.getAgentRun ? await store.getAgentRun(agentRunId) : null;
  if (!current && store.listAgentRunsForSlackSession && run?.slackSessionId) {
    const runs = await store.listAgentRunsForSlackSession(run.slackSessionId);
    current = runs.find((item) => item.id === agentRunId) || null;
  }
  return current ? current.status === 'running' : false;
}

async function readSlackAgentNdjsonResponse(response, context = {}) {
  const events = [];
  const turn = {
    agentRunId: context.agentRunId || null,
    slackSessionId: context.slackSessionId || null,
    events,
    visibleText: '',
    analysis: null,
    eventsRecorded: true,
  };
  const updateIntervalMs = slackAgentReplyUpdateIntervalMs(context.env);
  let replyMessage = context.replyMessage || null;
  let lastUpdateAt = 0;
  let lastSequence = replyMessage?.lastSequence || 1;

  const isCurrentRun = async () =>
    await slackAgentRunStillRunning(context.store, {
      id: turn.agentRunId,
      slackSessionId: turn.slackSessionId,
    });

  const maybeUpdateReply = async ({ force = false, status = 'running' } = {}) => {
    if (!replyMessage?.messageTs || !turn.visibleText) return null;
    if (!(await isCurrentRun())) {
      turn.cancelled = true;
      return null;
    }
    const now = Date.now();
    if (!force && updateIntervalMs > 0 && now - lastUpdateAt < updateIntervalMs) return null;
    const update = await updateSlackAgentReplyMessage(
      context.env,
      context.store,
      context.body,
      replyMessage,
      {
        ok: true,
        action: 'slack_agent_turn_stream',
        replyText: turn.visibleText,
      },
      {
        sequence: lastSequence,
        status,
      }
    );
    if (update?.message) replyMessage = update.message;
    if (update?.ok) lastUpdateAt = now;
    return update;
  };

  const handleEvent = async (eventInput) => {
    const event = {
      ...eventInput,
      agentRunId: eventInput.agentRunId || turn.agentRunId,
      slackSessionId: eventInput.slackSessionId || turn.slackSessionId,
    };
    if (!event.type) return;
    turn.agentRunId = turn.agentRunId || event.agentRunId || null;
    turn.slackSessionId = turn.slackSessionId || event.slackSessionId || null;
    lastSequence = Number(event.sequence) || lastSequence;
    events.push(event);
    if (!(await isCurrentRun())) {
      turn.cancelled = true;
      return;
    }
    await recordSlackAgentTurnEvent(context.store, turn, event, replyMessage, events.length);

    if (event.type === 'reply_delta' && event.text) {
      turn.visibleText += event.text;
      await maybeUpdateReply({ status: 'running' });
    }

    if (event.type === 'analysis_final' && event.analysis) {
      turn.analysis = event.analysis;
    }
  };

  let buffer = '';
  const flushLines = async (final = false) => {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? '' : lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await handleEvent(JSON.parse(trimmed));
    }
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      await flushLines(false);
    }
    buffer += decoder.decode();
    await flushLines(true);
  } else {
    buffer = await response.text();
    await flushLines(true);
  }

  const failed = [...events].reverse().find((event) => event.type === 'reply_failed');
  return {
    ok: !failed,
    ...(failed ? { error: failed.error || failed.text || 'Slack Agent turn failed' } : {}),
    ...(turn.cancelled ? { cancelled: true } : {}),
    turn,
    analysis: turn.analysis,
  };
}

async function readSlackAgentTurnResponse(response, context = {}) {
  const contentType = slackAgentTurnContentType(response);
  if (/\bapplication\/x-ndjson\b/i.test(contentType)) {
    return await readSlackAgentNdjsonResponse(response, context);
  }
  return await readSlackAgentResponse(response);
}

export async function runSlackAgentTurnIfConfigured(body, intake, env, context = {}) {
  const endpoint = slackAgentEndpoint(env);
  if (!endpoint) return { analysis: null, turn: null };

  const headers = {
    'Content-Type': 'application/json',
    Accept: endpoint.mode === 'turn' ? 'application/x-ndjson, application/json;q=0.9' : 'application/json',
  };

  if (env.SLACK_AGENT_SHARED_SECRET) {
    headers['X-Pages-Slack-Agent-Token'] = env.SLACK_AGENT_SHARED_SECRET;
  }

  const store = context.store || env.store || env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  const replyStart = shouldStartSlackAgentReplyForTurn(intake, endpoint, context.slackSession)
    ? await startSlackAgentReplyMessage(env, store, body, context.slackSession, context.agentRun)
    : null;
  const replyMessage = replyStart?.message || null;
  try {
    const fetchImpl = env.SLACK_AGENT_FETCH || fetch;
    const payload = slackAgentRequestPayload(body, intake, context);
    const response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const result =
      endpoint.mode === 'turn'
        ? await readSlackAgentTurnResponse(response, {
            env,
            store,
            body,
            replyMessage,
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
          })
        : await readSlackAgentResponse(response);

    if (result?.cancelled || !(await slackAgentRunStillRunning(store, context.agentRun))) {
      return {
        cancelled: true,
        analysis: null,
        turn: result?.turn
          ? { ...result.turn, cancelled: true, replyMessage }
          : {
              agentRunId: context.agentRun?.id || null,
              slackSessionId: context.slackSession?.id || null,
              cancelled: true,
              replyMessage,
            },
      };
    }

    if (!response.ok || result?.ok === false) {
      const error = new Error(result?.error || response.statusText || `HTTP ${response.status}`);
      error.status = 502;
      throw error;
    }

    const turnResult = normalizeSlackAgentTurnResult(result, endpoint.mode);
    if (endpoint.mode === 'turn' && !turnResult.analysis) {
      const error = new Error('Slack Agent turn response is missing analysis');
      error.status = 502;
      throw error;
    }
    if (turnResult.turn) {
      turnResult.turn.replyMessage = replyMessage;
      turnResult.turn.replyStart = replyStart;
      if (!turnResult.turn.eventsRecorded) {
        await recordSlackAgentTurnEvents(store, turnResult.turn, replyMessage);
      }
    }

    return turnResult;
  } catch (err) {
    await failSlackAgentReplyMessage(env, store, body, replyMessage);
    throw err;
  }
}

export function slackAgentEndpointConfigured(env = {}) {
  return Boolean(slackAgentEndpoint(env));
}
