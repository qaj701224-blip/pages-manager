import slackBolt from '@slack/bolt';

import { readConfig } from './config.js';
import {
  buildGatewayPayload,
  buildSlackAckText,
  buildSlackReplyMessage,
  isTargetSlackEvent,
  postGatewayEvent,
  shouldReplyToGatewayResult,
} from './slack-event.js';

const { App } = slackBolt;

async function handleSlackEvent({ body, event, client, logger }, config, fetchImpl = fetch) {
  if (!isTargetSlackEvent(event, { acceptBotEvents: config.acceptBotEvents })) return;

  try {
    console.log(
      JSON.stringify({
        service: 'pages-slack-connector',
        message: 'slack_event_received',
        type: event.type,
        channel: event.channel,
        channelType: event.channel_type || null,
        user: event.user || null,
        text: event.text || '',
      })
    );
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

  app.event('app_mention', async (args) => handleSlackEvent(args, config, fetchImpl));
  app.event('message', async (args) => handleSlackEvent(args, config, fetchImpl));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createSlackConnector();
  await app.start();
  console.log('pages slack connector listening in Socket Mode');
}
