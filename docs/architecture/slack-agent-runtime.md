# Slack Agent Runtime

本文件是 [slack-platform-runtime.md](./slack-platform-runtime.md) 的运行细节拆分页。Slack 外部入口、身份权限、session 和数据模型仍以主文档为准。

## Slack Agent Runtime

`apps/slack-agent` 是常驻服务，但 Agent 的每轮模型调用是短 `AgentRun`：

```text
Slack message
  ↓
获取 session lease
  ↓
加载 SlackSession / SessionMemory / WorkItemLink
  ↓
调用公司 Agent Gateway
  ↓
输出语义分块 visible reply events + analysis_final
  ↓
gateway 写回结构化 intent / summary / tool request
  ↓
释放 lease
```

Slack Agent 负责：

- 与用户在同一 Slack DM 或 thread 中持续多轮对话。
- 支持自然语言输入。
- 整理 Slack thread 成结构化需求。
- 判断是否需要澄清。
- 判断是否建议创建新任务。
- 判断是否续接已有 issue / PR / preview。
- 判断请求属于 Site Publishing Lane 还是 Platform Dev Lane。
- 为 Platform Dev Lane 输出 issue type、area、risk 和自动化建议。
- 识别权限、owner scope、站点管理关系。
- 输出结构化 intent。
- 作为 XD Cell 的任务管家和问题诊断入口，回答任务状态、关联 issue / PR / preview、失败阶段和下一步建议。

Slack Agent 不负责：

- `git push`
- create branch
- create PR
- write repository files
- deploy preview / production
- read Cloudflare token
- read GitHub push token
- read production secret
- merge PR
- deploy production
- delete resources
- shell 到 ECS 或执行任意原始日志查询

产品定位上，Slack Agent 对用户是任务诊断入口，对系统是受控 orchestration 入口。用户不需要知道背后是 gateway、worker、GitHub Actions、ECS、MySQL 还是 callback；Slack 可见文案只使用“任务、阶段、Issue、PR、Preview、Workflow、失败原因、建议操作”这类产品语义。内部字段、服务名、数据库表、job id、session id、gateway 派生规则和 status card 实现细节只能进入日志、审计或受控诊断数据，不能作为普通用户回复。

可用工具应是受控平台动作，例如：

```text
loadSession
saveSessionMemory
list_my_work_items(state=active|all|closed)
switch_work_item(kind=issue|pr|unknown, number)
reopen_work_item(kind=issue|pr|unknown, number)
get_current_status
record_followup
confirm_create_issue
confirm_platform_issue
close_session
cancel_request
unsupported_destructive_request
getLinkedIssuePrPreview
askClarification
notifySlack
diagnose_current_work_item
get_work_item_timeline
summarize_work_item_logs
get_workflow_status
request_retry_work_item
request_append_diagnosis_comment
request_human_triage
answer_repo_question
```

这些工具也不能绕过 gateway 权限、幂等和状态机。Slack Agent 可以主导“下一步做什么”，诊断、切换和 Review 查询 toolCall 必须带上用户明确提到的 issue / PR 编号；gateway 执行时必须重新计算当前 Slack 用户、当前 session、该用户名下的 job / issue / PR 范围，Agent 传入其它用户、其它 session 或其它人的 GitHub 编号时不能生效。

产品上，gateway 不应该把“我的任务”“继续某个 issue / PR”“重新打开某个 issue / PR”“关闭 / 删除 issue 或 PR”等自然语言分支写死成主要体验。gateway 只保留 Slack 协议命令、显式 `issue:` / `status:` / `/close` 兼容入口、GitHub URL / issue / PR 编号等结构化引用提取、签名校验、幂等和执行权限收口；正常对话必须先进 Slack Agent，由 Agent 输出 `toolCall`，再由 gateway 做权限收口和执行。

## 任务诊断体验

任务诊断是 Slack Agent 的独立产品能力，详细边界见 [slack-agent-diagnostics.md](./slack-agent-diagnostics.md)。
本文件只保留 runtime 入口、状态机和消息投递约束。

