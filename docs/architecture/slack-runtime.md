# Slack Runtime

## Slack 跑在哪

Slack 分三层理解：

```text
Slack Platform
  外部 SaaS，负责消息、事件、slash command、interactive action

Slack App / Bot
  统一的平台机器人身份，安装在公司 Slack workspace

pages-manager Slack runtime
  跑在 pages-manager 自己的常驻平台服务中
```

也就是说，Slack 本身不跑在我们的 K8s，也不跑在 GitHub Actions。Slack bot 的运行逻辑跑在 `pages-manager` 的常驻服务里：本地、测试服务器和生产都跑在 K8s 的 `pages-system` namespace 或对应系统 namespace，并沿用同一套控制面 manifests。

当前采用 Slack HTTP Events / Interactivity 直达 K8s `pages-gateway`，不再使用 Socket Mode listener，也不保留 Socket fallback：

```text
Slack Events API / Interactivity
  ↓
POST /integrations/slack/events
POST /integrations/slack/interactions
  - Slack signature
  - 3 秒内 ack
  ↓
apps/gateway
  - 校验 Slack signature / timestamp
  - 幂等接收 SlackEvent
  - 对原消息添加 working reaction
  - 调用 apps/slack-agent 做需求分析
  - 推进后续 issue / coding agent / PR / preview 状态
  - 使用 chat.postMessage / chat.update 回写同一个 Slack thread
```

gateway 收到目标消息后会先对用户原消息添加 `SLACK_WORKING_REACTION`，默认是 `eyes`，让用户立刻知道 Agent 已开始处理。这个 feedback 不参与任务状态机，失败时只记日志，不阻塞 Slack Agent / worker 流程。Slack App 需要授予 `reactions:write` 后重新安装 / 审批，否则日志会出现 `slack_reaction_failed`，但消息仍会继续处理。

为了排查 DM / thread 里“用户发了消息但平台没回复”的问题，gateway 会记录被忽略事件的原因，例如 `ignored_subtype:message_replied`、`ignored_bot_event`、`unsupported_event`。如果 Slack 里有消息但 gateway 没有对应日志，优先检查 Slack App 的 Event Subscriptions、Request URL、Bot scopes、App Home Messages Tab、是否 reinstall / approve，以及公网 tunnel / Ingress 是否仍然指向当前 K8s gateway。

当前代码中的 `apps/slack-agent` 可以用确定性 adapter 兜底，也可以调用公司模型网关。无论实现细节如何，它都必须作为服务器常驻 Agent runtime 跑在 K8s / 服务器上，持续处理同一 Slack DM 或 thread 的多轮消息，并在每轮消息到达时加载持久 session、调用配置的模型供应商、输出结构化 intent 和工具调用请求。

模型能力统一来自公司 Agent Gateway；底层模型切换由公司网关负责，`pages-manager` 不直接接入外部模型供应商协议。Slack Agent 只能起草需求摘要、issue 内容、澄清问题、续接判断和工具调用请求；issue 创建、PR 创建、preview deploy 仍由 gateway / worker / controlled committer 这些平台组件执行。

Slack Agent 每次调用模型都会输出一条 `slack_agent_model_call` 审计日志，字段包括 provider、model、status、durationMs、Slack team/channel/user/thread metadata、intent、needsClarification、脱敏后的 `userText` 和脱敏后的完整 prompt messages。日志不能记录 Authorization header、API key、Slack token、GitHub token、cookie、password 等 secret；如果用户原文或 prompt 中出现 token-like 内容，必须先替换为 `[REDACTED_*]` 再写入日志。

当前已支持 active session 续接：用户拿到 preview 后在同一 DM 或 mention thread 里继续说“这个 preview 不满意 / 继续改 / 调整设计”，gateway 会先用 `SlackSession` 和 `IssueLink` 定位当前 job / issue / PR，把反馈写入 `SessionMemory`，再由 worker 追加原 issue comment 并 dispatch `pages-agent.yml(mode=fix)`。active 默认只保留 2 小时；如果同一用户有多个 active / recent session，gateway 必须要求用户选择，不能猜测要改哪个 preview。

推荐生产拓扑：

