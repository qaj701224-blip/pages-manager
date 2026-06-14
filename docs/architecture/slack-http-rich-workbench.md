# Slack HTTP Rich Workbench

## 定位

本文定义 `pages-manager` 在正式 K8s 运行态里的 Slack 右侧体验：Slack thread 是用户工作台，用户通过自然语言和按钮推进发布任务，平台把需求理解、issue、PR、review、fix、preview 的状态实时回写到同一个 thread。

本文只覆盖 Slack HTTP 入口、富交互、实时回写和 notifier 运行时边界。身份绑定和登录链路不在本文范围内；本文默认 gateway 已能拿到可信的 Slack actor，并按现有 `SlackSession` 用户隔离规则处理会话。

非目标：

- 不做本地 IDE 远程控制。
- 不使用 Socket Mode，也不保留 Socket fallback。
- 不让 coding-agent、builder、site-check、deployer 直接调用 Slack。
- 不把 Slack bot token 传给 GitHub Actions runner 或一次性 K8s Job。
- 不把模型内部推理、system prompt、debug trace、token、secret 回写到 Slack。

## 当前分支快照

当前 `feat/slack-preview-gateway` 已经具备这些基础：

| 能力                     | 当前位置                               | 说明                                            |
| ------------------------ | -------------------------------------- | ----------------------------------------------- |
| Slack HTTP Events        | `apps/gateway/src/index.js`            | `POST /integrations/slack/events`               |
| Slack Interactivity      | `apps/gateway/src/index.js`            | `POST /integrations/slack/interactions`         |
| Slack signature 校验     | `apps/gateway/src/slack-http.js`       | 基于 raw body、timestamp、signing secret 校验   |
| URL verification         | `apps/gateway/src/handlers.js`         | 返回 Slack challenge                            |
| DM / channel thread 会话 | `apps/gateway/src/slack-session.js`    | `SlackSession` 按 Slack user 和 thread 隔离     |
| 基础状态卡片             | `packages/slack-notifier/src/index.js` | Block Kit 展示 stage、job、issue、PR、preview   |
| 原地更新卡片             | `packages/slack-notifier/src/index.js` | 首次 `chat.postMessage`，后续 `chat.update`     |
| 独立 notifier app        | `apps/slack-notifier/src/index.js`     | 内部 HTTP endpoint，K8s 正式路径持有 bot token  |
| gateway notifier adapter | `apps/gateway/src/slack-notifier.js`   | 调独立 notifier；本地无 URL 时走 fallback       |
| 基础按钮                 | `apps/gateway/src/handlers.js`         | `继续修改`、`关闭会话`                          |
| Agent 需求分析           | `apps/slack-agent/src/index.js`        | `/internal/slack-agent/analyze` 返回结构化 JSON |

当前还不是正式版：

| 缺口                                            | 影响                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| notifier 目前由 gateway 同步 HTTP fallback 触发 | 还不是 Redis Stream / Queue consumer，无法从 offset 自动恢复        |
| store 仍是 memory / file backed                 | K8s 多副本会丢幂等、lease、message binding 和 session 状态          |
| 实时回写只跟随阶段 callback                     | Slack Agent 和 executor 不能持续输出 `progress event`               |
| Interactivity 只覆盖两个按钮                    | 还缺取消、重新生成、确认需求、选择站点、转人工确认等命令事件        |
| Slack API 调用没有持久重试                      | `chat.postMessage` / `chat.update` 失败后只能返回错误，不能可靠补偿 |
| Preview 只有链接                                | 还没有截图、图片 block 或文件上传链路                               |

## 正式拓扑

正式 K8s 运行态应把 Slack 入口、任务状态、Agent 输出和 Slack 回写拆成事件驱动链路：