## Repo 只读问答

Repo 问答是 Slack Agent 的独立查询能力，详细边界见 [slack-agent-repo-question.md](./slack-agent-repo-question.md)。
runtime 上分成 `/internal/slack-agent/repo-plan` 和 `/internal/slack-agent/repo-answer`：前者由 Agent 规划只读 `repo_tree / repo_search / repo_read` 范围，后者基于 gateway 裁剪后的 evidence 生成 Slack 回复。gateway 只负责安全执行、权限收口、长度限制和确认入口，不用关键词规则替 Agent 做产品语义判断。

## Turn 协议

目标生产接口：

```text
POST /internal/slack-agent/turn
```

不要把 `/internal/slack-agent/analyze` 作为未来生产合同继续维护。

生产目标建议用内部 HTTP streaming，响应体采用 NDJSON，每行一个事件。Slack Events 的 3 秒 ACK 已经在 gateway 入口完成，gateway 可以在后台任务里保持这条内部连接。

这里的 streaming 是内部传输合同，不等于 Slack 对外 token-by-token。模型 provider 如果支持 token 流，`slack-agent` 应先聚合成短句、语义片段或节流窗口，再输出 `reply_delta`。

当前公司 OpenAI-compatible 路径使用 `stream: true` 请求模型，并要求模型 JSON 第一字段包含 `visibleReply`。为避免 secret-like 文本被拆成多个 provider delta 后提前泄漏，`slack-agent` 不向下游透传未完成 JSON；它先聚合完整 provider 内容，解析、规范化并脱敏 `visibleReply`、`summary`、`title`、`sourceMessages`、`clarifyingQuestion` 后，再按标点和长度输出 `reply_delta`。脱敏必须覆盖 `TOKEN=value`、`{"*_API_KEY":"value"}` 和 `{'*_API_KEY':'value'}` 这类 JSON / JSON-like 字段，包括值中出现另一种引号或 JSON 转义字符的情况。`intent`、`summary`、`siteSlug` 等结构化字段只在完整 JSON 可解析后作为 `analysis_final` 输出。

请求示例：

```json
{
  "agentRunId": "run_xxx",
  "slackSessionId": "sess_xxx",
  "teamId": "T123",
  "slackUserId": "U123",
  "channelId": "C123",
  "threadTs": "1710000000.000000",
  "messageTs": "1710000001.000000",
  "messageText": "帮我做一个个人主页，突出项目经历",
  "sessionMemory": {
    "requirementsSummary": "用户想创建个人主页",
    "pendingQuestions": []
  },
  "activeWorkItemLink": null
}
```

响应示例：

```text
{"type":"reply_started","sequence":1,"agentRunId":"run_xxx","slackSessionId":"sess_xxx"}
{"type":"reply_delta","sequence":2,"agentRunId":"run_xxx","slackSessionId":"sess_xxx","text":"我先整理一下："}
{"type":"reply_delta","sequence":3,"agentRunId":"run_xxx","slackSessionId":"sess_xxx","text":"你想做一个突出项目经历的个人主页。"}
{"type":"analysis_final","sequence":4,"agentRunId":"run_xxx","slackSessionId":"sess_xxx","analysis":{"intent":"create_or_update_site","needsClarification":false}}
{"type":"reply_completed","sequence":5,"agentRunId":"run_xxx","slackSessionId":"sess_xxx"}
```

事件字段：

| 字段             | 必填         | 说明                                                                                |
| ---------------- | ------------ | ----------------------------------------------------------------------------------- |
| `type`           | 是           | `reply_started`、`reply_delta`、`analysis_final`、`reply_completed`、`reply_failed` |
| `sequence`       | 是           | 单调递增，用于去重和乱序保护                                                        |
| `agentRunId`     | 是           | gateway 创建的 `AgentRun`                                                           |
| `slackSessionId` | 是           | 当前会话                                                                            |
| `text`           | delta 时必填 | 本次可见语义片段 / 短句增量，不包含内部推理；不应是裸 token                         |
| `analysis`       | final 时必填 | 结构化 intent / summary / needsClarification                                        |
| `visibleToUser`  | 建议         | 默认 true；false 只能进日志                                                         |
| `dedupeKey`      | 建议         | 事件级幂等键                                                                        |
| `createdAt`      | 建议         | Agent 侧产生时间，不能作为唯一顺序来源                                              |

