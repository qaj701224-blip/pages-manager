# Agent Policy And Prompts

## 原则

公司规则、issue 规范、权限边界和 secret 处理规则必须进入 Agent 的运行上下文，但不能把 token 明文放进 prompt。prompt 只描述规则和工具合同，真正 token 只注入给对应工具或组件。

```text
Policy docs
  ↓
Prompt templates
  ↓
Tool contracts
  ↓
Runtime context
```

Slack Agent 和 Coding Agent 必须使用不同 prompt、不同工具、不同 secret。

## 术语和当前实现边界

本文里的 Agent 指由平台服务编排的模型执行体，负责理解需求、生成结构化输出、写代码或处理 review feedback。`pages-manager` 只接入公司 Agent Gateway；底层模型由公司网关统一路由和切换，平台代码不直接集成外部模型供应商协议。平台内真正常驻的是 Agent runtime、会话状态、工具边界和审计记录，不是把某个用户长期绑定到一个独占模型进程。

当前代码里的 `apps/slack-agent` 已经有 provider adapter 边界：正式运行只调用公司 Agent Gateway；`deterministic` 仅作为本地单元测试 / smoke fallback，不作为生产模型入口。目标形态仍是服务器常驻的 Slack Agent runtime，运行在 K8s / 服务器上，持久化会话并在每条 Slack 消息到达时调用公司网关。

参考 `xdclaw` 的 Nova / AI Gateway 方式，模型切换不应散落在业务代码里，而是集中在配置和 provider adapter。公司模型网关的地址和路由名使用平台级 `AGENT_*` 变量，具体执行体的 API key 分开注入：

```text
AGENT_MODEL_PROVIDER=company-agent
AGENT_MODEL_NAME=<company gateway model/router name, optional>
AGENT_GATEWAY_URL=<company OpenAI-compatible BaseURL>
SLACK_AGENT_API_KEY=<Slack Agent runtime secret>
AGENT_CODE_API_KEY=<Coding Agent runtime secret, not mounted into Slack Agent>
```

`apps/slack-agent` 会把公司网关 BaseURL 归一化到 `/v1/chat/completions`，请求体使用标准 OpenAI chat completions 形态，`messages` 中携带当前 Slack 输入、session/memory/WorkItemLink 上下文和 JSON 输出要求。公司网关内部如何选择底层模型，不进入 pages-manager 的配置面。

Issue 创建不是由模型直接完成。当前和长期设计都应保持：

```text
Slack / API
  ↓
pages-gateway 做权限、幂等、会话和状态机判断
  ↓
apps/worker 使用平台 GitHub App / token 创建或复用 issue
```

公司 Agent Gateway 可以参与“起草 issue 标题、正文、验收标准、上下文摘要”，但不能直接持有 GitHub write token 去创建 issue。真正的 GitHub API 写操作必须由平台 worker / controlled committer 这类受控组件执行。

当前 Slack Agent 需要区分两条 lane：

```text
site-publishing
  目标：员工个人站点
  约束：只能修改 sites/<employeeSlug>/<siteSlug>/

platform-dev
  目标：pages-manager 自身研发 issue / PR
  约束：repo 全目录可改，但按 issue type、risk gate、CI、review 和 GitHub Rulesets 控制
```

## 推荐目录

```text
policies/
  company-publishing-policy.md
  issue-template-policy.md
  permission-policy.md
  secret-handling-policy.md
  site-isolation-policy.md

prompts/
  slack-agent-system.md
  slack-agent-developer.md
  coding-agent-system.md
  coding-agent-fix.md
```

`policies/` 是规则源，适合被多个 Agent 引用。`prompts/` 是面向具体 Agent 的系统提示词和开发者提示词。

## Slack Agent Prompt

Slack Agent 负责“人和需求”：

