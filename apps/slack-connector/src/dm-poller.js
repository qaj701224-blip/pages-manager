export function createMessageDedupeCache(limit = 5000) {
  return {
    limit,
    keys: new Set(),
    order: [],
  };
}

export function messageDedupeKey(event = {}) {
  if (event.type !== 'message' || !event.channel || !event.ts) return '';
  return `${event.channel}:${event.ts}`;
}

export function markMessageProcessed(cache, event = {}) {
  const key = messageDedupeKey(event);
  if (!key) return false;
  if (cache.keys.has(key)) return true;

  cache.keys.add(key);
  cache.order.push(key);

  while (cache.order.length > cache.limit) {
    const oldest = cache.order.shift();
    if (oldest) cache.keys.delete(oldest);
  }

  return false;
}

async function slackGet(fetchImpl, token, method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.json();
}

function compareSlackTs(a, b) {
  return Number.parseFloat(a || '0') - Number.parseFloat(b || '0');
}

function isUserMessage(message = {}) {
  return message.type === 'message' && message.user && !message.bot_id && !message.subtype;
}

function buildPolledEventBody(teamId, channel, message) {
  return {
    type: 'event_callback',
    team_id: teamId,
    event_id: `poll:${teamId}:${channel.id}:${message.ts}`,
    event: {
      type: 'message',
      channel: channel.id,
      channel_type: 'im',
      user: message.user,
      ts: message.ts,
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      text: message.text || '',
    },
  };
}

export function createDirectMessagePollState() {
  return {
    teamId: null,
    lastSeenByChannel: new Map(),
  };
}

async function ensureTeamId(state, config, fetchImpl) {
  if (state.teamId) return state.teamId;

  const auth = await slackGet(fetchImpl, config.botToken, 'auth.test');
  if (!auth.ok || !auth.team_id) {
    throw new Error(`Slack auth.test failed: ${auth.error || 'missing_team_id'}`);
  }
  state.teamId = auth.team_id;
  return state.teamId;
}

async function listDirectMessageChannels(config, fetchImpl) {
  const channels = [];
  let cursor = '';

  while (channels.length < config.dmPollChannelLimit) {
    const result = await slackGet(fetchImpl, config.botToken, 'conversations.list', {
      types: 'im',
      limit: Math.min(200, Math.max(1, config.dmPollChannelLimit - channels.length)),
      cursor,
    });
    if (!result.ok) {
      throw new Error(`Slack conversations.list failed: ${result.error || 'unknown_error'}`);
    }

    channels.push(...(result.channels || []).filter((channel) => channel?.id));
    cursor = result.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }

  return channels.slice(0, config.dmPollChannelLimit);
}

async function readChannelHistory(config, fetchImpl, channelId, oldest) {
  const result = await slackGet(fetchImpl, config.botToken, 'conversations.history', {
    channel: channelId,
    limit: config.dmPollBatchSize,
    oldest,
    inclusive: false,
  });
  if (!result.ok) {
    throw new Error(`Slack conversations.history failed: ${result.error || 'unknown_error'}`);
  }

  return result.messages || [];
}

export async function pollSlackDirectMessagesOnce({ config, fetchImpl, client, logger, state, processedMessages, onEvent }) {
  const teamId = await ensureTeamId(state, config, fetchImpl);
  const channels = await listDirectMessageChannels(config, fetchImpl);
  let forwarded = 0;

  for (const channel of channels) {
    const lastSeen = state.lastSeenByChannel.get(channel.id) || '';
    const messages = await readChannelHistory(config, fetchImpl, channel.id, lastSeen);
    const ordered = [...messages].sort((a, b) => compareSlackTs(a.ts, b.ts));

    if (!lastSeen) {
      const latest = ordered.at(-1);
      if (latest?.ts) state.lastSeenByChannel.set(channel.id, latest.ts);
      continue;
    }

    for (const message of ordered) {
      if (message.ts) state.lastSeenByChannel.set(channel.id, message.ts);
      if (!isUserMessage(message)) continue;

      const body = buildPolledEventBody(teamId, channel, message);
      if (markMessageProcessed(processedMessages, body.event)) continue;

      await onEvent(
        {
          body,
          event: body.event,
          client,
          logger,
        },
        config,
        fetchImpl
      );
      forwarded += 1;
    }
  }

  return { forwarded, channelCount: channels.length };
}

export function startSlackDirectMessagePoller({ config, fetchImpl, client, logger, processedMessages, onEvent }) {
  if (!config.dmPollEnabled) return null;

  const state = createDirectMessagePollState();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await pollSlackDirectMessagesOnce({
        config,
        fetchImpl,
        client,
        logger,
        state,
        processedMessages,
        onEvent,
      });
      if (result.forwarded > 0) {
        console.log(
          JSON.stringify({
            service: 'pages-slack-connector',
            message: 'slack_dm_poll_forwarded',
            forwarded: result.forwarded,
            channelCount: result.channelCount,
          })
        );
      }
    } catch (err) {
      logger?.warn?.(err);
      console.log(
        JSON.stringify({
          service: 'pages-slack-connector',
          message: 'slack_dm_poll_failed',
          error: err.message,
        })
      );
    } finally {
      running = false;
    }
  };

  const timer = globalThis.setInterval(tick, config.dmPollIntervalMs);
  timer.unref?.();
  setTimeout(tick, 0).unref?.();

  return {
    state,
    stop() {
      globalThis.clearInterval(timer);
    },
  };
}
