# Slack Agent Session

## 定位

Slack Agent 是服务器常驻的会话理解层。MVP 本地先运行在 K8s `pages-system` namespace，后续测试服务器和生产也沿用同一套常驻服务形态。它不是“一条 Slack 消息就结束”的脚本，而是一个长期运行的 Agent runtime：每次 Slack 消息到达时，加载对应 `SlackSession` / `SessionMemory` / `IssueLink`，调用配置的模型供应商，再把本轮输出写回会话和平台状态。

这里的“常驻”不是一个模型进程永久占住某个用户，也不是每个用户单独起一个容器。常驻的是 `apps/slack-agent` 服务、会话状态、记忆、权限上下文、issue / PR / preview 关联和 Agent 工具边界。模型能力统一来自公司 Agent Gateway；API key 只作为 `slack-agent` 的运行时 secret 注入。

```text
Slack message
  ↓
Slack HTTP event / interaction
  ↓
pages-gateway
  ↓
apps/slack-agent
  ↓
model provider API
  ↓
SlackSession / SessionMemory / IssueLink
  ↓
PublishingJob / GitHub issue / PR
```

Slack Agent 不改代码，也不直接创建 issue。它只负责理解人、会话、需求、权限和已有 issue / PR 关系。`apps/gateway` 负责 Slack 签名校验、ack、权限、状态机和派发；`apps/worker` 负责受控 GitHub API 写操作，例如创建 issue。

当前 `apps/slack-agent` 保留确定性 MVP adapter 作为本地 smoke fallback，正式运行通过 provider adapter 调公司 Agent Gateway。公司网关内部如何路由模型不进入 pages-manager；对外必须返回同一份结构化分析结果，并继续遵守 gateway / worker 的工具权限边界。

## 用户隔离和多 Session

Slack Agent 会话必须按用户隔离，但一个用户可以有多个 session。`primarySlackUserId` 是安全隔离边界，`sessionKey` 是同一用户下的会话定位：

```text
userScopeKey = teamId + primarySlackUserId
sessionKey = explicit session id | channel thread | dm current / dm task session
conversationKey = userScopeKey + sessionKey
IssueLink = job / issue / PR / preview alias -> session
```

Slack channel、thread、DM channel 是消息 surface 和上下文窗口；它们可以帮助定位 session，但不能跨用户共享 session：

```text
surfaceContext = channelId + threadTs + dmChannelId + eventTs
```

这意味着：

- 同一个用户可以同时有多个 `SlackSession`，例如个人主页、活动页、旧 preview 修改和状态咨询可以分开。
- 同一个 Slack thread 里如果有多个人同时 @bot，每个人只会进入自己名下的 `SlackSession`，不能共享 memory、active job 或 pending questions。
- Channel 不能成为登录主体；thread 不能成为权限主体。
- 频道消息可以作为当前用户会话的证据来源，但不能把别人的消息自动并入该用户的需求，除非该用户明确引用并且权限允许。
- 如果用户要修改某个旧 preview，优先通过该用户自己的 `IssueLink` 找 active 或 recent session；找不到唯一候选时必须反问，而不是猜测。
- Slack 回写必须带 `<@primarySlackUserId>` 前缀；同一个 thread 中多人对话时，用户只能接收明确 @ 自己的进度。

Session 选择规则：

- 消息明确带 `session_id`、`job_xxx`、issue number、PR link 或 preview URL：定位到该用户有权限访问的对应 session。
- 频道 / thread 消息：默认使用该用户在这个 `channelId + threadTs` 下的 session；没有则创建新的 thread-scoped session。
- DM 消息：如果用户只有一个未过期 active session，默认续接；如果有多个 active / recent session，必须反问选择，除非用户说“新建一个”。
- 用户明确说“新建会话”“重新做一个”“另开一个版本”：创建新的 session。
- 用户说“刚才那个”：只在该用户最近 active session 唯一且未过期时续接，否则反问。

## 必要数据

`SlackSession`：

```text
session_id
team_id
session_key
session_title
channel_id
thread_ts
dm_channel_id
surface_context_json
primary_user_id
owner_scope_id
active_job_id
active_issue_number
active_pr_number
active_preview_url
active_context_expires_at
status
last_intent
last_active_at
closed_at
created_at
updated_at
```

`SessionMemory`：

```text
session_id
summary
requirements_json
pending_questions_json
preferences_json
last_preview_feedback
last_agent_response
updated_at
```

`IssueLink`：

```text
session_id
publishing_job_id
issue_number
pr_number
branch_name
preview_url
head_sha
relationship: primary | followup | superseded
created_at
updated_at
```

这些记录必须按 workspace、用户和 session 隔离。不同员工的 memory 不能串；同一个用户的不同 session 也不能串。任务通过 `IssueLink` 和 owner scope 权限边界隔离，不能把一个任务的 preview 反馈误写到另一个任务。