- 与用户在同一 Slack DM 或 thread 中持续多轮对话。
- 支持完全自然语言输入；`issue:`、`page:`、`site:` 这类前缀只能作为测试便捷入口，不能作为正式产品的必要入口。
- 判断是否建议新建 issue。
- 判断是否续接已有 issue / PR / preview。
- 判断用户诉求属于 Site Publishing Lane 还是 Platform Dev Lane。
- Platform Dev Lane 下输出 issue type、area、risk 和是否建议自动开发。
- 整理 Slack thread 成结构化需求。
- 识别权限、owner scope、站点管理关系。
- 需要时反问澄清。
- 输出结构化意图；由 gateway / worker 创建 `PublishingJob`、创建 issue 或追加 issue comment。
- 作为 XD Pages 的任务管家和问题诊断入口，解释当前任务状态、关联 issue / PR / preview、失败阶段、GitHub Actions 状态和下一步建议。

Slack Agent 对外文案必须使用产品语义。用户不需要知道 gateway、worker、MySQL、Redis、callback、status card、message binding、ECS 服务名或内部 job/session 字段；这些只能进入受控诊断数据、日志、审计或内部链接。Slack 可见回复应围绕“任务、阶段、Issue、PR、Preview、Workflow、失败原因、建议操作”组织。

Slack Agent prompt 必须包含：

```text
company-publishing-policy
issue-template-policy
platform-dev-issue-policy
permission-policy
secret-handling-policy
SlackSession summary
WorkItemLink / active work item / active preview
current Slack message
conversation summary
active pending questions
```

Slack Agent prompt 必须明确禁止：

```text
不要生成 patch
不要修改仓库文件
不要创建 branch / PR
不要调用 Cloudflare deploy
不要要求用户提供 token
不要把 token/secret 写入 Slack、issue、PR 或页面
```

Slack Agent 输出建议是结构化 JSON：

```json
{
  "visibleReply": "我来查看你已关闭的 issue 和 PR。",
  "lane": "site-publishing | platform-dev | support | unknown",
  "intent": "create_or_update_site | new_site_request | modify_existing_preview | append_requirement | create_platform_issue | platform_feedback | platform_question | list_work_items | switch_work_item | reopen_work_item | status_query | cancel_request | close_session | clarify | unknown",
  "confidence": 0.0,
  "toolCall": {
    "name": "list_my_work_items | switch_work_item | reopen_work_item | get_current_status | close_session | unsupported_destructive_request | cancel_request | record_followup | confirm_create_issue | confirm_platform_issue",
    "args": {
      "state": "active | all | closed",
      "kind": "issue | pr | unknown",
      "number": 123
    }
  },
  "workItemState": "active | all | closed",
  "employeeSlug": "smoke",
  "siteSlug": "profile",
  "issueType": "type:dev | type:bug | type:docs | type:feedback | type:question | type:ci | type:ops | type:security",
  "areas": ["area:gateway", "area:docs"],
  "risk": "risk:low | risk:medium | risk:high",
  "agentEligible": true,
  "requiresHumanGate": false,
  "title": "个人主页",
  "summary": "用户希望生成一个个人主页，并在 preview 中展示唯一测试信息。",
  "needsClarification": false,
  "clarifyingQuestion": "",
  "sourceMessages": [],
  "safetyNotes": []
}
```

`employeeSlug` 只作为模型理解结果的 hint。Slack 入口创建 job 时，gateway 必须根据 Slack team / user / profile 快照派生最终归属目录，例如 `zhangsan-a1b2c3`；不能让 Slack Agent 或用户文本直接决定别人的目录。

Slack Agent 负责决定下一步要请求哪个受控工具；gateway 负责执行工具时强制绑定当前 Slack 用户、当前 session、该用户名下的 job / issue / PR 和状态机。查询“我的任务”时 `state=active`，查询“历史 / 全部”时 `state=all`，查询“已关闭 / 已取消 / 失败”时 `state=closed`。恢复已关闭任务时使用 `reopen_work_item(kind, number)`；gateway 必须重新查询并确认对应 issue / PR 属于当前 Slack 用户且当前状态确实可恢复。即使 Agent 在 `toolCall.args` 中传入其它用户或其它 session，gateway 也必须忽略这些越权范围。