gateway 消费规则：

- 每收到一行合法事件，先写 `AgentRunEvent`，再触发 notifier 更新。
- `reply_delta` 只影响 Slack 可见文本和 `text_snapshot`，不能直接改变 job 状态；gateway / notifier 应继续节流，不能每个 provider token 都调用 Slack API。
- `analysis_final` 才能更新 `SessionMemory` 的结构化结论，并决定澄清、确认卡片或续接任务。
- `reply_completed` 只能表示本轮可见回复结束；如果没有 `analysis_final`，gateway 仍按失败或需重试处理。
- 内部连接断开时，gateway 标记本轮 `AgentRun` failed，并把同一条 Agent 回复更新为可操作错误提示。

如果 gateway 不保持 HTTP stream，也可以让 `slack-agent` 把事件写入 Redis Stream，再由 gateway / notifier 消费。业务合同不变：事件顺序靠 `sequence`，真相源靠 DB，Slack 消息只是投递结果。

## 对话语义分块准流式回复

对话阶段需要不同于 work item 执行进度消息的 Slack message binding，因为此时可能还没有 `PublishingJob` 或 `PlatformDevItem`。

生产目标使用 `chat.postMessage + chat.update` 做语义分块准流式：

```text
gateway 创建 AgentRun
  ↓
slack-notifier 创建或复用一条“正在整理需求...” Agent 回复
  ↓
slack-agent 持续产出短句 / 语义片段 reply_delta
  ↓
gateway / notifier 每 500ms 到 1000ms，或按语义片段聚合一次
  ↓
chat.update 同一条 Agent 回复
  ↓
analysis_final 到达
  ↓
最终 update + 后续澄清 / 确认卡片
```

执行阶段如果已经有 active work item / issue / PR，`chat.update` 的目标默认是该 work item 的进度消息，而不是 Agent 回复。只有澄清、解释、查询结果、错误提示这类沟通型内容才单独发 thread 回复。

Slack 原生 streaming API 可以作为可选输出通道：

```text
chat.startStream
chat.appendStream
chat.stopStream
```

原生 stream 只改变 Slack 输出方式，不改变平台状态机，也不改变“不追求 token-by-token”的产品目标。即使使用原生 stream，对外 append 的也应该是短句、语义片段或节流窗口，而不是每个 token。

- `AgentRun` 仍然是会话单轮运行。
- `SessionMemory` 仍然是真相源。
- `SlackAgentReplyMessage` 仍记录 `channel + ts + offset`。
- 执行阶段仍然使用 work item 进度消息。

评估原生 stream 的前提：

- 语义分块准流式体验已经被用户验证仍需要更强实时感。
- notifier 已有持久重试、rate limit 和 dead-letter。
- Agent turn 协议有稳定 `sequence` / `offset`。
- 多副本下不会重复 start stream 或重复 append。
- 有运行开关可按 workspace / channel / user 逐步启用；这个开关控制运行风险，不是为了兼容旧 `analyze`。

用户可见内容只允许：

- 需求摘要。
- 澄清问题。
- 已接收的修改意见。
- 创建任务前的确认文案。
- 状态解释和失败提示。

禁止输出：

- 模型内部推理。
- system / developer prompt。
- provider 原始 response。
- token、secret、cookie、API key。
- GitHub / Cloudflare / Slack credential。

## 执行阶段进度消息

一旦进入正式 work item，不继续用 token 流表达后台执行细节，也不把 shell log、模型碎片输出或 Review trace 高频刷进 Slack。

进度消息按阶段变化更新，回答：

- 当前到哪了。
- 是否失败。
- issue / PR / preview 链接在哪里。
- 用户下一步需要做什么。