```text
Slack Platform
  ↓ HTTPS event / command / interaction
Ingress
  ↓
pages-gateway
  - 校验 Slack signature
  - 生成 dedupe_key 并做幂等
  - 解析 ExternalIdentityBinding
  - 记录 SlackEvent / SlackMessageBatch
  - enqueue slack agent job
  ↓
apps/slack-agent
  - 加载 SlackSession / SessionMemory / IssueLink
  - 按 Slack user 隔离会话，聚合该用户可见的 thread / channel 消息
  - 调用模型供应商 API 做多轮需求理解
  - 判断 new / follow-up / status / cancel / clarification
  - 请求 gateway 创建 PublishingJob 或追加 issue comment
  ↓
pages-worker
  - 推进 issue → coding agent → patch → PR → Review Agent comments → fix → preview deploy
  - 需要时调用 project-indexer 固定 agent context
  ↓
slack-notifier
  - 回写 Slack 进度和结果
```

## Namespace

Slack 相关常驻服务放在系统 namespace：

```text
namespace: pages-system
  ├─ pages-gateway
  ├─ slack-agent
  ├─ pages-worker
  ├─ slack-notifier
  ├─ redis / queue
  ├─ mysql
  └─ platform secrets
```

Actions executor 形态不需要 `pages-jobs` namespace，但仍然要保留同样的逻辑边界：Slack runtime 是常驻控制面，coding-agent、builder、site-check、controlled-committer、deployer 是一次性 executor 任务。

Slack 不放在 `page-job-<jobId>` namespace。Job namespace 只运行一次性任务，例如 coding-agent、builder、site-check、controlled-committer、deployer。

## Token 和 Secret 位置

Slack token 是平台级凭据，不属于员工，也不属于站点。

当前 Slack App 权限可以先拉满，不把 scope 申请作为上线阻塞项。但权限拉满不等于运行时 token 可以到处传。平台仍然必须按组件拆分 secret 注入，避免 GitHub Actions runner、job container 或 coding agent 拿到 Slack bot token。

```text
secret ref: pages-slack-platform-secret
  SLACK_SIGNING_SECRET
  SLACK_BOT_TOKEN
  SLACK_APP_ID
```

推荐拆分：

| 组件                                     | 需要的 Slack secret                                                           | 不应该拿到                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pages-gateway`                          | `SLACK_SIGNING_SECRET`、当前内置 notifier 需要 `SLACK_BOT_TOKEN`              | Git push token、Cloudflare deploy token、auto-merge token   |
| `slack-agent`                            | 可选 `SLACK_BOT_TOKEN`，用于拉 thread / channel 上下文；gateway service token | Git push token、Cloudflare deploy token、auto-merge token   |
| `slack-notifier`                         | `SLACK_BOT_TOKEN`                                                             | repo write token、Cloudflare deploy token、auto-merge token |
| GitHub Actions executor / job containers | 不需要 Slack token                                                            | Slack bot token                                             |

当前尚未拆出独立 `slack-notifier` 进程，因此 `pages-gateway` 可以临时注入 `SLACK_BOT_TOKEN` 来回写 job 进度。这个例外只适用于 K8s 控制面内部，不能把 Slack token 传给 GitHub Actions runner、coding agent、builder、site-check 或 deployer。

DB 只保存 `IntegrationBinding(scope_type=platform, provider=slack, secret_ref=...)`，不保存 token 明文。

最小 scope 收敛放到后续权限收口阶段做，届时再按实际用到的 event、message、thread、command、interaction 能力反推精确权限。

## 模型供应商 Secret

Slack Agent 的模型 API key 是平台级 secret，不属于员工，也不属于某个站点。它只能注入给 `apps/slack-agent`，不能进入 gateway、worker、GitHub Actions、Coding Agent、site-check、builder、preview deployer 或员工生成页面。

```text
secret ref: model-provider-secret
  SLACK_AGENT_API_KEY
  AGENT_CODE_API_KEY