```text
Slack Events API / Interactivity
  ↓ HTTPS
Ingress
  ↓
pages-gateway
  - 校验 Slack signature / timestamp
  - 记录 SlackEvent / SlackMessageBatch
  - 维护 SlackSession / SessionMemory / IssueLink
  - 创建 PublishingJob / AgentRun
  - 写 JobEvent / AgentRunEvent
  ↓
MySQL + Redis Stream / Queue
  ↓
slack-agent / pages-worker
  - 通过 gateway/repository 写 JobEvent / AgentRunEvent

executor
  ↓ /internal/executor-callback 或受控 gateway API
pages-gateway
  - 校验 attempt 后写 JobEvent
  ↓
MySQL + Redis Stream / Queue
  ↓
slack-notifier
  - 消费 JobEvent / AgentRunEvent
  - 节流、去重、retry、rate limit
  - chat.postMessage / chat.update / reactions.add
  ↓
Slack thread
```

关键边界：

- `pages-gateway` 是无状态 HTTP 入口和状态机入口，不长期持有 Slack 输出循环。
- `slack-agent` 只做需求理解、澄清、续接判断和摘要，不写代码、不创建 PR、不部署。
- `pages-worker` 和 executor 推进 issue、PR、review、preview，但不直接发 Slack。
- executor 不直接写 MySQL / Redis 的最终业务状态；它只能 callback gateway，由 gateway 校验 attempt 后写状态和事件。
- `slack-notifier` 是唯一负责 Slack Web API 输出的组件。
- MySQL 是最终状态真相源；Redis / queue 只做短期协调、事件分发、lease 和 rate limit。

## HTTP 入口合同

### Events

```text
POST /integrations/slack/events
```

处理顺序：

1. 读取 raw body。
2. 校验 `X-Slack-Signature` 和 `X-Slack-Request-Timestamp`。
3. `url_verification` 直接返回 challenge。
4. 普通事件生成非空 `dedupe_key`。
5. 写入 `SlackEvent` 和 `SlackMessageBatch`。
6. 在 3 秒内 ACK。
7. 通过 queue / `waitUntil` / 后台 worker enqueue `slack-agent.turn`，或直接推进确定性命令。

事件入口不得同步等待 coding-agent、GitHub Actions、preview deploy 或 Slack notifier 完成。

### Interactions

```text
POST /integrations/slack/interactions
```

处理顺序：

1. 读取 form encoded `payload` 的 raw body。
2. 校验 Slack signature。
3. 解析 `type`、`action_id`、`value`、`team.id`、`user.id`、`channel.id`、`message.ts`。
4. 写入 `SlackInteractionEvent` 或等价 command event。
5. 立刻 ACK，可用 ephemeral 文本提示“已收到”。
6. 通过 queue / `waitUntil` / 后台 worker 交给 gateway / orchestrator 处理实际动作。

按钮点击不能直接依赖 message 里的文本内容，必须用 `action_id + value` 回查 `SlackSession`、`PublishingJob` 或 `SlackMessageBinding`。

interaction 的 dedupe key 必须来自稳定字段，例如：

```text
team_id + payload.type + action_id + action_ts + user.id
team_id + message.channel + message.ts + action_id + user.id + full_payload_hash
```

`action_ts` 或等价的单次点击 id 用来区分用户第二次合法点击；`full_payload_hash` 必须来自 Slack 原始 interaction payload，并覆盖 `actions[].action_ts`、`trigger_id`、message 定位和 action value，让 Slack retry 命中同一条记录。如果 payload 缺少单次点击 id，不能退化成只用 `channel + message.ts + action_id + user.id`；必须引入完整 payload hash 或平台生成的一次性 command id。长 dedupe key 入库时保留原文用于排障，同时用 SHA-256 `dedupe_key_hash` 或 `dedupe_unique_key` 承载唯一约束，避免 MySQL nullable / 长字符串 unique 的坑。

如果同一个按钮 payload 被 Slack retry，gateway 只能重复 ACK，不能重复关闭会话、重复启动 fix round 或重复创建 job；如果用户之后再次点击同一按钮，应生成新的 interaction 记录，再由业务状态机决定是否接受。

### Commands

```text
POST /integrations/slack/commands
```

