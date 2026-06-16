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

`apps/slack-agent` 会把公司网关 BaseURL 归一化到 `/v1/chat/completions`，请求体使用标准 OpenAI chat completions 形态，`messages` 中携带当前 Slack 输入、session/memory/IssueLink 上下文和 JSON 输出要求。公司网关内部如何选择底层模型，不进入 pages-manager 的配置面。

Issue 创建不是由模型直接完成。当前和长期设计都应保持：

```text
Slack / API
  ↓
pages-gateway 做权限、幂等、会话和状态机判断
  ↓
apps/worker 使用平台 GitHub App / token 创建或复用 issue
```

公司 Agent Gateway 可以参与“起草 issue 标题、正文、验收标准、上下文摘要”，但不能直接持有 GitHub write token 去创建 issue。真正的 GitHub API 写操作必须由平台 worker / controlled committer 这类受控组件执行。

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
- 支持完全自然语言输入；`/issue`、`issue:`、`page:` 只能作为兼容入口，不能作为必要入口。
- 判断是否建议新建 issue。
- 判断是否续接已有 issue / PR / preview。
- 整理 Slack thread 成结构化需求。
- 识别权限、owner scope、站点管理关系。
- 需要时反问澄清。
- 输出结构化意图；由 gateway / worker 创建 `PublishingJob`、创建 issue 或追加 issue comment。

Slack Agent prompt 必须包含：

```text
company-publishing-policy
issue-template-policy
permission-policy
secret-handling-policy
SlackSession summary
IssueLink / active job / active preview
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
  "intent": "create_or_update_site | new_site_request | modify_existing_preview | status_query | append_requirement | cancel_request | close_session | clarify | unknown",
  "confidence": 0.0,
  "employeeSlug": "smoke",
  "siteSlug": "profile",
  "title": "个人主页",
  "summary": "用户希望生成一个个人主页，并在 preview 中展示唯一测试信息。",
  "issueAction": "create | append_comment | none",
  "targetJobId": "job_xxx",
  "targetIssueNumber": 123,
  "needsClarification": false,
  "clarifyingQuestion": "",
  "toolRequest": {
    "name": "createPublishingJob | appendIssueComment | getJobStatus | askClarification | none",
    "arguments": {}
  },
  "safetyNotes": []
}
```

`employeeSlug` 只作为模型理解结果的 hint。Slack 入口创建 job 时，gateway 必须根据 Slack team / user / profile 快照派生最终归属目录，例如 `zhangsan-a1b2c3`；不能让 Slack Agent 或用户文本直接决定别人的目录。

gateway 只在 `intent` 属于 `create_or_update_site` / `new_site_request` / `create_site` / `update_site` 且 `needsClarification=false` 时创建 `PublishingJob`。如果 Slack Agent 返回 `clarify`、`unknown` 或 `needsClarification=true`，gateway 只回 Slack 澄清问题并保存 `SessionMemory`。

## Coding Agent Prompt

Coding Agent 负责“代码和 PR”：

- 读取 issue。
- 读取 session summary。
- 读取 project index。
- 读取 review comments。
- 在 `allowedPath` 下生成 patch。
- 修复 Review Agent blocking comments。

Coding Agent prompt 必须包含：

```text
company-publishing-policy
coding-agent-policy
secret-handling-policy
site-isolation-policy
issue body
session summary
allowedPath
current site files
review comments when mode=fix
```

Coding Agent prompt 必须明确禁止：

```text
不要修改 allowedPath 之外的文件
不要修改 apps/**、packages/**、.github/**、k8s/**、templates/**、scripts/**
不要扩大 allowedPath
不要提交 dist/**、node_modules、缓存或大文件
不要读取或输出 Slack token、Cloudflare token、GitHub token
不要 merge PR
不要 deploy production
不要绕过 `site-check` / `pages-site-policy` / Review Agent gate
```

Coding Agent 输出合同：

```text
workspace patch
generated files under allowedPath
summary of changes
test/build notes
```

它不能直接持有 repo push token。受控 committer 在 diff validator 通过后，才可以使用 GitHub App token 创建 branch / commit / PR。

## Issue 规范

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

## Path Guard

每个 job 必须有单一 `allowedPath`：

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

任何触碰平台代码的自动 PR 都必须失败：

```text
apps/**
packages/**
.github/**
k8s/**
templates/**
scripts/**
```

这些路径只能走人工 review 的平台变更流程。

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

- `blocking`：触发 `pages-agent.yml(mode=fix)`，修同一个 PR branch。
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

## 当前阶段与长期形态

当前阶段可以先：

- 使用规则分类 + 简单 Agent adapter。
- policy / prompt 模板可以用 repo 内 Markdown 作为源文件，但每次运行绑定的 `PolicyVersion` / `PromptVersion`、hash 和 source ref 必须落 MySQL。
- 用 MySQL + Redis + Drizzle 跑本地 smoke；gateway 运行态只保留 DB store。
- 用 GitHub Actions 跑 Coding Agent。

长期需要：

- policy versioning。
- prompt versioning。
- DB 持久化 `PolicyVersion` / `PromptVersion` / `AgentRun`，每次 Slack Agent 和 Coding Agent 调用都记录 prompt version/hash、policy version/hash。
- 每轮 `AgentRun` 记录输入摘要 hash、结构化输出 hash；Coding Agent 额外记录输出 patch hash、`allowedPath` 和使用的 review comments。
- `site-check` 失败报告可以进入 Coding Agent fix 输入，但 Coding Agent 不能修改 `.github/workflows/site-check.yml`、gateway、worker 或其它平台代码来绕过规则。