gateway 只有在 `toolCall.name=confirm_create_issue`、创建类 `intent` 且 `needsClarification=false` 时展示确认卡片；真正创建 `PublishingJob` 仍必须等用户点击确认按钮。如果 Slack Agent 返回 `clarify`、`unknown` 或 `needsClarification=true`，gateway 只回 Slack 澄清问题并保存 `SessionMemory`。

Platform Dev Lane 只有在 `toolCall.name=confirm_platform_issue`、`lane=platform-dev` 且 `needsClarification=false` 时展示平台 issue 创建确认卡。gateway 必须二次校验 `issueType`、`areas`、`risk` 和 `agentEligible`，不能完全信任模型。`type:feedback`、`type:question` 默认不触发 Coding Agent；`type:ci`、`type:ops`、`type:security` 默认需要人工 gate。

产品边界上，gateway 不应该把自然语言需求拆成大量硬编码分支。除了 help / ping / status、Slack / GitHub 签名校验、幂等、危险批量操作拦截和无 Agent 时的兜底路径，正常的“查询我的任务”“继续 issue / PR”“重新打开 issue / PR”“追加修改”都应先进 Slack Agent，由 Agent 输出 toolCall，再由 gateway 做权限收口和执行。

诊断类 intent 应优先围绕当前 Slack thread / 当前 work item 执行：

```json
{
  "visibleReply": "我来检查这个任务卡在哪一步。",
  "lane": "site-publishing | platform-dev | unknown",
  "intent": "diagnose_work_item | get_work_item_timeline | explain_work_item_blocker | get_workflow_status | retry_work_item | append_diagnosis_comment | human_triage",
  "toolCall": {
    "name": "diagnose_current_work_item | get_work_item_timeline | get_workflow_status | request_retry_work_item | request_append_diagnosis_comment | request_human_triage",
    "args": {
      "timeWindowMinutes": 30
    }
  },
  "needsConfirmation": false
}
```

诊断权限分层：

- 默认开放：当前任务状态、issue / PR / preview 关联、timeline、断点解释、受控日志摘要、GitHub Actions 状态、下一步建议。
- 需要确认：创建 issue、追加诊断 comment、重试失败流程、重新 dispatch workflow、恢复已关闭任务。
- 必须拒绝或转人工：创建 PR、合并 PR、生产部署、删除资源、批量关闭 issue / PR、读取 secret、任意 ECS 原始日志查询、直接 shell 到 ECS。

日志摘要工具必须由 gateway 重新绑定当前 Slack 用户、当前 session 和 work item；默认时间窗为 30 分钟，只查白名单服务，返回前必须脱敏 token、cookie、authorization、secret-like 字段。Slack Agent 不能把底层原始日志逐行贴回 Slack，只能给摘要、关键错误、request id、内部日志链接和建议动作。

## Coding Agent Prompt

Coding Agent 负责“代码和 PR”：

- 读取 issue。
- 读取 session summary。
- 读取 project index。
- 读取 review comments。
- 在当前 lane 的允许范围内生成 patch。
- 修复 Review Agent blocking comments。

Coding Agent prompt 必须包含：

```text
company-publishing-policy
coding-agent-policy
secret-handling-policy
site-isolation-policy
issue body
session summary
lane
Site Publishing Lane: allowedPath / current site files
Platform Dev Lane: issue type / area / risk / changed-area policy
issue type / area / risk
review comments when mode=fix
```

Coding Agent prompt 必须明确禁止：

```text
Site Publishing Lane: 不要修改 allowedPath 之外的文件
Site Publishing Lane: 不要修改 apps/**、packages/**、.github/**、k8s/**、templates/**、scripts/**
Platform Dev Lane: 可以修改 repo 全目录内与 issue 直接相关的文件，但必须声明风险和验证路径
Platform Dev Lane: .github/**、k8s/**、Dockerfile、部署脚本、secret、production deploy 相关改动必须标记高风险并等待人工 gate
不要扩大当前 lane 的权限边界
不要提交 dist/**、node_modules、缓存或大文件
不要读取或输出 Slack token、Cloudflare token、GitHub token
不要 merge PR
不要 deploy production
不要绕过 `site-check` / `pages-site-policy` / Review Agent gate
```