Slash command 不是第一优先级，但正式入口要保留同样合同：签名校验、非空 dedupe、快速 ACK、后台 enqueue。`/pages`、`/preview`、`/site` 这类命令只作为快捷入口，不能绕过 Slack Agent 和 gateway 状态机。

## 状态和事件模型

正式版至少需要这些持久对象：

| 对象                       | 用途                                                    |
| -------------------------- | ------------------------------------------------------- |
| `SlackEvent`               | Slack HTTP event 幂等、审计和重放                       |
| `SlackMessageBatch`        | 同一 thread / turn 的用户消息聚合和上下文来源           |
| `SlackSession`             | `(team_id, slack_user_id, session_key)` 维度的会话状态  |
| `SessionMemory`            | 需求摘要、待澄清问题、偏好、最近一次 preview feedback   |
| `IssueLink`                | Slack session 与 job / issue / PR / preview 的关联      |
| `PublishingJob`            | 发布任务状态机                                          |
| `AgentRun`                 | Slack Agent 或 Coding Agent 的单轮运行                  |
| `AgentRunEvent`            | Agent 对用户可见的进度、摘要、澄清、错误                |
| `JobEvent`                 | job 阶段变化、callback、review、preview、失败           |
| `SlackMessageBinding`      | job/session 到 Slack card/message `channel + ts` 的绑定 |
| `SlackNotificationAttempt` | Slack API 调用尝试、错误、重试、rate limit              |
| `ExternalApiCallLog`       | Slack/GitHub/Cloudflare/model provider 调用摘要         |

`SlackMessageBinding` 是 `chat.update` 的关键。没有它，notifier 只能不断发新消息，无法稳定更新同一张状态卡片。如果 DB schema 已有最小形态的 `slack_job_status_messages`，可作为第一步承接状态卡片 `channel + message_ts`；正式富交互阶段再扩展为支持多 message kind、stage order 和通知尝试记录的 binding 模型。

注意：`SlackMessageBinding`、`SlackNotificationAttempt` 和 `ExternalApiCallLog` 是本文面向正式富交互提出的 schema 扩展目标。MVP 闭环可以在同一个 PR 里同步补齐最小 DB schema / migration；如果文档先于 DB 改动合并，则不能假设当前 `db-schema-v0.md` 已经完整定义这些表。

建议字段：

```text
SlackMessageBinding
  id
  publishing_job_id
  slack_session_id
  team_id
  channel_id
  thread_ts
  message_ts
  message_kind: status_card | milestone | clarification | error
  last_stage
  last_stage_order
  last_event_id
  status
  created_at
  updated_at
```

`AgentRunEvent` / `JobEvent` 建议统一带：

```text
event_id
publishing_job_id
slack_session_id
agent_run_id
attempt_no              # optional，job stage event 使用
job_stage_attempt_id    # optional，job stage event 使用
source_attempt_id       # optional，executor callback / retry 场景使用
type
stage
status
text
dedupe_key
stage_order
visible_to_user
created_at
```

`stage_order` 应来自 workflow core / 状态机里的有序阶段定义，不应从 Slack `ts`、message 更新时间或事件到达时间推导。

`AgentRunEvent` 不一定绑定 `JobStageAttempt`：Slack Agent 的澄清、摘要、需求确认可能发生在 job stage attempt 之前。只有事件携带 attempt id 时，notifier 才做 active attempt 校验；没有 attempt 的 Agent 事件应按 `agent_run_id`、session lease 和 `dedupe_key` 校验。

`visible_to_user=false` 的事件只能进入日志和 Admin Console，不能进入 Slack。

### 事件顺序和旧事件保护

Slack 回写不能被旧 callback 或旧 attempt 覆盖。notifier 更新状态卡片前必须检查：

- `publishing_job_id` 是否仍存在且未归档。
- 如果事件携带 `source_attempt_id` / `job_stage_attempt_id` / `attempt_no`，它是否仍是当前 job 的 active attempt。
- 如果事件没有 attempt id，`agent_run_id`、session lease 和 `dedupe_key` 是否仍然有效。
- `stage_order` 是否不早于 `SlackMessageBinding.last_stage_order`。
- `dedupe_key` 是否未被成功消费。