```

推荐配置：

```text
AGENT_MODEL_PROVIDER=company-agent
AGENT_MODEL_NAME=<company gateway model/router name, optional>
AGENT_GATEWAY_URL=<company OpenAI-compatible BaseURL>
SLACK_AGENT_MAX_CONTEXT_MESSAGES=50
SLACK_AGENT_MAX_OUTPUT_TOKENS=2048
```

运行规则：

- `deterministic` 是本地 / smoke 默认兜底，不调用外部模型。
- `company-agent` 只影响 Slack Agent 的需求理解层，不影响 Coding Agent 的执行位置；`AGENT_CODE_API_KEY` 预留给 Coding Agent，不注入 Slack Agent。
- prompt 中只能写公司规则、issue 规范、权限规则和工具合同，不能写 token 值。
- 用户在 Slack 里发 API key 时，Slack Agent 不能回显、不能写入 issue / PR / 页面，必须提示改用 secret manager 或管理员配置。
- 如果公司网关内部切换模型，应在 `AgentRun` 里记录 provider、model、prompt hash 和输出 hash。

## 事件入口

长期推荐的公网入口是 HTTP event 模式：

```text
POST /integrations/slack/events
POST /integrations/slack/commands
POST /integrations/slack/interactions
```

`pages-gateway` 暴露这些入口，并做第一层安全校验：

- 校验 Slack signature。
- 校验 timestamp 防重放。
- 使用非空 `dedupe_key` 做幂等；event callback 可由 Slack `event_id` 生成，slash command / interaction 必须由稳定 request id、payload id 或平台自定义 idempotency key 生成。
- 只把已验证事件写入 DB / queue。

当前已选择 HTTP Events / Interactivity 作为唯一入口。Socket Mode 本地验证记录只作为历史排障材料，不是运行时 fallback。Slack App 需要配置：

```text
Event Request URL:
  <PAGES_GATEWAY_PUBLIC_URL>/integrations/slack/events

Interactivity Request URL:
  <PAGES_GATEWAY_PUBLIC_URL>/integrations/slack/interactions
```

gateway 使用 `SLACK_SIGNING_SECRET` 校验 `X-Slack-Signature` 和 `X-Slack-Request-Timestamp`，再用 Slack `event_id` 做幂等。K8s / production 配置必须设置 `SLACK_SIGNATURE_REQUIRED=true`，缺少 Signing Secret 时 fail closed。Events API 的 `url_verification` 会直接返回 challenge；普通事件会快速 ack，再由 gateway 后台推进 Slack Agent / worker / notifier。

## 身份判断

Slack 消息不能直接等同于公司员工身份。

入口规则：

```text
Slack user_id
  ↓
ExternalIdentityBinding
  ↓
User / Employee
```

登录态和身份绑定粒度：

- SSO 绑定跟随用户，而不是跟随 channel 或 thread。
- 绑定主键应以 `(team_id, slack_user_id)` 定位，再映射到内部 `User` / `Employee`。
- 长期保存的是 Slack 身份到公司 SSO 用户的绑定；关键操作可以要求短期 re-auth。
- 每次触发任务前，gateway 都要确认绑定用户仍是有效员工，并重新计算部门、owner scope 和 admin 权限。
- Channel 只用于限制 bot 可用范围、owner scope 或站点权限边界，不能把 channel 视为登录主体。
- Thread 只用于单次需求/任务上下文、消息聚合和进度回写，不能把 thread 视为登录主体，也不能成为共享会话主体。
- Slack Agent 必须按 `(team_id, slack_user_id)` 隔离用户；同一个用户可以有多个 `SlackSession`，session key 只能来自 thread、显式 session id 或 DM selector；job / issue / PR / preview 通过 `IssueLink` 作为 lookup alias，不反向改写 session key。
- 同一个 thread 中多个用户发消息时，每个用户只进入自己名下的 `SlackSession`。
- 用户只能显式续接自己名下的 `SlackSession` / `PublishingJob`。如果用户把别人的 `session: sess_xxx` 或 `job_xxx` 贴到 Slack，gateway 必须拒绝续接和状态查询，不能把对方的 issue、PR、preview、session memory 暴露出来。
- 未绑定 SSO 的 Slack actor 只能收到登录/绑定链接，不能创建 `PublishingJob`。

DM 也按 thread 管会话：用户在私聊里发起一条新需求后，gateway 的回复必须带 `thread_ts`，后续用户在这个 Slack thread 里继续补充。gateway 对 DM thread 使用 `dm-thread:<dmChannelId>:<threadTs>` 作为 session key，这样“创建任务 / 追问 / 修改 preview / 查看状态”不会散落在整个 DM 主时间线里，也不会因为同一个用户有多个 active session 就反复要求选择。

## 多人共享运行隔离

多人使用同一台服务器时，运行时边界是“一个平台控制面 + 多个 Slack 用户会话”，不是每个用户各自启动一套 listener。

隔离规则：

- 同一个 Slack App 的 Events / Interactivity Request URL 应只指向一个当前有效的 gateway public URL。本地多人测试不要争用同一个 Slack App 配置。
- `pages-gateway` 可以横向扩容，但必须共享 DB / queue / lease / delivery dedupe，避免重复处理 Slack event 或重复回写。
- `pages-gateway` 负责用户隔离，所有 Slack session、memory、issue link、job status 查询都必须以 `(team_id, slack_user_id)` 为访问边界。
- `slack-agent` 不持有 GitHub / Cloudflare token，只处理当前用户当前 session 的上下文；prompt 和审计日志里的用户文本可以记录，但 secret-like 内容必须先脱敏。
- GitHub Actions / Coding Agent 不接收 Slack token，也不能直接读 gateway 的全量 session store；它们只处理 gateway 派发的单个 job context。

本地多人共用开发机时，如果多个开发者都要跑自己的控制面，必须使用不同的 k3d/kind cluster 名、namespace、端口、PVC storage 目录、公网 tunnel 和 Slack App Request URL。不要共用同一个 Slack App 同时指向多套 gateway。

如果消息来自另一个 SlackBot：

- 它可以作为需求来源。
- 它的原始消息、channel、thread、bot user id 要写入 `SlackMessageBatch`。
- 它不能直接成为 `requested_by`。
- 如果没有真人 actor 或 trusted bot policy，gateway 只能记录和总结消息，不能创建 `PublishingJob`。
- 如果要允许某个 bot 代表人或系统发起任务，需要额外配置 `TrustedSlackBotPolicy`，并映射到 service account 或要求 thread 内真人确认。

建议模型：

```text
TrustedSlackBotPolicy
  team_id
  bot_user_id
  app_id
  mode: evidence_only | require_human_confirm | service_account
  service_account_id
  allowed_channel_ids_json
  allowed_owner_scope_ids_json
  status