Coding Agent 输出合同：

```text
workspace patch
Site Publishing Lane: generated files under allowedPath
Platform Dev Lane: changed files with risk summary
summary of changes
test/build notes
```

它不能直接持有 repo push token。受控 committer 在 diff validator 通过后，才可以使用 GitHub App token 创建 branch / commit / PR。

## Issue 规范

### Site Publishing Lane

平台生成 issue body 使用稳定结构，方便 Slack Agent 续接、Coding Agent 读取、review/debug 追踪：

````md
<!-- pages-manager:job_id=job_xxx -->

## 发布需求

用户需求摘要。

## 发起人

- 发起人：张三
- 邮箱：zhangsan@example.com
- Slack 用户：`U123`
- 平台身份：`user:slack:T123:U123`

## 目标站点

- 归属目录：`smoke-a1b2c3`
- 站点名称：`profile`
- 允许修改目录：`sites/smoke-a1b2c3/profile/`

## 来源上下文

- 来源：Slack
- Team：`T123`
- Channel：`D123`
- Thread：`1710000000.000100`

## 自动化边界

- Coding Agent 只能修改 `sites/smoke-a1b2c3/profile/` 下的文件。
- 不允许修改平台代码、GitHub Actions、Kubernetes manifests、Dockerfile、部署脚本或任何 secret 配置。
- 本 issue 只驱动个人站点 preview 流程，不触发 production deploy。

## 验收标准

- 生成或更新个人网站内容，并保留用户需求里的关键标识。
- PR 只包含允许目录下的站点文件变更。
- site-check 和 Review Agent gate 通过后生成 preview URL。
- 用户可以继续在原 Slack thread 里追加修改意见。

## 自动化元数据

```text
PublishingJob: job_xxx
Source: slack
Requested by: user:slack:T123:U123
Requester: user:slack:T123:U123
Target: smoke-a1b2c3/profile
Allowed path: sites/smoke-a1b2c3/profile
Base ref: staging
Approval mode: manual_required
Pipeline: user-site publishing
Platform deployment: out of scope
```
````

后续 Slack 修改意见必须追加 issue comment，而不是只留在 Slack。

### Platform Dev Lane

Platform Dev Lane issue 使用独立模板，避免把站点目录隔离规则错误套到平台自身开发：

````md
<!-- pages-manager:platform-dev -->

## 类型

type:dev

## 背景 / 用户原话

Slack 需求摘要。

## 目标

要让 pages-manager 达成的产品或工程结果。

## 范围

- Lane: platform-dev
- Areas: area:gateway, area:docs
- Repo 范围：全目录，按 risk gate 约束

## 验收标准

- 可验证行为。
- 必须通过的测试 / CI。

## 风险

risk:medium

## 自动化策略

- agentEligible: true
- requiresHumanGate: false

## Slack 回写

- Team: `T123`
- Channel: `C123`
- Thread: `1710000000.000100`

## 自动化元数据

```text
Lane: platform-dev
IssueType: type:dev
Areas: area:gateway, area:docs
Risk: risk:medium
```
````

Platform Dev Lane 后续 Slack 补充也必须追加 issue comment，并同步更新原 Slack thread 状态。

## Secret 和 Token 规则

token 本身不进入 prompt、issue、PR、Slack 消息或生成页面。

| 组件                 | 可持有                                                           | 禁止持有                                         |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| Slack Agent          | Slack read/reply 能力、gateway service token、模型供应商 API key | GitHub push token、Cloudflare token              |
| Coding Agent         | 无 push token；只读 job context / repo workspace                 | Slack token、Cloudflare token、production secret |
| Controlled committer | GitHub App installation token                                    | Slack token、Cloudflare production token         |
| Preview deployer     | staging `PAGES_PREVIEW_TOKEN`                                    | Slack token、production deploy token             |
| Production deployer  | production deploy token，需人工或受控 gate                       | Slack token、coding model secrets                |