如果旧事件晚到：

- 写入 `JobEvent` / `AuditLog`，保留排障证据。
- 不更新 `PublishingJob` 当前状态。
- 不更新 Slack 状态卡片。
- 需要时可以发一条内部诊断日志，不能打扰用户。

## Slack 工作台消息策略

Slack 右侧体验由三类消息组成：

| 类型         | Slack API                          | 用途                                                |
| ------------ | ---------------------------------- | --------------------------------------------------- |
| 状态卡片     | `chat.postMessage` + `chat.update` | 当前 job 的实时状态，持续更新同一条消息             |
| 关键节点消息 | `chat.postMessage`                 | issue / PR / preview / failure 等稳定链接，便于回看 |
| 临时提示     | ephemeral response 或 thread reply | 按钮 ACK、澄清问题、权限/会话提示                   |

### 状态卡片

新 job 创建时，notifier 发一张状态卡片：

```text
Header: Pages 发布任务
Section: 当前阶段 + 需求摘要
Fields:
  当前阶段
  目标 employee/site
  Job id
  状态
  Issue
  PR
  Preview
Context:
  继续修改可以直接在这个 thread 里回复
Actions:
  查看 Issue
  查看 PR
  打开 Preview
  继续修改
  关闭会话
```

后续 `JobEvent` / `AgentRunEvent` 到达时，notifier 更新同一张卡片：

```text
received
issue_created
index_ready
generating_page
pr_created
reviewing
changes_requested
fixing
previewing
preview_deployed
failed
```

### 关键节点消息

这些节点建议单独发 thread 消息：

- issue 创建完成。
- PR 创建完成。
- Review Agent 发现 blocking / unknown。
- Preview URL 生成完成。
- 任务失败且需要用户行动。

状态卡片负责“现在到哪了”，关键节点消息负责“重要链接和可回看记录”。

### 实时回写

实时回写不是 token-by-token 刷屏。正式版按事件节流：

- 阶段变化立即更新。
- 同一阶段的普通进度 1 到 3 秒聚合更新一次。
- 同一 `dedupe_key` 只能更新一次。
- milestone message 与 status card 分开 dedupe；同一个 stage 可以更新卡片一次，也可以发一条稳定 milestone，但不能因为 retry 重复发 milestone。
- Slack rate limit 时写 `SlackNotificationAttempt`，延迟重试，不回滚 job 状态。
- 如果 `chat.update` 失败且错误不可恢复，可以补发一条新的状态卡片，并更新 `SlackMessageBinding`。
- 每次 `chat.postMessage`、`chat.update`、`reactions.add` 都写 `ExternalApiCallLog(provider=slack)` 的脱敏摘要，方便 Admin Console 判断是 Slack API 失败、rate limit、权限错误还是 message binding 丢失。

Agent 允许回写的内容：

- 需求摘要。
- 澄清问题。
- 已接收的修改意见。
- 当前正在执行的可理解步骤。
- 错误提示和下一步建议。

Agent 不允许回写的内容：

- 模型内部推理。
- system / developer prompt。
- 原始 provider response。
- token、secret、cookie、API key。
- GitHub / Cloudflare / Slack credential。

## Interactivity 动作

按钮 `action_id` 建议使用 `pages_` 前缀，`value` 使用 JSON 或短 id；敏感信息不能放在 `value` 里。

| Action                      | 第一版行为                             | 后台事件                   |
| --------------------------- | -------------------------------------- | -------------------------- |
| `pages_continue_modifying`  | ephemeral 提示用户直接在 thread 里回复 | 可选写 `CommandEvent`      |
| `pages_close_session`       | 关闭当前用户拥有的 session             | `session.close_requested`  |
| `pages_cancel_job`          | 请求取消或转人工确认                   | `job.cancel_requested`     |
| `pages_regenerate`          | 对同一 PR branch 启动新 fix round      | `job.regenerate_requested` |
| `pages_confirm_requirement` | 确认摘要并创建 job                     | `job.confirm_requested`    |
| `pages_open_admin`          | 打开内部控制台链接                     | 只生成 URL，不推进状态     |