其中用户隔离键是 `(team_id, primary_slack_user_id)`，session 唯一键是 `(team_id, primary_slack_user_id, session_key)`。`owner_scope_id` 和 `IssueLink` 用于任务级权限和站点归属。一个用户可以同时拥有多个 `SlackSession` 和多个 `IssueLink`，但 Slack Agent 每次要操作具体任务时必须明确选中一个 active / recent session。

## 无限对话模型

Slack Agent 必须支持同一 Slack DM 或 thread 内的长期多轮对话：

```text
用户第一次描述需求
  ↓
Slack Agent 澄清 / 总结 / 等待补充
  ↓
用户补充信息
  ↓
Slack Agent 更新 SessionMemory
  ↓
需求足够明确后请求 gateway 创建 PublishingJob / issue
  ↓
Preview 返回
  ↓
用户继续反馈“不满意，改这里”
  ↓
Slack Agent 复用 IssueLink，追加 issue comment，触发 fix round
```

无限对话不代表无限自动执行。每轮消息都必须经过 intent 分类、权限校验、会话关联、幂等和安全策略。Slack Agent 可以持续对话、反问、总结和续接，但创建 issue、追加 issue comment、触发 coding agent、发布 preview 都必须通过 gateway / worker 的受控工具完成。

会话压缩策略：

- 原始 Slack 消息进入 `SlackMessageBatch` 或等价事件表。
- `SessionMemory.summary` 保存长期摘要，避免每次把完整 thread 都塞进模型上下文。
- `requirements_json` 保存结构化需求和最新版本。
- `pending_questions_json` 保存当前必须等待用户回答的问题。
- `IssueLink` 保存 active job / issue / PR / preview，支持用户后续说“这个 preview 再改一下”。
- 每次模型调用记录 `AgentRun`，包含 prompt version、policy version、输入摘要 hash、输出 hash 和工具调用结果。

## Session 过期和主动关闭

会话历史不应该被随意删除，但 active context 不能永远默认续接。推荐默认值：

| 项 | 默认值 | 行为 |
| --- | --- | --- |
| active context TTL | 2 小时 | session 2 小时无消息后，`active_job_id` / `active_issue_number` 不再默认续接；用户明确引用 session / job / issue / PR / preview 时可恢复 |
| waiting clarification TTL | 1 天 | Agent 问了澄清问题但用户 1 天未答，状态改为 `paused`，再次收到消息时先确认是否继续 |
| recent selectable window | 14 天 | 过期但未归档的 session 可作为“最近任务”候选展示给用户选择 |
| archive after inactive | 90 天 | session 进入 `archived` 或压缩 memory；IssueLink 和审计记录继续保留 |
| user close command | 立即 | 用户说“关闭会话”“结束这个任务”“不用了”“归档”等，状态改为 `closed`，清空 active context |

关闭或过期只影响“默认续接”。它不能删除 GitHub issue、PR、preview、DeployRecord 或 AgentRun。用户后续如果带着 session id、issue number、PR link、preview URL 或 job id 回来，Slack Agent 可以在权限校验通过后恢复为 active context。

主动关闭规则：

- `close_session`：关闭当前选中的 session，清空 active job / issue / PR / preview。
- `close_current_task`：只关闭当前 active IssueLink，保留该 session。
- `cancel_request`：如果 job 仍未进入不可逆阶段，gateway 可尝试取消；否则转为人工确认或仅关闭会话。

默认自然语言：

```text
关闭会话
结束对话
这个任务不用了
归档这个 preview
先到这里
```

## Agent Run 生命周期

`apps/slack-agent` 是常驻服务，但 Agent 的每一轮模型调用不是长期 active session。每条 Slack 消息会生成一条 `AgentRun(agent_kind=slack_agent)`：

```text
Slack message
  ↓
获取 session lease
  ↓
加载 SlackSession / SessionMemory / IssueLink
  ↓
调用模型供应商
  ↓
写回结构化 intent / summary / toolRequest
  ↓
释放 lease
```

推荐默认值：

| 项 | 默认值 | 行为 |
| --- | --- | --- |
| Slack Agent turn timeout | 120 秒 | 单轮模型调用和工具规划超过 120 秒即失败并回写可重试提示 |
| Slack Agent session lease | 180 秒 | 同一 `slack_session_id` 同时只允许一个 AgentRun 处理，避免两条 Slack 消息并发改同一 memory |
| Slack Agent retry | 2 次 | 只重试网络或供应商 5xx；模型安全拒绝、权限失败、输入不明确不自动重试 |
| Provider thread TTL | 24 小时 | 如果使用模型供应商 thread / assistant id，只作为缓存；DB 中的 SessionMemory 才是真相源 |
| Coding Agent run timeout | 30 分钟 | `pages-agent.yml(mode=initial or fix)` 是一次性执行，超时后写失败状态，不能常驻 |

AgentRun 规则：