关键节点消息沉淀：

- issue 链接。
- PR 链接。
- Preview 链接。
- 阻塞原因。

用户可见进度消息建议包含：

```text
Header: 任务进度
Section: 当前阶段 + 需求摘要
Fields:
  当前阶段
  目标站点或影响范围
  当前状态
  Issue
  PR
  Preview 或合并结果
Context:
  继续修改可以直接在这个 thread 里回复
Actions:
  查看 Issue
  查看 PR
  打开 Preview
  关闭会话
```

内部 message binding 可以保存 `job_id`、`work_item_id`、`session_id`、`message_ts`、`last_render_hash` 等字段，但这些不应该作为普通用户文案展示。

阶段事件示例：

```text
Platform Dev:
received
triaging
issue_created
waiting_human_gate
agent_queued
agent_running
pr_created
ci_failed
review_blocked
ready_for_review
ready_to_merge
merged
closed_unmerged

Site Publishing:
received
issue_creating
issue_created
indexing
index_ready
generating_page
patch_generated
branch_committed
pr_created
reviewing
changes_requested
fixing
previewing
preview_deployed
failed
```

适合进入进度消息的内容：

- 当前阶段的用户可理解动词。
- 本轮修改摘要。
- review gate 的阻塞数量。
- site-check 是否通过。
- preview 是否已生成。

不适合进入进度消息：

- shell 命令输出。
- package install 完整日志。
- git diff 大段内容。
- stack trace 原文。
- provider debug trace。

## Interactivity 动作

按钮 `action_id` 建议使用 `pages_` 前缀，`value` 使用 JSON 或短 id；敏感信息不能放在 `value` 里。

| Action                      | 产品行为                          | 后台事件                   |
| --------------------------- | --------------------------------- | -------------------------- |
| `pages_confirm_requirement` | 确认摘要并创建 job                | `job.confirm_requested`    |
| `pages_confirm_platform_issue` | 确认摘要并创建 Platform Dev issue | `platform_issue.confirm_requested` |
| `pages_trigger_platform_auto_dev` | 发起人手动触发 Platform Dev 自动开发 | `platform_item.auto_dev_requested` |
| `pages_close_session`       | 关闭当前用户拥有的 session        | `session.close_requested`  |
| `pages_cancel_job`          | 请求取消或转人工确认              | `job.cancel_requested`     |
| `pages_cancel_platform_item` | 请求取消平台研发 item             | `platform_item.cancel_requested` |
| `pages_regenerate`          | 对同一 PR branch 启动新 fix round | `job.regenerate_requested` |
| `pages_open_admin`          | 打开内部控制台链接                | 只生成 URL，不推进状态     |

交互规则：

- 必须校验 action caller 是否拥有对应 `SlackSession`。
- 已关闭或归档的 session 返回 ephemeral 提示，不重新激活。
- 正在运行的 session 使用 lease，不能并发触发两个 fix round。
- Slack retry 不能重复触发命令。
- URL button 只打开 issue / PR / preview；改变状态的动作必须走 callback。
- action `value` 只能放短 id 或无敏 JSON，例如 `{"workItemKind":"platform_dev","workItemId":"pdev_xxx","sessionId":"sess_xxx"}`。Site Publishing 兼容按钮可以继续放 `jobId`，但 gateway 内部应归一化成 `workItemKind=site_publishing`。
- “自动开发”按钮只携带 work item id / session id；gateway 必须重新从 MySQL 读取 item 和 Slack session，校验 caller 是发起人 / session owner，不能信任 Slack button value 里的 risk / area。

## slack-notifier

正式版 `slack-notifier` 是独立 Deployment。它从 gateway 拆出的原因：

- Slack Web API 是慢 I/O，会遇到 rate limit、`message_not_found`、`channel_not_found`、`invalid_auth` 等问题，不应阻塞 webhook ACK。
- gateway 需要保持无状态、可横向扩容，并专注签名校验、幂等、权限和状态机。
- Secret 边界更清楚：正式 K8s 中 `SLACK_BOT_TOKEN` 只进入 `slack-notifier`。
- Slack API 故障只影响通知投递和补偿，不影响 gateway 继续接收事件。
- notifier 可以独立扩缩容、限流和排队。