交互处理规则：

- 必须校验 action caller 是否拥有对应 `SlackSession`。
- 对已经关闭或归档的 session 返回 ephemeral 提示，不重新激活。
- 对正在运行的 session 使用 lease，不能并发触发两个 fix round。
- 每个 interaction payload 要有 dedupe 记录，Slack retry 不能重复触发命令。
- URL button 只用于打开 issue / PR / preview；会改变状态的动作必须走 action callback。
- action `value` 只能放短 id 或无敏 JSON，例如 `{"jobId":"job_xxx","sessionId":"sess_xxx"}`；不能放 token、cookie、一次性授权码或内部 secret。

## 独立 slack-notifier

正式版 `slack-notifier` 应是独立 Deployment。MVP 可以保留 gateway 内置 adapter 作为本地 fallback，但 K8s 正式运行路径应优先走独立 `slack-notifier`，让 gateway 只负责接收事件、推进状态机和写事件。

从 gateway 拆出的原因：

- Slack Web API 是慢 I/O，并且会遇到 rate limit、`message_not_found`、`channel_not_found`、`invalid_auth` 等需要重试或死信的错误；这些不应该阻塞 Slack/GitHub webhook 入口 ACK。
- gateway 需要保持无状态、可横向扩容，并专注签名校验、幂等、权限和状态机；Slack 输出循环属于通知投递，不属于入口状态推进。
- Secret 边界更清楚：正式 K8s 中 `SLACK_BOT_TOKEN` 只进入 `slack-notifier`，gateway 只需要 `SLACK_SIGNING_SECRET` 和内部 notifier shared secret。
- 发生 Slack API 故障时，只影响通知投递和补偿，不影响 gateway 继续接收 Slack / GitHub / executor callback。
- notifier 可以独立扩缩容、限流和排队；Slack 回写高峰不需要同步扩 gateway。

职责：

- 消费 `JobEvent` / `AgentRunEvent`。
- 查询 `SlackMessageBinding`。
- 构建 Block Kit。
- 调 `chat.postMessage`、`chat.update`、`reactions.add`。
- 处理 Slack rate limit。
- 写 `SlackNotificationAttempt` 和 `ExternalApiCallLog`。
- 对失败请求做重试、死信和人工补偿入口。
- 提供内部 HTTP fallback endpoint，供 MVP 阶段 gateway 在写入事件后同步请求一次投递；后续切到 Redis Stream / Queue consumer。

不负责：

- 判断用户意图。
- 创建 issue / PR。
- 部署 preview。
- 读取 GitHub token 或 Cloudflare token。
- 修改 `PublishingJob` 业务状态。

多副本要求：

```text
slack-notifier replicas=N
  ↓
Redis consumer group / queue lease
  ↓
同一 event 只有一个 consumer 发送 Slack
```

如果 Slack API 调用成功但 ACK 写 DB 失败，notifier 必须能通过 `dedupe_key`、`channel + message_ts` 和 `SlackNotificationAttempt` 恢复，避免重复刷屏。

`SlackNotificationAttempt` 建议状态：

```text
pending
sent
rate_limited
retry_scheduled
failed
dead_letter
superseded
```

重试规则：

- `rate_limited` 按 Slack 返回的 retry hint 或平台默认 backoff 延迟重试。
- `invalid_auth`、`channel_not_found`、`not_in_channel` 这类配置问题进入 `dead_letter` 并暴露给 Admin Console。
- `message_not_found` 且原消息是 status card 时，可以补发新卡片并更新 `SlackMessageBinding`。
- notifier 重试不能修改 `PublishingJob` 状态，只能修改通知尝试状态和 message binding。

## Preview 截图

Preview 截图是富展示的后续增强，不阻塞状态卡片：