```

## Slack 到发布任务的流程

```text
Slack message / slash command
  ↓
pages-gateway 校验 signature + 幂等
  ↓
写 SlackEvent(processing_status=received) + SlackMessageBatch(status=pending)
  ↓
enqueue slack-agent.analyze
  ↓
apps/slack-agent 拉上下文、加载 session/memory 并总结
  ↓
gateway 解析真人 actor，或校验 TrustedSlackBotPolicy
  ↓
gateway 校验 actor / service account 是否有 SiteAdminGrant / owner scope / admin 权限
  ↓
创建 PublishingJob
  ↓
pages-worker 推进发布状态机
  ↓
slack-notifier 回写进度
```

Slack Agent 不直接创建 PR、不直接合并、不直接部署。它只能请求 gateway 创建或推进平台任务，并把会话结果写入 `SlackSession` / `SessionMemory` / `IssueLink`。

## 幂等和重试

需要记录：

```text
SlackEvent
  dedupe_key
  event_id
  team_id
  channel_id
  thread_ts
  event_ts
  trigger_id
  slack_retry_num
  slack_retry_reason
  processing_status
  result_type
  ignored_reason
  publishing_job_id
```

规则：

- 同一个 `(team_id, dedupe_key)` 只能处理一次。
- `dedupe_key` 必须非空，不能依赖 nullable unique。
- 同一个 slash command / interaction 只能创建一个 `PublishingJob`。
- worker retry 只能产生新的 `JobStageAttempt`。
- Slack 重投事件时，gateway 返回已接收状态，不重复创建 issue / PR。

## 进度回写

回写 Slack 不应散落在各个 executor 任务里。

推荐统一为：

```text
PublishingJob 状态变化
  ↓
JobEvent / Redis Stream
  ↓
slack-notifier
  ↓
Slack thread message update / reply
```

这样 coding-agent、builder、site-check、deployer workflow/job 都不需要 Slack bot token。

所有 Slack 回写都必须 @ 对应用户：

```text
<@slack_user_id> Preview 已生成：...
```

规则：

- gateway 对非任务类回复、进度回写和关键节点消息都要 @ `PublishingJob.slackThread.userId` 或原始 Slack event user。
- 在频道或 thread 中必须 @，避免多人同 thread 时串用户。
- DM 中也可以保留 @ 前缀，保证消息格式一致。
- 如果没有可信 user id，不拼接 mention，也不能从消息文本中猜用户。

当前实现是在 `pages-gateway` 内置一个 notifier adapter：

```text
Slack Agent 分析 / executor callback / GitHub Review Agent webhook
  ↓
pages-gateway 更新 PublishingJob
  ↓
