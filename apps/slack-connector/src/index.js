import slackBolt from '@slack/bolt';

import { readConfig } from './config.js';
import { createMessageDedupeCache, markMessageProcessed, startSlackDirectMessagePoller } from './dm-poller.js';
import {
  buildGatewayPayload,
  buildSlackReaction,
  buildSlackAckText,
  buildSlackReplyMessage,
  classifySlackEvent,
  inferSlackChannelType,
  postGatewayEvent,
  shouldReplyToGatewayResult,
} from './slack-event.js';

const { App } = slackBolt;

function summarizeSlackEvent(event, extra = {}, options = {}) {
  const text = event?.text || '';
  const summary = {
    service: 'pages-slack-connector',
    type: event?.type || null,
    subtype: event?.subtype || null,
    channel: event?.channel || null,
    channelType: inferSlackChannelType(event),
    user: event?.user || null,
    threadTs: event?.thread_ts || null,
    ts: event?.ts || null,
    textLength: text.length,
    ...extra,
  };
  if (options.includeText) {
    summary.text = text;
  }
  return summary;
}

function ignoredDuplicateSummary(event) {
  return summarizeSlackEvent(event, {
    message: 'slack_event_duplicate_ignored',
    reason: 'duplicate_message_ts',
  });
}

async function addWorkingReaction(client, event, config, logger) {
  if (!config.reactionOnReceive) return;

  const reaction = buildSlackReaction(event, config.workingReaction);
  if (!reaction) return;

  try {
    await client.reactions.add(reaction);
    console.log(
      JSON.stringify(
        summarizeSlackEvent(event, {
          message: 'slack_reaction_added',
          reaction: reaction.name,
        })
      )
    );
  } catch (err) {
    const error = err?.data?.error || err?.message || 'unknown_error';
    console.log(
      JSON.stringify(
        summarizeSlackEvent(event, {
          message: 'slack_reaction_failed',
          reaction: reaction.name,
          error,
        })
      )
    );
    if (error !== 'already_reacted') {
      logger?.warn?.(err);
    }
  }
}

async function handleSlackEvent({ body, event, client, logger }, config, fetchImpl = fetch, options = {}) {
  const classification = classifySlackEvent(event, {
    acceptBotEvents: config.acceptBotEvents,
    acceptThreadMessages: config.acceptThreadMessages,
  });

  if (!classification.target) {
    if (config.logIgnoredEvents && (event?.channel_type === 'im' || event?.thread_ts || event?.subtype)) {
      console.log(
        JSON.stringify(
          summarizeSlackEvent(event, {
            message: 'slack_event_ignored',
            reason: classification.reason,
          })
        )
      );
    }
    return;
  }

  if (options.processedMessages && markMessageProcessed(options.processedMessages, event)) {
    console.log(JSON.stringify(ignoredDuplicateSummary(event)));
    return;
  }

  try {
    console.log(
      JSON.stringify({
        service: 'pages-slack-connector',
        message: 'slack_event_received',
        reason: classification.reason,
        type: event.type,
        subtype: event.subtype || null,
        channel: event.channel,
        channelType: event.channel_type || null,
        user: event.user || null,
        threadTs: event.thread_ts || null,
        ts: event.ts || null,
        text: event.text || '',
      })
    );
    await addWorkingReaction(client, event, config, logger);
    const payload = buildGatewayPayload(body, event, config);
    const result = await postGatewayEvent(fetchImpl, config.gatewaySlackUrl, payload, {
      connectorToken: config.gatewayConnectorToken,
    });
    console.log(
      JSON.stringify({
        service: 'pages-slack-connector',
        message: 'gateway_event_posted',
        action: result.action || null,
        accepted: result.accepted ?? null,
        jobId: result.jobId || null,
        issueUrl: result.workerStart?.response?.result?.issueUrl || null,
      })
    );

    if (config.replyOnReceive && shouldReplyToGatewayResult(result)) {
      await client.chat.postMessage(buildSlackReplyMessage(event, buildSlackAckText(result)));
    }
  } catch (err) {
    logger?.error?.(err);

    if (config.replyOnReceive && event.channel) {
      await client.chat.postMessage(
        buildSlackReplyMessage(event, `收到消息，但提交发布任务失败：${err.message}`)
      );
    }
  }
}

export function createSlackConnector(config = readConfig(), options = {}) {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });
  const fetchImpl = options.fetchImpl || fetch;
  const processedMessages = options.processedMessages || createMessageDedupeCache();
  const wrappedHandler = (args) => handleSlackEvent(args, config, fetchImpl, { processedMessages });

  app.event('app_mention', wrappedHandler);
  app.event('message', wrappedHandler);

  startSlackDirectMessagePoller({
    config,
    fetchImpl,
    client: app.client,
    logger: app.logger,
    processedMessages,
    onEvent: handleSlackEvent,
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createSlackConnector();
  await app.start();
  console.log('pages slack connector listening in Socket Mode');
}