职责：

- 创建或更新 Agent 对话消息。
- 创建或更新 work item 进度消息。
- 发送 reactions。
- 消费 `AgentRunEvent` / `JobEvent`。
- 查询 `SlackAgentReplyMessage` / `SlackMessageBinding`。
- 构建 Block Kit。
- 处理 rate limit、retry、dead-letter。
- 写 `SlackNotificationAttempt` 和 `ExternalApiCallLog`。
- 提供内部 HTTP fallback endpoint，供 gateway 在写入事件后同步请求一次投递。

不负责：

- 判断用户意图。
- 创建 issue / PR。
- 部署 preview。
- 读取 GitHub token 或 Cloudflare token。
- 修改 `PublishingJob` 业务状态。

当前已实现的对话消息内部 endpoint：

```text
POST /internal/slack-notifier/agent-reply/start
POST /internal/slack-notifier/agent-reply/update
```

`complete` / `fail` 不单独暴露 endpoint；当前通过 `agent-reply/update` 的 `status=completed|failed` 更新同一条 Slack 消息。

多副本要求：

```text
slack-notifier replicas=N
  ↓
Redis consumer group / queue lease
  ↓
同一 event 只有一个 consumer 发送 Slack
```

`SlackNotificationAttempt` 状态：

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

- `rate_limited` 按 Slack retry hint 或平台默认 backoff 延迟重试。
- `invalid_auth`、`channel_not_found`、`not_in_channel` 进入 `dead_letter` 并暴露给 Admin Console。
- `message_not_found` 且原消息是进度消息时，可以补发新消息并更新 binding。
- notifier 重试不能修改 `PublishingJob` 状态，只能修改通知尝试状态和 message binding。

## 幂等、并发和恢复

至少需要这些幂等键：

| 场景                        | dedupe key                                                              |
| --------------------------- | ----------------------------------------------------------------------- |
| Slack event 接收            | `team_id:event_id`                                                      |
| Slash command / interaction | `team_id:payload_type:action_id:action_ts:user_id` 或 full payload hash |
| AgentRun 创建               | `slack_event:<team_id>:<event_id>`                                      |
| Agent delta                 | `agent_run_id:sequence`                                                 |
| Agent reply message posted  | `slack-reply-posted:<agent_run_id>`                                     |
| Agent reply message updated | `slack-reply-updated:<agent_run_id>:<sequence>`                         |
| Agent reply message failed  | `slack-reply-failed:<agent_run_id>:<sequence>`                          |
| Confirm button              | `team_id:action_id:action_ts:user_id` 或完整 payload hash               |
| PublishingJob 创建          | `slack-confirm:<session_id>:<redacted_analysis_hash>`                   |

规则：

- `dedupe_key` 必须非空，不能依赖 nullable unique。
- 同一个 `(team_id, dedupe_key)` 只能处理一次。
- 同一 `slack_session_id` 同时只能有一个 running `AgentRun`。
- 后到消息必须进入持久 follow-up queue，用户可见回复应说明“上一轮还在处理中，已记录这条补充，会按顺序处理”。
- 两轮 Agent 不能同时修改同一个 `SessionMemory`。
- Slack update 限流，不要每个 token 都调用一次 Slack API；对话阶段按语义片段 / 500ms-1000ms 窗口更新，执行阶段按阶段变化更新。
- notifier 重启后必须从 DB 找回 `message_ts` 和 `last_sent_offset`。

旧事件保护：

- 如果事件携带 attempt id，必须确认它仍是当前 job active attempt。
- 如果事件没有 attempt id，必须校验 `agent_run_id`、session lease 和 dedupe。
- `stage_order` 不得早于 binding 的 `last_stage_order`。
- 旧事件晚到可以写审计，但不能回滚 work item，也不能覆盖 Slack 进度消息。

文本长度：