```text
preview_deployed
  ↓
browser / screenshot worker
  ↓
PNG artifact / object storage
  ↓
JobEvent(preview_screenshot_ready)
  ↓
slack-notifier 更新状态卡片或追加图片消息
```

规则：

- 截图失败不能让 `preview_deployed` 回滚。
- 截图 worker 不持有 Slack token。
- 图片 URL 如果用于 Slack `image` block，必须是 Slack 可访问地址。
- 如果图片含内部页面内容，需要先确认访问策略，不要把受限内容上传到不受控位置。

## K8s 多副本验收

正式版声称 Slack 工作台可用时，至少满足：

- `pages-gateway` 可多副本，重启任意 Pod 不丢 Slack session 和 job 状态。
- Slack Events / Interactivity 只走 HTTP Ingress，不启 Socket Mode。
- `SlackEvent` 和 interaction payload 有持久幂等记录。
- `SlackMessageBinding` 落库，`chat.update` 目标可恢复。
- `slack-notifier` 独立运行，Slack bot token 不进入 executor。
- `JobEvent` / `AgentRunEvent` 可重放，notifier 可从上次 offset 继续消费。
- Slack API 失败有 retry / dead-letter / admin renotify 路径。
- 同一 job 不会因为 gateway / notifier 多副本而重复创建 issue、重复启动 fix round 或重复刷 Slack。

## 实现顺序

当前 PR 先完成职责拆分的 MVP：抽出 `apps/slack-notifier` 和 `@xd/slack-notifier-core`，gateway 通过内部 HTTP 调 notifier，K8s 正式路径不再给 gateway 注入 `SLACK_BOT_TOKEN`。

后续推荐按这些 PR 拆：

1. 抽象 gateway store，落 MySQL repository；内存 / 文件 store 只保留测试 fixture。
2. 引入 Redis queue / stream，用于 Slack event、AgentRunEvent、JobEvent 和 notifier lease。
3. 为 `SlackMessageBinding`、`SlackNotificationAttempt`、`ExternalApiCallLog` 建表和 repository；MVP 可以和 Slack runtime 改动放在同一个 PR，但 schema / migration diff 需要单独成块，方便 review。
4. 如果 DB schema 已有 `slack_events`、`slack_sessions`、`agent_run_events`、`slack_job_status_messages`、`external_api_call_logs` 等雏形，优先演进这些表，而不是另起一套平行存储。
5. gateway 新增“只写事件 + 等待 notifier 消费”模式，notifier 切到 Redis Stream / Queue consumer。
6. slack-agent / worker 增加可见 progress event 上报。
7. 扩展 interactions：cancel、regenerate、confirm、admin link。
8. 增加 preview screenshot worker 和图片回写。

## Review checklist

实现或 review Slack 富交互相关 PR 时，至少检查：

- [ ] 没有重新引入 Socket Mode 或本地 listener。
- [ ] Slack HTTP 请求使用 raw body 校验 signature。
- [ ] 入口 handler 不同步等待长任务。
- [ ] 每个 Slack event / interaction 都有非空 dedupe key。
- [ ] interaction dedupe 包含 `action_ts` / 单次点击 id，或覆盖 `actions[].action_ts`、`trigger_id`、message 和 action value 的完整 raw payload hash，不会把用户第二次合法点击误判成 retry。
- [ ] 状态卡片 `channel + message_ts` 持久化。
- [ ] `chat.update` 失败有补偿策略。
- [ ] 旧 attempt / 旧 stage 事件不会覆盖新状态卡片。
- [ ] executor progress 通过 `/internal/executor-callback` 或受控 gateway API 进入状态机，不直接写 DB / Redis 最终状态。
- [ ] 正式 K8s 路径下 Slack bot token 只进入独立 `slack-notifier`；gateway 只允许本地 fallback 临时持有。
- [ ] executor / GitHub Actions / coding-agent 不持有 Slack token。
- [ ] Agent 回写内容经过 secret-like 脱敏。
- [ ] 多副本下不会重复发消息或重复推进 job。
