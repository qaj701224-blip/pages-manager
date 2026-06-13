# Slack To PR Review Agent Flow

## 定位

这条链路是 MVP 的第一主线：

```text
Slack 发消息
  ↓
创建 GitHub Enterprise issue
  ↓
coding agent 自动编码
  ↓
controlled-committer 自动创建 PR
  ↓
实时监听 GitHub Review Agent 在 PR 里的 comment
  ↓
按 comment 触发 agent 修复或等待人工处理
  ↓
site-check / pages-site-policy / Review Agent gate 通过
  ↓
preview deploy
  ↓
回写 Slack
```

这里的重点不是平台自己生成一段“AI review 结论”，而是把 GitHub Enterprise PR 中 GitHub Review Agent 提交的 comment 当成一等事件处理。平台要实时接收、入库、分类、回写 Slack，并在允许时把 blocking comment 作为 coding agent 修复输入。

## 核心约束

- Slack 是 MVP 默认用户入口，Internal API 是高级入口，两者最终都进入同一个 `pages-gateway` 状态机。
- issue、PR、review comment 和 Preview deploy 都在公司 GitHub Enterprise 的 `pages-manager` repo 内闭环；production merge / deploy 是 Preview 闭环后的后续阶段。
- coding agent 只生成 workspace patch，不持有 repo write token。
- 只有 controlled-committer 能在 patch 校验通过后创建 branch、commit 和 PR。
- GitHub Review Agent comment 只通过 GitHub webhook 实时进入平台，不让 GitHub Actions runner 或 K8s job 长轮询 PR。
- `review-monitor-worker` 是长期形态下监听和归一化 Review Agent comment 的主组件；当前 MVP 先在 `pages-gateway` 的 `/integrations/github/webhook` 内完成同样的归一化和 gate 推进。
- Slack bot token 只进入 `pages-gateway`、`apps/slack-connector`、`apps/slack-agent`、`slack-notifier`，不进入 coding-agent、builder、site-check、committer、deployer workflow/job。

## Slack 运行位置

Slack App 本身是外部系统，不跑在 GitHub Actions 或 K8s 内。

`pages-manager` 内部只运行 Slack 相关接入和处理组件：

```text
pages-gateway
  └─ POST /integrations/slack/events
  └─ POST /integrations/slack/commands
  └─ POST /integrations/slack/interactions

apps/slack-agent
  └─ 加载 session / memory / issue link，拉取 thread，总结需求，生成结构化输入

slack-notifier
  └─ 回写 job、issue、PR、review、deploy 进度
```

MVP 这些常驻组件先放进本地 K8s 的 `pages-system` namespace；Actions-first executor 不要求先建 `pages-jobs` namespace。

MVP Actions-first 时，一次性的生成、构建、校验、提交、preview 任务跑在 GitHub Actions runner；后续 K8s 模式下，`page-job-<jobId>` 或 `pages-jobs` namespace 只运行这些任务。两种模式都不运行 Slack bot。

GitHub webhook 入口：

```text
GitHub Review Agent / GitHub Actions
  ↓
POST /integrations/github/webhook
  ↓
pages-gateway
  ↓
GitHubWebhookDelivery + ReviewAgentComment
  ↓
Preview gate / fix gate
```

公网或 staging gateway 必须配置 `GITHUB_WEBHOOK_SECRET` 校验 `X-Hub-Signature-256`。本地 quick tunnel smoke 可以临时不配，但不能作为长期部署方式。

## 端到端步骤

### 1. Slack 事件进入 gateway

Slack 调用：

```text
POST /integrations/slack/events
POST /integrations/slack/commands
POST /integrations/slack/interactions
```

gateway 必须先完成：

- 校验 Slack signature 和 timestamp。
- 生成非空 `dedupe_key`。
- 写入 `SlackEvent`。
- 使用 `(team_id, dedupe_key)` 做幂等。
- Slack retry 命中已有 `SlackEvent`，不能重复创建 issue 或 PR。

### 2. 解析 actor

真人消息：

```text
slack_user_id
  ↓
ExternalIdentityBinding(provider=slack)
  ↓
User / Employee
```

另一个 SlackBot 发来的消息：

- 先作为 `SlackMessageBatch.source_type=bot` 记录。
- 没有 `TrustedSlackBotPolicy` 时只能作为需求证据。
- `TrustedSlackBotPolicy(mode=require_human_confirm)` 时，需要真人在 thread 内确认。
- `TrustedSlackBotPolicy(mode=service_account)` 时，映射到 `ServiceAccount`，再检查 service account 是否有站点管理权限。

### 3. Slack Agent 汇总 Slack thread

`apps/slack-agent` 加载 `SlackSession` / `SessionMemory` / `IssueLink`，拉取 thread 上下文并生成结构化摘要：

```json
{
  "intent": "create_or_update_site",
  "employeeSlug": "zhangsan",
  "siteSlug": "q2-report",
  "title": "Q2 Growth Report",
  "summary": "把 thread 中的需求整理成可执行页面需求。",
  "assets": [],
  "approvalMode": "manual-required",
  "sourceMessages": []
}
```