- 发 Slack 的可见文本按平台常量截断，例如 3000 字符内。
- 确认卡片只展示摘要，不展示全部对话。
- 完整需求进入 `SessionMemory.requirements_json`。
- 截断时给出可理解提示，例如“内容较长，已省略部分细节。确认后我会把完整需求整理进 issue。”

## Preview 不满意和 Fix Round

用户在同一个 thread 里说：

```text
这个 preview 不满意，把标题改成中文，再加一个项目经历区域
```

处理流程：

```text
Slack Agent 加载 SlackSession
  ↓
找到 active PublishingJob / issue / PR / preview
  ↓
分类为 modify_existing_preview
  ↓
写 SessionMemory.last_preview_feedback
  ↓
追加 GitHub issue comment
  ↓
gateway 将 job 推进到 changes_requested / fixing
  ↓
dispatch pages-agent.yml(mode=fix)
  ↓
Coding Agent 修改同一个 PR branch
  ↓
再次触发 GitHub Review Agent
  ↓
Review gate 通过后重新部署 Preview
  ↓
Slack 回写新 Preview URL
```

默认修复同一个 PR branch，除非用户明确要求“重新开一个版本”或当前 PR 已结束。

Issue 续接规则：

- 当前选中 session 有唯一 active issue：默认追加 comment。
- 当前用户有多个 recent issue / preview：必须要求选择。
- 消息包含 `job_xxx`：查 job 并确认 actor 有权限。
- 消息包含 `#123` 或 PR 链接：查 issue / PR 并确认属于可管理站点。
- 用户说“新建”“重新做一个”：创建新 issue。
- 用户说“刚才那个”：只在当前用户最近 session / 任务唯一且权限匹配时续接，否则反问。

所有续接和修改都必须落 GitHub issue comment，保证 Slack 对话不会成为唯一真相源。

## 本地和测试运行

本地开发不再使用 Socket Mode listener。目标是用本地 K8s 启动常驻服务，裸 Node 启动只作为临时调试。

gateway Slack HTTP 入口环境变量：

```text
SLACK_SIGNING_SECRET
SLACK_EVENTS_PROCESSING_MODE
SLACK_SIGNATURE_REQUIRED
SLACK_REACTION_ON_RECEIVE
SLACK_WORKING_REACTION
SLACK_SIGNATURE_MAX_SKEW_SECONDS
SLACK_NOTIFIER_URL
SLACK_NOTIFIER_SHARED_SECRET
```

`slack-notifier` 环境变量：

```text
SLACK_BOT_TOKEN
SLACK_API_URL
SLACK_NOTIFIER_SHARED_SECRET
```

真实 token 只能放本机私有环境或 secret manager，不能写入 repo。

本地 smoke 可使用：

```text
employeeSlug = smoke
siteSlug = profile
baseRef = staging
environment = preview
```

也可以启用单 issue / 单 PR 模式：

```text
PAGES_EXECUTOR_MODE=github_issue_webhook
PAGES_ISSUE_MODE=smoke_single
PAGES_SMOKE_ISSUE_SCOPE=local-slack-smoke
PAGES_PR_MODE=smoke_single
PAGES_SMOKE_PR_BRANCH=sites/smoke-local-slack-smoke-profile
```

这些只用于本地或 staging smoke，不能作为 production 默认行为。

GitHub Review Agent 结果监听必须走 GitHub webhook：

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

## Preview 截图

Preview 截图是 Site Publishing Lane 的富展示能力，不阻塞 preview 主状态：

```text
preview_deployed
  ↓
browser / screenshot worker
  ↓
PNG artifact / object storage
  ↓
JobEvent(preview_screenshot_ready)
  ↓
slack-notifier 更新进度消息或追加图片消息
```

规则：

- 截图失败不能让 `preview_deployed` 回滚。
- 截图 worker 不持有 Slack token。
- 图片 URL 如果用于 Slack `image` block，必须是 Slack 可访问地址。
- 如果图片含内部页面内容，需要先确认访问策略。

## 企业级目标实施顺序

