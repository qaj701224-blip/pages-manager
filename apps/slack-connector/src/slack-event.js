function isIgnoredSubtype(event) {
  return Boolean(event.subtype && event.subtype !== 'bot_message');
}

function isBotEvent(event) {
  return Boolean(event.bot_id || event.subtype === 'bot_message');
}

function isDirectMessage(event) {
  return event.type === 'message' && event.channel_type === 'im';
}

function isAppMention(event) {
  return event.type === 'app_mention';
}

function isChannelThreadMessage(event) {
  return event.type === 'message' && event.channel_type !== 'im' && Boolean(event.thread_ts);
}

export function isTargetSlackEvent(event, options = {}) {
  if (!event || isIgnoredSubtype(event)) return false;
  if (isBotEvent(event) && !options.acceptBotEvents) return false;
  return Boolean(
    isDirectMessage(event) || isAppMention(event) || (options.acceptThreadMessages && isChannelThreadMessage(event))
  );
}

export function normalizeSlackText(text = '', options = {}) {
  let normalized = String(text).replaceAll(/\s+/g, ' ').trim();

  if (options.botUserId) {
    const mention = new RegExp(`^<@${options.botUserId}>\\s*`);
    normalized = normalized.replace(mention, '').trim();
  }

  return normalized;
}

export function buildGatewayPayload(body, event, config) {
  const teamId = body.team_id || body.team?.id || event.team || 'unknown-team';
  const normalizedText = normalizeSlackText(event.text || body.text || '', config);
  const eventId = body.event_id || `${teamId}:${event.channel || 'unknown-channel'}:${event.ts || Date.now()}`;

  return {
    type: body.type || 'event_callback',
    team_id: teamId,
    api_app_id: body.api_app_id || null,
    enterprise_id: body.enterprise_id || null,
    event_id: eventId,
    event_time: body.event_time || null,
    authorizations: body.authorizations || [],
    employeeSlug: config.employeeSlug,
    siteSlug: config.siteSlug,
    text: normalizedText,
    connector: {
      name: 'pages-slack-connector',
      transport: 'socket_mode',
    },
    event: {
      ...event,
      text: normalizedText,
    },
  };
}

export function buildSlackAckText(result) {
  if (result?.replyText) return result.replyText;

  const jobId = result?.jobId || result?.job?.id || 'unknown';
  const issueUrl = result?.workerStart?.response?.result?.issueUrl || result?.result?.issueUrl;
  if (result?.created === false) {
    return issueUrl
      ? `收到，这条 Slack 消息已经关联到发布任务 ${jobId}。\nIssue: ${issueUrl}`
      : `收到，这条 Slack 消息已经关联到发布任务 ${jobId}。`;
  }
  return issueUrl ? `收到，已创建发布任务 ${jobId}。\nIssue: ${issueUrl}` : `收到，已创建发布任务 ${jobId}。`;
}

export function shouldReplyToGatewayResult(result = {}) {
  if (result.reply === false || result.noReply) return false;
  if (result.replyText === null) return false;
  return result.action !== 'ignored_untracked_thread_message';
}

function slackUserMention(userId) {
  const normalized = String(userId || '').trim();
  if (!normalized || !/^[A-Z0-9]+$/i.test(normalized)) return '';
  return `<@${normalized}>`;
}

export function mentionSlackUser(text, userId) {
  const mention = slackUserMention(userId);
  if (!mention) return text;
  if (String(text).startsWith(mention)) return text;
  return `${mention} ${text}`;
}

export function buildSlackReplyMessage(event, text) {
  const message = {
    channel: event.channel,
    text: mentionSlackUser(text, event.user),
  };

  if (event.channel_type !== 'im') {
    message.thread_ts = event.thread_ts || event.ts;
  }

  return message;
}

export async function postGatewayEvent(fetchImpl, gatewaySlackUrl, payload, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (options.connectorToken) {
    headers['X-Pages-Slack-Connector-Token'] = options.connectorToken;
  }

  const response = await fetchImpl(gatewaySlackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || body?.ok === false) {
    const message = body?.error || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Gateway Slack event rejected: ${message}`);
  }

  return body || {};
}