pages-gateway 使用 job.slackThread 调 chat.postMessage / chat.update
```

Slack 右侧体验采用“状态卡片 + 关键节点稳定消息”：

- 创建 Slack 发布任务时，gateway 先在对应 DM / thread 发一条 Block Kit 状态卡片。
- Slack Agent 对用户可见的整理结果会进入 job summary，并展示在状态卡片中。
- executor callback / Review webhook 到达后，gateway 用 `chat.update` 更新同一张状态卡片。
- issue / PR / preview / failure 等关键节点继续单独发一条稳定 thread 消息，方便用户回看链接。
- gateway 记录 `AgentRunEvent` 和 `SlackJobStatusMessage`，用于去重、重试和后续拆独立 notifier。

“回现 Slack Agent 消息”只指对用户可见的输出，例如追问、需求摘要、任务创建判断、状态解释和错误提示；不得回显模型内部推理、system / developer prompt、token、secret 或公司网关原始调试信息。

已覆盖的回写节点：

- issue 创建完成。
- project index 固定完成。
- PR 创建完成。
- Review Agent 开始、blocking、suggestion、unknown、gate pass。
- Preview URL 生成完成。
- executor 失败。

这个 adapter 需要 `SLACK_BOT_TOKEN`。后续拆分成独立 `slack-notifier` 后，gateway 改为写 `JobEvent`，notifier 负责重试、持久化幂等和 Slack API 调用。

## 运行模式

### 本地开发

本地开发不再使用 `/tmp/slack-mention-test/listen.mjs`，也不使用 Socket Mode listener。目标是用本地 K8s 启动常驻服务，裸 Node 启动只作为临时调试，不能作为完整验收。启动顺序：

```text
Slack Events / Interactivity
  ↓
public HTTPS tunnel / Ingress
  ↓
pages-gateway Service
  ↓
gateway 创建 PublishingJob
```

gateway Slack HTTP 入口使用这些环境变量：

```text
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_EVENTS_PROCESSING_MODE
SLACK_SIGNATURE_REQUIRED
SLACK_REACTION_ON_RECEIVE
SLACK_WORKING_REACTION
SLACK_SIGNATURE_MAX_SKEW_SECONDS
SLACK_API_URL
```

真实 token 只能放本机私有环境或 secret manager，不能写入 repo。Slack App 的 Events URL 和 Interactivity URL 都应指向当前 `PAGES_GATEWAY_PUBLIC_URL`。

本地 smoke 测试建议同时启用 worker 的单 issue 和单 PR 模式：

```text
PAGES_EXECUTOR_MODE=github_issue_webhook
PAGES_ISSUE_MODE=smoke_single
PAGES_SMOKE_ISSUE_SCOPE=local-slack-smoke
PAGES_PR_MODE=smoke_single
PAGES_SMOKE_PR_BRANCH=sites/smoke-local-slack-smoke-profile
```

这样 Slack 每次测试不会创建新的 GitHub issue，也不会每次生成新的 smoke PR。issue 会复用同一个 smoke issue 并追加 comment；PR 会复用固定 branch 和固定 PR，workflow 只更新这个 PR 的 head commit、title 和 body。

正式产品链路仍然是一个真实需求 / `PublishingJob` 对应一个 issue 和一个 PR branch。`PAGES_ISSUE_MODE=smoke_single` 与 `PAGES_PR_MODE=smoke_single` 只用于本地或 staging smoke，不能作为 production 默认行为。

Review Agent 结果监听必须走 GitHub webhook：

```text
GitHub Review Agent comment
  ↓
GitHub webhook
  ↓
pages-gateway /integrations/github/webhook
  ↓
ReviewAgentComment / PublishingJob state
  ↓