因为项目仍在测试阶段，推荐直接按企业级目标合同推进，不长期维护旧 `analyze` 生产链路。实施顺序只表示工程落地依赖，不代表产品目标降级：

1. 文档收敛：本文作为 Slack 唯一主文档，旧 Slack 分散文档已删除。
2. DB schema：新增 / 演进 `SlackAgentReplyMessage`、`AgentRunEvent`、`SlackNotificationAttempt`、`ExternalApiCallLog`。
3. notifier API：增加 Agent reply start/update/complete/fail endpoint。
4. slack-agent turn：用 `/internal/slack-agent/turn` 替换生产 `analyze`。
5. gateway streaming adapter：移除 `postSlackResultReply` 的生产依赖，改为 Agent reply binding + turn event。
6. 语义分块准流式 Slack 输出：用 `chat.postMessage + chat.update` 做可用体验。
7. Redis Stream / Queue：notifier 从同步 HTTP fallback 逐步切到 consumer。
8. 执行阶段进度消息：worker / executor 增加阶段化 progress event。
9. Interactivity 扩展：cancel、regenerate、confirm、admin link、选择站点。
10. Platform Dev Lane：issue 分类、label、模板、repo 全目录开发策略、PR merge / close Slack 回写。
11. 原生 Slack stream API：作为可选输出通道，在 notifier 内封装 `chat.startStream` / `chat.appendStream` / `chat.stopStream`，仍按语义片段输出，并按运行开关启用。
12. Preview screenshot：增加截图 worker 和图片回写。

## 验收标准

- 用户在 DM 或 `@bot` thread 发自然语言需求后，3 秒内看到 ACK 感知：reaction 或“正在整理需求”消息。
- 需求对话阶段，同一条 Agent 回复按短句、语义片段或 500ms-1000ms 节流窗口持续更新，不刷多条重复消息。
- Agent 最终输出澄清问题或确认卡片；不会直接创建 issue。
- 用户点击确认后，进度消息接管执行阶段。
- issue / PR / preview 生成后都有稳定 thread 消息。
- Platform Dev Lane 的 issue 有稳定 type / area / risk label，PR merge / close 会回写原 Slack thread。
- Platform Dev issue 不会在发起人点击“自动开发”前进入 Coding Agent。
- 同一 Slack user 的不同 session 不串线。
- 同一 thread 中不同用户不共享 memory、active job 或 pending questions。
- 同一 session 同时只允许一个 running `AgentRun`。
- gateway / notifier 任一 Pod 重启后，不会重复创建 job，也不会重复刷 Slack。
- Slack bot token 不进入 executor / GitHub Actions / coding-agent。
- Slack 输出不包含 system prompt、provider 原始响应、token、secret 或内部 debug trace。

## Review checklist

实现或 review Slack 相关 PR 时，至少检查：

