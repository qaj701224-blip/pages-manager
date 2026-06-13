# Slack Connector

`@xd/slack-connector` is the long-running Slack Socket Mode adapter for the pages platform.

It owns the Slack connection and bot token. It does not create issues, PRs, preview deploys, or platform state directly. Every accepted Slack event is forwarded to `pages-gateway`:

```text
Slack Socket Mode
  ↓
apps/slack-connector
  ↓
POST /integrations/slack/events
  ↓
apps/gateway
```

## Local Run

Use environment variables from your private secret store. Do not commit real Slack tokens.

```bash
SLACK_BOT_TOKEN='xoxb-...' \
SLACK_APP_TOKEN='xapp-...' \
PAGES_GATEWAY_SLACK_URL='http://localhost:8788/integrations/slack/events' \
PAGES_GATEWAY_CONNECTOR_TOKEN='local-shared-secret' \
npx pnpm@9.15.0 --dir apps/slack-connector dev
```

Required Slack settings:

- Socket Mode: on
- Event Subscriptions: on
- Bot events: `app_mention`, `message.im`
- Bot scopes: `app_mentions:read`, `im:history`, `chat:write`
- App-level token scope: `connections:write`

The `xoxb` bot token and `xapp` app token must belong to the same Slack App.

## Local Smoke Messages

In a DM with the bot, send a normal Slack message:

```text
issue: 帮 smoke/profile 做一个测试页面
```

In a channel, mention the bot:

```text
@效率助手 issue: 帮 smoke/profile 做一个测试页面
```

Do not use `/issue` for the Socket Mode smoke path. Slack treats that as a Slash Command instead of a normal message event, and this connector does not receive it unless a separate Slash Command endpoint is configured.