Slack Agent 不创建 PR、不合并、不部署。它只把摘要、意图和 issue/PR 续接关系回传给 gateway。

### 4. 创建 PublishingJob

gateway 校验 actor 是否能管理目标站点：

```text
SiteAdminGrant
owner scope
platform admin
service account grant
```

通过后创建：

```text
PublishingJob
JobStage
JobStageAttempt
JobEvent / AuditLog
```

### 5. 创建 GitHub Enterprise issue

`pages-worker` 使用 GitHub App installation token 创建 issue。

issue 必须包含：

- `PublishingJob` id。
- Slack thread 链接。
- 结构化需求摘要。
- 目标 `SiteProject`。
- 允许修改路径。
- 审计信息。

issue 是 coding agent 的主要任务说明，也是后续 PR 的追踪入口。

### 6. 固定项目索引

在触发 coding agent 前，gateway 必须为本次 job 选择或创建项目索引快照：

```text
ProjectIndexSnapshot
  repo_full_name
  base_sha
  allowedPath
  template context
  site context
  related issue / PR / ReviewAgentComment context
```

MVP 不需要独立索引 repo，先由 `project-index.yml` / `apps/indexer` 在 `pages-manager` 大仓内完成。索引只提供 agent context，不改变写权限。

### 7. Coding agent 自动编码

gateway 创建 agent stage。MVP 默认触发 GitHub Actions workflow：

```text
pages-gateway
  ↓
workflow_dispatch / repository_dispatch
  ↓
.github/workflows/pages-agent.yml
  ↓
GitHub Actions runner
```

后续如果切到 K8s executor，同一 stage 可以由 K8s Job 执行：

```text
namespace: pages-jobs
job: job-<jobId>-coding-agent
```

也就是说，编码 agent 前期跑在 GitHub Actions runner，后期可跑在 `coding-agent-runner` 这个一次性 K8s Job container 里。它不是 Slack bot、不是 gateway 进程，也不是 GitHub Review Agent。

coding agent 输入：

- issue 内容。
- Slack 摘要。
- 目标 `SiteProject`。
- 当前站点源码。
- 模板和 `site.json` schema。
- 允许修改的 repo path。
- 如果是修复轮次，还包括 open blocking `ReviewAgentComment`。

coding agent 输出：

```text
workspace/generated/
workspace/patches/site.patch
workspace/report.json
```

coding agent 不直接 push，不直接创建 PR，不直接发 Slack。

### 8. 候选代码编译

coding agent 生成 patch 后，必须编译候选代码。MVP 可以在同一个 `pages-agent.yml` workflow 内完成：

```text
GitHub Actions runner
  ↓
install deps
  ↓
lint / test / build
  ↓
write build report
```

后续 K8s executor 可以把这一步拆成 `Job job-<jobId>-builder`。

builder / workflow job 不持有 Slack bot token、Cloudflare deploy token 或 auto-merge token。

这一步是“提交 PR 前的预构建”，用来尽早发现 agent 生成的代码是否能跑。但它不能替代 PR 创建后的 GitHub required check。

### 9. Controlled committer 创建 PR

controlled-committer 先校验 patch：

- 只修改 `sites/<employee-slug>/<site-slug>/`。
- 不修改 `.github/**`、`apps/**`、`packages/**`、`templates/**`、`k8s/**`。
- `site.json` schema 通过。
- 文件大小、禁止目录、secret 扫描通过。

校验通过后，controlled-committer 短暂获取 GitHub App installation token：

```text
create branch
create commit
create PR
```

PR body 必须包含：

- issue link。
- `PublishingJob` id。
- Slack thread link。
- 目标站点路径。
- 自动生成说明。
- 当前 approval mode。

### 10. CI 和确定性检查

PR 创建后，GitHub Actions / Rulesets 至少运行：

```text
site-check
pages-site-policy
```

确定性检查负责机器可稳定判断的内容：

- path allowlist。
- `site.json` schema。
- secret 扫描。
- 文件大小。
- 禁止构建产物。
- build / lint / link check。
- 站点名合法性。

这些检查不能替代 GitHub Review Agent comment 监听。

### 11. 实时监听 GitHub Review Agent comment

GitHub Enterprise webhook 统一进入：

```text
POST /integrations/github/webhook
```

gateway 校验：

- webhook signature。
- `delivery_id` 幂等。
- repo allowlist。
- event allowlist。

然后由 `review-monitor-worker` 处理这些事件：

| 事件 | 用途 |
| --- | --- |
| `pull_request_review` | Review Agent 提交 summary、approve、changes requested、commented |
| `pull_request_review_comment` | Review Agent 提交 inline comment |
| `issue_comment` | Review Agent 在 PR conversation 里提交总结或建议 |
| `check_run` / `check_suite` | Review Agent 以 check 形式输出结果 |

`review-monitor-worker` 只处理 allowlist 命中的 Review Agent：

```text
GITHUB_REVIEW_AGENT_ALLOWLIST
  - GitHub App id / slug
  - bot login
  - check run name
```

未命中 allowlist 的 comment 只能作为人工评论或普通信息，不能触发自动修复。