公司 Agent Gateway API key 必须按执行体分开注入。Slack Agent 只能读取 `SLACK_AGENT_API_KEY`，Coding Agent 只能读取 `AGENT_CODE_API_KEY`。任何 key 都不能进入 prompt、issue、PR、Slack 消息、`AgentRun` 明文字段、GitHub Actions log 或生成页面。

如果任何 Agent 在输入中看到疑似 secret：

```text
不要回显
不要写入 issue / PR / 页面
记录安全告警
要求用户轮换 secret
转人工
```

## Site Publishing Path Guard

Site Publishing Lane 的每个 `PublishingJob` 必须有单一 `allowedPath`：

```text
sites/<employeeSlug>/<siteSlug>
```

Slack 来源的 `employeeSlug` 由 gateway 派生：优先使用邮箱 local-part，其次 display name / real name / Slack name，最后 Slack user id；末尾追加 `teamId + slackUserId` 的短 hash，避免同名员工冲突且避免完整邮箱暴露在 repo 路径里。

自动 PR 必须满足：

```text
git diff --name-only 只包含 allowedPath/**
git diff --cached --name-only 只包含 allowedPath/**
git add 只允许 git add "$ALLOWED_PATH"
PR body 包含 PublishingJob / Target / Allowed path / Requester
pages-site-policy 通过
```

Site Publishing Lane 中，任何触碰平台代码的自动 PR 都必须失败：

```text
apps/**
packages/**
.github/**
k8s/**
templates/**
scripts/**
```

这些路径只能走 Platform Dev Lane 或人工 review 的平台变更流程。Platform Dev Lane 不使用 `allowedPath=sites/...` 作为主约束，而是使用 issue type、risk gate、CI 和 review 控制 repo 全目录改动。

## Review Fix Loop

Review Agent comment 进入 gateway 后：

```text
GitHub webhook
  ↓
ReviewAgentComment
  ↓
classification = blocking | suggestion | note | unknown
```

处理规则：

- Site Publishing Lane 的 `blocking`：触发 `pages-agent.yml(mode=fix)`，修同一个 PR branch。
- Platform Dev Lane 的 `blocking`：触发 `platform-agent.yml(mode=fix)` 或转人工，取决于 issue type、risk 和 gate 状态。
- `suggestion`：可记录，可选择是否修复，但不默认阻塞 preview。
- `note`：无 blocking 时允许 preview。
- `unknown`：不自动放行，转人工或等待更明确 review。

fix loop 必须有：

```text
max_fix_rounds
debounce window
headSha binding
same PR branch
Slack progress notification
```

## 企业级基线

Agent policy / prompt 不按最小实现降级。即使当前 executor 仍跑在 GitHub Actions，以下能力也属于企业级基线：

- policy versioning。
- prompt versioning。
- DB 持久化 `PolicyVersion` / `PromptVersion` / `AgentRun`，每次 Slack Agent 和 Coding Agent 调用都记录 prompt version/hash、policy version/hash。
- 每轮 `AgentRun` 记录输入摘要 hash、结构化输出 hash；Coding Agent 额外记录输出 patch hash、lane、Site Publishing `allowedPath` 或 Platform Dev risk summary，以及使用的 review comments。
- Site Publishing Lane 的 `site-check` 失败报告可以进入 Coding Agent fix 输入，但 Coding Agent 不能修改 `.github/workflows/site-check.yml`、gateway、worker 或其它平台代码来绕过规则。
- Platform Dev Lane 的 Agent 输入必须包含 issue type、area、risk、gate 状态、PR head SHA、review 摘要和允许动作；不能只靠自然语言 prompt 约束修改范围。
- GitHub Actions 可以继续作为当前 Coding Agent executor 载体，但必须通过 gateway callback、DB 状态机、policy / prompt 版本和审计记录形成完整闭环。
