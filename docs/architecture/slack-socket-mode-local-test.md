# Slack Socket Mode Local Test

## 定位

这份文档记录 Slack Socket Mode 本地验证结论，用于 `pages-manager` MVP Slack 入口开发和排障。

结论：

```text
Slack 私聊
  ↓
Socket Mode
  ↓
本地 Node listener
  ↓
bot 回复
```

这条链路已经验证可用，可以作为本地开发和内网环境早期联调方式。

生产默认仍建议优先使用 HTTP Events API 进入 `pages-gateway`。如果公司网络暂时不方便暴露公网 HTTPS，Socket Mode 可以作为 MVP 的入口方案，但事件最终仍要转交给 gateway，由 gateway 做签名/身份/幂等/审计/状态机处理。

## 临时测试目录

本地验证目录：

```text
/tmp/slack-mention-test
```

主要脚本：

```text
/tmp/slack-mention-test/listen.mjs
/tmp/slack-mention-test/start-local.sh
/tmp/slack-mention-test/check-local.sh
/tmp/slack-mention-test/.env.local
```

`.env.local` 是本机私有文件，不能提交到 repo，也不能复制真实 token 到文档。

示例格式：

```bash
SLACK_BOT_TOKEN='xoxb-...'
SLACK_APP_TOKEN='xapp-...'
SLACK_EXPECTED_APP_ID='<expected-slack-app-id>'
```

## Slack App 配置

Bot scopes:

```text
app_mentions:read
im:history
chat:write
reactions:write
```

App-Level Token:

```text
xapp-...
scope: connections:write
```

Slack App settings:

```text
Socket Mode: On
Event Subscriptions: On
Bot events: app_mention, message.im
App Home -> Messages Tab: On
```

修改权限、事件订阅或 App Home 设置后，需要重新 install / approve。

## 关键排查结论

`xoxb` 和 `xapp` 必须属于同一个 Slack App。

错误组合示例：

```text
xoxb 来自 App A
xapp 来自 App B
```

这种情况下，bot token identity 和 Socket hello 里的 app id 会不一致，Socket Mode 可能能连接，但事件和 bot 身份不属于同一个应用，导致监听或回复行为异常。

## 本地校验项

`check-local.sh` 应校验：

```text
Bot token identity
  user
  bot_id

Bot info lookup
  name
  app_id

Socket hello
  app_id
```

通过条件：

```text
bot app_id == socket app_id == SLACK_EXPECTED_APP_ID
```

不要只检查 token 是否能调用 Slack API。必须检查 bot token 和 app-level token 是否属于同一个 Slack App。

## 已验证行为

启动本地监听：

```bash
/tmp/slack-mention-test/start-local.sh
```

向 bot 私聊发送：

```text
1
```

listener 收到：

```text
channel_type = im
text = "1"
```

bot 回复成功：

```text
收到。我已通过私聊监听成功：channel=<im-channel-id>
```

## 和 pages-manager 的关系

本地脚本只证明 Slack 实时入口可用。进入 `pages-manager` 后，不能让 listener 直接创建 PR、直接部署或直接写最终状态。

推荐集成方式：

```text
Slack Socket Mode listener
  ↓
pages-gateway internal endpoint
  ↓
SlackEvent 幂等
  ↓
apps/slack-agent 总结 thread / DM
  ↓
gateway 创建 PublishingJob
```

边界：

- Socket listener 只负责接收 Slack envelope、ack、转交 gateway。
- `pages-gateway` 仍负责 actor 解析、权限、幂等和审计。
- `apps/slack-agent` 负责 thread / DM 上下文总结、session / memory / issue link 续接判断。
- `slack-notifier` 仍负责回写 Slack。
- coding agent、GitHub Actions runner、deployer workflow/job 都不能拿 Slack bot token。

## MVP 建议

如果生产公网 HTTPS 入口准备顺利：

```text
Slack Events API -> pages-gateway
```

如果公网 HTTPS / 企业网络审批卡住：

```text
Slack Socket Mode -> slack-socket-connector -> pages-gateway internal endpoint
```

两种模式写入同一张 `SlackEvent` 表，使用同一套 dedupe、identity binding、TrustedSlackBotPolicy、PublishingJob 和 Slack 回写逻辑。

## 安全要求

- 不提交 `.env.local`。
- 不把 `xoxb`、`xapp`、signing secret、cookie、session 写入文档或日志。
- 本地日志可以打印 app id、bot id、channel id，但生产日志应避免打印完整 token、原始 payload 中的敏感字段。
- `SLACK_EXPECTED_APP_ID` 可作为环境校验项，但不同环境应使用各自配置。