### 12. ReviewAgentComment 入库

每条 Review Agent comment 归一化为：

```text
ReviewAgentComment
  publishing_job_id
  repo_full_name
  pr_number
  github_review_id
  github_comment_id
  github_comment_node_id
  source_type
  review_agent_login
  path
  line
  diff_hunk
  body
  classification: blocking | suggestion | note | unknown
  status: open | resolved | outdated | dismissed | deleted
  first_seen_delivery_id
  last_seen_delivery_id
```

幂等约束：

```text
unique(repo_full_name, github_comment_node_id)
```

edited、deleted、dismissed 或 outdated 事件必须更新同一条记录，不能追加成新 comment。

### 13. Comment 分类和动作

MVP 分类规则：

| classification | 动作 |
| --- | --- |
| `blocking` | 推动 job 进入 `changes_requested`，可触发 `AgentRun(type=fix)` |
| `suggestion` | 回写 Slack / issue，默认不触发修复，不阻塞 Preview gate |
| `note` | 只记录和回写，不阻塞 |
| `unknown` | 回写 Slack 并等待人工确认；不自动修复；不得进入 `trusted-auto` |

为了避免 Review Agent 连续提交多条 comment 导致多次修复，`review-monitor-worker` 应该有短暂 debounce：

```text
同一个 PR / delivery / review round
  ↓
聚合新增 open blocking comments
  ↓
创建一轮 AgentRun(type=fix)
```

### 14. Agent 根据 blocking comment 修复

如果存在 open blocking `ReviewAgentComment`，并且没有超过 `max_fix_rounds`：

```text
ReviewAgentComment(open, blocking)
  ↓
PublishingJob.status = changes_requested
  ↓
AgentRun(type=fix, round=N)
  ↓
pages-agent workflow 或 coding-agent-runner 读取 blocking comments
  ↓
生成修复 patch
  ↓
controlled-committer 校验 patch
  ↓
push 到同一个 PR branch
  ↓
PublishingJob.status = reviewing
  ↓
等待 GitHub Review Agent 新一轮 comment
```

每一轮修复都必须有新的 `JobStageAttempt` 和 `AgentRun`，不能覆盖上一轮记录。

超过 `max_fix_rounds` 后，平台停止自动修复，回写 Slack 并等待人工处理。

### 15. Preview gate 和 Preview deploy

第一优先级默认只自动进入 Preview：

- Review Agent comment 可触发自动修复。
- `site-check` / `pages-site-policy` 和 Review Agent gate 通过后自动部署 Preview。
- Preview 使用 PR head SHA 或受控 agent branch 构建。
- Preview 成功后写 `DeployRecord(environment=preview)`。
- Preview URL 回写 Slack、issue 和 PR。
- production 合并仍然是后续阶段。
- `trusted-auto` 是后续能力。

第一阶段的 Preview gate 必须满足：

```text
site-check passed
pages-site-policy passed
no open blocking ReviewAgentComment
no open unknown ReviewAgentComment
PR only touches allowedPath
no active fix attempt
```

### 16. 后续 production merge 和 deploy

Preview 闭环跑通后，如果再启用 production merge，gateway 只信任已记录的 merge 事件：

```text
repo_full_name
pr_number
merge_commit_sha
site_project_id
```

deployer 只能从 `merge_commit_sha` 构建 production，不能从 floating branch 构建。

production deploy 成功后写入：

```text
DeployRecord
SiteProject.current_deploy_id
JobEvent / AuditLog
```

并回写 Slack、issue 和 PR。

## 状态机摘要

```text
received
summarizing
issue_creating
issue_created
indexing
generating_page
patch_generated
branch_committed
pr_created
reviewing
changes_requested
fixing
reviewing
previewing
preview_deployed
```

失败时进入：

```text
failed
```

取消时进入：

```text
cancelled
```

所有状态变化必须写 `JobEvent` / `AuditLog`，并由 `slack-notifier` 回写 Slack thread。

## MVP 必须实现

- 一个统一 Slack bot。
- Slack signature、timestamp、dedupe_key 幂等。
- Slack actor 到内部用户的绑定。
- GitHub Enterprise issue 创建。
- coding agent initial run。
- controlled-committer 创建 PR。
- GitHub webhook 幂等。
- `ReviewAgentComment` 表。
- `review-monitor-worker` 监听 Review Agent comment。
- open blocking comment 触发一轮 `AgentRun(type=fix)`。
- 修复 commit push 到同一个 PR branch。
- `site-check` / `pages-site-policy` 和 Review Agent gate 通过后自动进入 Preview。
- `pages-preview.yml` 从 PR head SHA / agent branch 构建 Preview。
- `DeployRecord(environment=preview)`。
- Slack thread 实时回写状态。

## MVP 不做

- 不做 per-employee Slack bot。
- 不做 per-site Slack bot。
- 不让 Slack 消息绕过 issue / PR 直接部署。
- 不让 coding agent 直接 push。
- 不让 GitHub Actions runner 或 K8s job 长轮询 GitHub PR comment。
- 不默认启用 production 自动合并。
- 不把未知来源 comment 当作 Review Agent 反馈。