- [ ] 没有重新引入 Socket Mode 或本地 listener。
- [ ] Slack HTTP 请求使用 raw body 校验 signature。
- [ ] 入口 handler 3 秒内 ACK，不同步等待长任务。
- [ ] 每个 Slack event / interaction 都有非空 dedupe key。
- [ ] interaction dedupe 包含单次点击 id 或完整 payload hash，不会把用户第二次合法点击误判成 retry。
- [ ] Slack session 按 `(team_id, slack_user_id, session_key)` 隔离。
- [ ] site follow-up 既能从 `activeJobId` 找任务，也能从 `activeWorkItemKind=site_publishing` + `activeWorkItemId` 找任务。
- [ ] 同一 session 只有一个 running `AgentRun`。
- [ ] 对话阶段 Agent 回复 `channel + message_ts + offset/sequence` 持久化，且不依赖 job 已创建。
- [ ] delta 使用 `sequence` 或 offset 去重。
- [ ] Slack update 限流，不会每个 token 都打一次 Slack API；执行阶段只按阶段变化更新进度消息。
- [ ] `analysis_final` 是创建 job 的唯一 Agent 结构化依据，不能从可见文本反解析。
- [ ] 确认创建仍然需要用户点击按钮或明确受控动作。
- [ ] runtime skill 只注入 always-on 与当前 lane / intent / context 需要的片段，repo 咨询、诊断、建站和平台开发指令不能全量混入同一轮 prompt。
- [ ] Platform Dev Lane issue 分类、label、risk 和 automation policy 都来自结构化输出，并由 gateway 二次校验。
- [ ] 高风险目录或 secret / production deploy 相关请求默认 `agent:blocked`。
- [ ] 进度消息和 Agent 回复使用不同 binding 或明确 `message_kind`。
- [ ] `chat.update` 失败有补偿策略。
- [ ] 旧 attempt / 旧 stage 事件不会覆盖新进度消息。
- [ ] executor progress 通过 `/internal/executor-callback` 或受控 gateway API 进入状态机。
- [ ] 正式 K8s 路径下 Slack bot token 只进入 `slack-notifier`。
- [ ] executor / GitHub Actions / coding-agent 不持有 Slack token。
- [ ] Agent 回写内容经过 secret-like 脱敏。
- [ ] 多副本下不会重复发消息或重复推进 job。
- [ ] 文档、DB schema、内部 endpoint 说明和测试保持一致。

## FAQ

### Slack Agent 是常驻 Agent 吗？

常驻的是 `apps/slack-agent` 服务、DB 中的 session / memory / issue link，以及平台的运行边界。不是每个用户一个常驻模型进程，也不是一个 Slack thread 永远占住一个容器。每条消息会生成短 `AgentRun`。

### 多个用户能同时触发吗？

可以。隔离边界是 `team_id + slack_user_id + slack_session_id`。同一用户可有多个 session；不同用户即使在同一 thread，也不能共享 memory 或 active job。

### Slash Command 是否更适合流式 runtime？

不适合。Slash Command 适合快速唤起入口，后续多轮对话应回到普通 Slack message event 和 thread。语义分块准流式回复由 `slack-agent turn` + `slack-notifier` 更新普通消息实现。

### 能做到真正 token 级流式吗？

不建议追求真正 token 级。产品目标是接近实时的语义分块更新：Agent 内部可以 token streaming，但 Slack 对外应按短句、语义片段或 500ms-1000ms 节流窗口更新同一条消息。未来即使接 Slack 原生 `chat.startStream` / `chat.appendStream` / `chat.stopStream`，也只是更平滑的输出通道，不代表要按 token 刷屏。

### 为什么不把 slack-notifier 放进 gateway？

gateway 要快速 ACK、做签名校验、幂等、权限和状态机。Slack Web API 是慢 I/O，还会 rate limit、失败、重试和 dead-letter。拆出 notifier 可以隔离 token、隔离故障、独立限流，也让 gateway 更容易横向扩容。

### Slack token 可以给 Slack Agent 吗？

默认不需要。Slack Agent 如果未来必须拉 thread / channel 上下文，需要单独评审最小只读 scope 和调用路径。Slack token 无论如何不能进入 GitHub Actions、coding-agent、builder、site-check 或 deployer。

### `analyze` 还要兼容吗？

不用。项目当前未正式上线，生产路径可以直接迁移到 `/internal/slack-agent/turn`。`analyze` 可以删除，或仅保留为本地测试 helper。

### Execution 阶段也要 token 流式吗？

不建议。执行阶段应使用进度消息和关键节点消息，按 issue、PR、Review、Preview 等阶段变化更新。后台日志、shell 输出、diff、stack trace 和模型碎片输出不应该刷进 Slack。

### SSO 登录态跟 channel 还是 thread 绑定？

都不是。SSO 绑定跟随 Slack user：`team_id + slack_user_id -> User / Employee`。Channel / thread 只是上下文和回写位置。

### GitHub Actions runner 能继承 Slack 对话上下文吗？

不能直接继承。GitHub Actions 是一次性 executor，只接收 gateway / worker 派发的 job context。Slack session、memory、issue link 的真相源在 DB，不能靠 runner 会话或本地状态继承。