preview gate / Slack notification
```

本地可以用 `gh pr view`、`gh api`、`gh run view` 辅助观察，但不能把 `gh` CLI 轮询写进 gateway、worker 或 workflow runtime。

Slack 入口不限制私聊。Slack App 应订阅这些事件：

```text
message.im
app_mention
message.channels / message.groups 中已有任务 thread 的后续普通回复
```

私聊会直接回复 DM；在频道或 thread 中 `@bot` 触发的 `app_mention` 会回复到对应 thread。前提是 Slack App 已订阅 `app_mention`，并且 bot 已加入对应频道。

为了支持像 Slack 工作台一样连续对话，gateway 会接受频道 thread 里的后续普通 `message`。gateway 只续接同一 Slack user 已经存在的 `SlackSession`；如果一个普通 thread 消息没有匹配到该用户已有 session，会返回 `ignored_untracked_thread_message` 且不回复，避免把频道里的无关聊天误当需求。

## 消息识别

平台不直接把每条 Slack 消息都变成 issue，而是先进入 Slack Agent 对话理解层。用户可以完全用自然语言闲聊、补充设计想法或表达对 preview 的不满；gateway 只把少数控制类消息先做确定性识别，其余消息都作为 `agent_turn` 交给 `apps/slack-agent`。Slack Agent 的输出再由 gateway 判断是追问、创建 `PublishingJob`、续接已有 issue / PR / preview，还是查询状态 / 关闭会话。

`issue:` / `page:` 仍然保留为兼容入口，但不是必需用法。这里的 `issue:` / `page:` 是普通 Slack 消息，不是 Slack Slash Command；如果后续要支持 `/issue`，应把 Slack Slash Command Request URL 配到 gateway 并复用同一套签名校验、幂等和 Slack Agent 流程。

| 文案                                  | 行为                                             |
| ------------------------------------- | ------------------------------------------------ |
| 任意自然语言需求                      | 进入 Slack Agent；信息足够时创建发布任务 / issue |
| 模糊闲聊 / 信息不足                   | 进入 Slack Agent；回复澄清问题，不创建 issue     |
| `issue: <需求>`                       | 兼容命令入口；仍会经过 Slack Agent 结构化        |
| `page: <需求>`                        | 兼容命令入口；仍会经过 Slack Agent 结构化        |
| `site: <需求>`                        | 兼容命令入口；仍会经过 Slack Agent 结构化        |
| `status: job_xxx`                     | 查询 job 状态                                    |
| `help`                                | 返回帮助                                         |
| `ping`                                | 连通性回复                                       |
| `cancel`                              | 返回取消提示，当前暂不真正取消                   |
| `关闭会话` / `结束对话`               | 关闭当前选中的 session，清空 active context      |
| `这个任务不用了` / `归档这个 preview` | 关闭当前 active IssueLink 或转人工确认           |

普通聊天、模糊消息、测试闲聊不会直接创建 issue；只有 Slack Agent 明确返回 `create_or_update_site` / `new_site_request` / `create_site` / `update_site` 且 `needsClarification=false` 时，gateway 才创建发布任务。没有配置 Slack Agent 时，自由聊天只记录会话并回复兜底提示，不自动开 issue。

Agent 消息分析应放在 `apps/slack-agent` 中，把当前用户可见的 Slack thread / DM 上下文总结成结构化需求，并维护按用户隔离、可多开的 `SlackSession` / `SessionMemory` / `IssueLink`。Agent 的输出仍需经过 gateway 的权限、幂等和创建 job 规则，不能直接创建 issue / PR。

默认 session 生命周期：

```text
SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS=2
SLACK_AGENT_WAITING_CLARIFICATION_TTL_DAYS=1
SLACK_AGENT_RECENT_SESSION_DAYS=14
SLACK_AGENT_ARCHIVE_AFTER_DAYS=90
SLACK_AGENT_TURN_TIMEOUT_SECONDS=120
SLACK_AGENT_SESSION_LEASE_SECONDS=180
SLACK_AGENT_PROVIDER_THREAD_TTL_HOURS=24
CODING_AGENT_RUN_TIMEOUT_MINUTES=30
```

TTL 只控制默认续接，不删除 issue、PR、preview、DeployRecord 或 AgentRun。用户带着明确 job id / issue / PR / preview URL 回来时，可以在权限校验后恢复上下文。

Agent 生命周期规则：

- Slack Agent runtime 常驻，但每轮模型调用都是短 `AgentRun`，必须拿到 session lease 后才能修改 memory。
- 同一 session 同时只能有一个 running Slack Agent run；后到的 Slack 消息排队或返回“正在处理上一条”。
- 模型供应商 thread 只作为 24 小时缓存，不作为真相源。
- Coding Agent 是 GitHub Actions / 后续 K8s Job 的一次性 run，默认 30 分钟超时；失败后由 gateway/worker 创建新的 retry attempt。

### 生产

生产推荐：

```text
pages-gateway replicas=N
slack-agent replicas=N
slack-notifier replicas=1..N
queue / redis 做 lease 和幂等
```

如果 `slack-notifier` 多副本，必须用 job lease 或 event consumer group，避免重复发消息。