- Slack Agent 可以持续对话，但每轮都必须是可审计的短 AgentRun。
- 同一 session 的 AgentRun 需要按 `round_no` 递增；过期或失败的 run 不能覆盖后续 run 的 memory。
- 模型供应商的 provider thread 不能成为唯一记忆；重启、换供应商或 TTL 到期后必须能从 DB 摘要恢复。
- Coding Agent 不使用 Slack session lease；它绑定 `PublishingJob`、`JobStageAttempt`、`allowedPath` 和 PR branch。
- Coding Agent 超时或失败后，只能由 gateway/worker 创建新的 retry attempt，不能在原 run 上继续隐式执行。

## Intent 分类

Slack Agent 每次收到消息后先做分类：

| Intent                                                                       | 动作                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `create_or_update_site` / `new_site_request` / `create_site` / `update_site` | 需求已经足够明确，gateway 可以创建新的 `PublishingJob` 和 issue |
| `modify_existing_preview`                                                    | 追加 issue comment，触发 fix round                              |
| `append_requirement`                                                         | 追加需求到当前 issue / session memory                           |
| `status_query`                                                               | 查询当前 job / issue / PR / preview 状态                        |
| `cancel_request`                                                             | 标记取消或转人工确认                                            |
| `close_session`                                                              | 关闭当前选中的 session                                          |
| `close_current_task`                                                         | 关闭当前 active issue / PR / preview 关联                       |
| `choose_version`                                                             | 记录用户选择，必要时触发后续 deploy                             |
| `clarification_reply`                                                        | 补齐 pending question 后继续创建或修改                          |
| `clarify` / `unknown`                                                        | 反问或继续闲聊，不创建 job                                      |

同一用户如果只有一个未过期 active session，默认续接该 session 的 active job。新 thread 可以创建该用户自己的新 session，但不会创建共享会话。若该用户已有多个 recent session / job，消息又没有明确引用 session id、job id、issue number、PR number 或 preview URL，Slack Agent 必须反问“你要改哪一个 preview / issue？”。

gateway 的硬规则：

- Slack 用户不需要使用 `/issue`、`issue:` 或其它命令；除 `help` / `ping` / `status` / `cancel` / `close` 等控制类消息外，普通文本都作为 `agent_turn`。
- `needsClarification=true` 时只回 Slack 澄清问题，不创建 `PublishingJob`。
- 没有 active job / issue / PR / preview 时，`append_requirement` / `modify_existing_preview` 不得凭空修改任务，必须要求用户选择或新建。
- 没有配置 Slack Agent provider 时，自由聊天只记录会话并回复兜底提示；明确 `issue:` 兼容命令仍可走确定性 smoke 流程。

## Preview 不满意时

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

修改 preview 不应该默认新建 PR。默认修复同一个 PR branch，除非用户明确要求“重新开一个版本”或当前 PR 已结束。

## Slack Agent 工具边界

Slack Agent 可以使用：

```text
loadSession
saveSessionMemory
createPublishingJob
appendIssueComment
getJobStatus
getLinkedIssuePrPreview
askClarification
notifySlack
```

Slack Agent 不能使用：

```text
git push
create branch
create PR
write repository files
deploy preview / production
read Cloudflare token
read GitHub push token
read production secret
```

即使 Slack App 权限在 MVP 阶段先拉满，运行时也不能把 Slack token 传给 GitHub Actions、Coding Agent、builder、site-check 或 deployer。

## Issue 续接规则

Slack Agent 判断是否复用已有 issue：

- 当前选中 session 有唯一 active issue：默认追加 comment。
- 当前用户有多个 recent issue / preview：必须要求用户选择，不能猜。
- 消息包含 `job_xxx`：查该 job 并确认 actor 有权限。
- 消息包含 `#123` 或 PR 链接：查 issue / PR 并确认属于可管理站点。
- 用户说“新建”“重新做一个”：创建新 issue。
- 用户说“刚才那个”：只在当前用户最近 session / 任务唯一且权限匹配时续接，否则反问。

所有续接和修改都必须落 GitHub issue comment，保证 Slack 对话不会成为唯一真相源。

## 测试态约束

当前本地 MVP 可以使用：

```text
employeeSlug = smoke
siteSlug = profile
baseRef = staging
environment = preview
```

即使放开 issue / PR 复用限制，仍然是测试态：

- 不合并 production。
- 不改 `master`。
- 不允许自动 PR 触碰平台代码。
- Preview 使用 staging deploy token。
- 站点内容只允许写 `sites/smoke/profile/**` 或当前 job 明确的 `allowedPath`。

## 实现顺序

1. 增加 `SlackSession`、`SessionMemory`、`IssueLink` 持久化。
2. 新增 `apps/slack-agent`，将当前 `slack-intake` 从规则分类升级为 Slack Agent adapter，但保留规则兜底。
3. 同一用户在选中 session 内的 follow-up 默认走 `modify_existing_preview` 或 `append_requirement`；thread 只作为 Slack 回复位置和上下文来源。
4. issue comment 写入后触发 `pages-agent.yml(mode=fix)`。
5. 增加 `active_context_expires_at`、`max_fix_rounds`、debounce 和人工接管。
