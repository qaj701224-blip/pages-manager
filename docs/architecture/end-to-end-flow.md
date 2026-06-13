# End To End Flow

## 总入口

MVP 有两个正式入口：

```text
Slack
  默认用户入口

Internal API
  高级用户 / 管理员 / CI 入口
```

两类入口最终都必须进入 `pages-gateway`，创建 `PublishingJob`，并复用同一套 GitHub Enterprise issue / PR、executor、Review Agent comment 监听、deploy、audit 和通知流程。

当前第一优先级是 Slack 到 Preview 自动闭环，详见 [first-priority-preview-loop.md](./first-priority-preview-loop.md)。

第一优先级主线是：

```text
Slack 发消息
  ↓
创建 GitHub Enterprise issue
  ↓
固定 ProjectIndexSnapshot / agent context
  ↓
coding agent 自动编码
  ↓
自动创建 PR
  ↓
实时监听 GitHub Review Agent 在 PR 里的 comment
  ↓
按 comment 驱动 agent 修复或等待人工处理
  ↓
site-check / pages-site-policy / Review Agent gate 通过后自动生成 Preview
  ↓
回通 Slack
```

这条 Slack-first 主链路的更细合同见 [slack-to-pr-review-agent-flow.md](./slack-to-pr-review-agent-flow.md)。

前期默认使用本地 K8s 跑常驻控制面，但不使用 K8s Job executor。coding agent、builder、preview 和受控 PR 创建可以先跑在 GitHub Actions runner 中；后续需要更强隔离、资源控制和自建运行环境时，再把 executor adapter 换成 K8s Job。详见 [local-k8s-control-plane.md](./local-k8s-control-plane.md) 和 [github-actions-first-runtime.md](./github-actions-first-runtime.md)。

## Slack 主链路

```text
用户 / 受信 SlackBot
  ↓
Slack Platform
  ↓
POST /integrations/slack/events | commands | interactions
  ↓
pages-gateway
  ↓
apps/slack-agent
  ↓
pages-gateway
  ↓
pages-worker
  ↓
GitHub Actions runner / K8s job executor
  ↓
GitHub Enterprise PR
  ↓
GitHub Review Agent comments
  ↓
review-monitor-worker
  ↓
Cloudflare Preview Resource Pool
  ↓
Slack / issue / PR 回写
```

### 1. Slack 事件进入 gateway

Slack Platform 调用 `pages-gateway`：

```text
POST /integrations/slack/events
POST /integrations/slack/commands
POST /integrations/slack/interactions
```

gateway 必须先做：

- 校验 Slack signature。
- 校验 timestamp 防重放。
- 生成非空 `dedupe_key`。
- 写入 `SlackEvent`，唯一约束为 `(team_id, dedupe_key)`。
- 重复 Slack retry 只返回已有接收结果，不重复创建 job。

### 2. 解析身份和 SlackBot 来源

如果消息来自真人：

```text
Slack user_id
  ↓
ExternalIdentityBinding(provider=slack)
  ↓
User / Employee
```

如果消息来自另一个 SlackBot：

- 先写入 `SlackMessageBatch.source_type=bot`。
- 记录 `source_bot_user_id`、channel、thread、原文和摘要。
- 没有 `TrustedSlackBotPolicy` 或真人确认时，只能作为需求证据，不能创建 `PublishingJob`。
- 如果配置了 `TrustedSlackBotPolicy(mode=service_account)`，bot 映射到 `ServiceAccount`，再走 service account 权限判断。

### 3. Slack Agent 汇总 Slack thread

`apps/slack-agent` 加载 `SlackSession` / `SessionMemory` / `IssueLink`，拉取 thread / channel 上下文，生成结构化摘要：

```text
intent
employee_slug
site_slug
title
summary
assets
approval_mode
source_messages
```

Slack Agent 不直接创建 PR、不合并、不部署。它把摘要、意图和续接关系交回 gateway。

### 4. 创建 PublishingJob

gateway 校验 actor 权限：

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
AuditLog / JobEvent
```

MVP 默认：

```text
approvalMode = manual-required
```

## GitHub Enterprise 发布链路

### 5. 创建 issue

pages-worker 通过 GitHub App installation token 在 GitHub Enterprise 的 `pages-manager` repo 创建 issue。

MVP 代码形态：

```text
apps/gateway
  创建 PublishingJob
  ↓ PAGES_WORKER_START_URL
apps/worker
  ↓ packages/git-client
GitHub Enterprise
  create issue
  workflow_dispatch project-index.yml
```

`apps/worker` 使用平台 GitHub App installation token。Slack 用户即使没有 `pages-manager` repo 权限，也可以通过 Slack 入口创建发布任务；GitHub 写操作来自平台 App，而不是 Slack 用户个人身份。

issue 必须包含：

- `PublishingJob` id。
- Slack 来源 thread 链接或 API 来源。
- 结构化需求摘要。
- 目标 `SiteProject` / `site_slug`。
- 审计信息。

### 6. 固定项目索引

gateway 创建 agent stage 前，先为本次 job 选择或创建 `ProjectIndexSnapshot`。索引快照固定 repo base SHA、目标站点目录、模板、`page-kit` schema、相关 issue / PR / ReviewAgentComment 和构建报告，供 agent 使用。

Actions-first MVP 中，issue 创建后由 `apps/worker` 触发：

```text
project-index.yml
  inputs:
    publishingJobId
    siteProjectId
    allowedPath
    issueNumber
    callbackUrl
```

`project-index.yml` 完成后 callback gateway，gateway 把 job 推进到 `generating_page`，再通知 `apps/worker` 触发 `pages-agent.yml`。

### 7. Coding agent 自动编码

MVP 的默认执行器是 GitHub Actions：

```text
pages-gateway
  ↓
apps/worker
  ↓
workflow_dispatch / repository_dispatch
  ↓
.github/workflows/pages-agent.yml
  ↓
GitHub Actions runner
```

如果后续切到 K8s executor，同一个 stage 可以改为：

```text
namespace: pages-jobs
job: job-<jobId>-coding-agent
```

关键边界不变：gateway 和 worker 只调度，不在常驻服务进程里执行编码任务。coding agent 前期跑在 GitHub Actions runner，后期可跑在 `coding-agent-runner` 一次性 K8s Job container。

coding agent 的输入：

- issue 内容和 Slack 摘要。
- 目标 `SiteProject`。
- 允许修改的 repo path。
- 当前模板和站点源码。
- 上一轮 Review Agent comments，如果是修复轮次。

coding agent 只能产出：

```text
workspace/generated/
workspace/patches/site.patch
workspace/report.json
```

coding agent 不能持有 repo write token、Slack bot token、Cloudflare token 或 auto-merge token。它只负责生成代码和 patch，不直接 push。

当前 Actions-first MVP 的 `pages-agent.yml` 把 coding-agent、预校验和 controlled-committer 放在同一个 workflow 内，但边界仍按阶段执行：

```text
generate candidate files
  ↓
validate generated diff only touches allowedPath
  ↓
controlled commit to sites/job-<jobId>-<employee>-<site>
  ↓
create or reuse PR
  ↓
callback gateway with stageResult=pr_created
```

这个 workflow 可以使用 GitHub write token 创建受控 branch / PR，但必须在 diff validator 之后才 push。它仍然不能持有 Slack bot token、Cloudflare production token 或 auto-merge token。

### 8. 候选代码编译

coding agent 生成 patch 后，必须先跑候选代码编译。MVP 可直接在 `pages-agent.yml` workflow 内完成：

```text
GitHub Actions runner
  ↓
install dependencies
  ↓
lint / test / build
  ↓
write build report
```

后续使用 K8s executor 时，可以改成 K8s builder / site-check job 在 job workspace 中跑预构建：

```text
namespace: pages-jobs
job: job-<jobId>-builder
```

builder / workflow 负责：

- install dependencies。
- lint / test / build。
- `site.json` schema 校验。
- 生成 build report / preview artifact。

builder / workflow job 不持有 Slack bot token、Cloudflare production token 或 auto-merge token。它的结果只是提交 PR 前的快速反馈；PR 创建后仍必须跑 GitHub Actions required checks。

### 9. Controlled committer 提交 PR

controlled-committer 先校验 patch：

- 只修改 `sites/<employee-slug>/<site-slug>/`。
- 不触碰 `.github/**`、`apps/**`、`packages/**`、`templates/**`、`k8s/**`。
- `site.json` schema 通过。
- 文件大小和禁止目录通过。
- secret 扫描通过。

校验通过后，controlled-committer 短暂获取 GitHub App installation token：

```text
create branch
create commit
create PR
```

注意：GitHub App `Contents: write` 是 repo 级能力，不是 path-scoped token。路径隔离必须由 diff validator、受控 branch prefix、Rulesets 和 required checks 兜底。

### 9. CI / Review

GitHub Enterprise Rulesets 要求：

```text
site-check
pages-site-policy
```

`pages-site-policy` 检查：

- PR 绑定 `PublishingJob`。
- PR 绑定 `SiteProject`。
- PR 只修改一个目标站点目录。
- requested actor 有站点管理权限。
- 没有平台、模板、K8s、Actions 改动。

确定性 review 检查：

- path allowlist。
- secret 扫描。
- `site.json` schema。
- 文件大小。
- 构建通过。
- 链接和截图检查。

### 10. 实时监听 GitHub Review Agent comment

PR 创建后，平台必须监听 GitHub Review Agent 在 PR 中提交的 comment。这里的 Review Agent 是 GitHub Enterprise PR 里的外部 reviewer / bot / app，不是 `pages-manager` 自己随便生成的一段本地检查结果。

gateway 接收这些 webhook：

```text
pull_request_review
pull_request_review_comment
issue_comment
check_run / check_suite
```

`review-monitor-worker` 负责：

- 识别 comment 是否来自允许列表中的 GitHub Review Agent。
- 将 review comment、inline comment、summary comment 和 check output 归一化。
- 写入 `ReviewAgentComment`。
- 更新 `ReviewRun`。
- 判断 comment 是否 actionable。
- 把新增 / 更新的 comment 回写到 Slack thread。
- 如果允许自动修复，创建下一轮 `AgentRun(type=fix)`。

必须监听的 comment 类型：

| 来源 | 事件 | 说明 |
| --- | --- | --- |
| PR review summary | `pull_request_review` | approve / changes requested / commented |
| inline review comment | `pull_request_review_comment` | 指向文件、行号、diff hunk 的 comment |
| PR conversation comment | `issue_comment` | Review Agent 可能把总结写在 PR conversation |
| Review Agent check | `check_run` / `check_suite` | 如果 Review Agent 以 check 形式输出结果 |

Review Agent comment 的处理规则：

- 只信任配置允许的 GitHub App / bot login / check name。
- 用 GitHub `comment_id` / `node_id` 做幂等，重复 webhook 不能重复创建反馈项。
- edited / deleted / dismissed comment 必须更新状态，不能只追加。
- 不能把所有 comment 都当阻塞项，必须区分 `blocking | suggestion | note | unknown`。
- 阻塞项进入 `changes_requested`；非阻塞建议可以记录但不阻塞 preview gate。
- `unknown` 不自动触发修复；如果后续开启 `trusted-auto`，有 open unknown comment 时必须等待人工确认或重新分类。

### 11. Agent 根据 Review Agent comments 修复

如果 Review Agent comment 需要修复，gateway 创建新的 agent attempt：

```text
AgentRun(type=fix, round=N)
  ↓
pages-agent workflow 或 coding-agent-runner 读取 ReviewAgentComment
  ↓
生成修复 patch
  ↓
controlled-committer 校验 path
  ↓
push 到同一个 PR branch
  ↓
等待 Review Agent 新一轮 comment
```

规则：

- 每一轮 fix 必须生成新的 `JobStageAttempt` 和 `AgentRun`。
- 修复仍然只能改目标 `sites/<employee>/<site>/`。
- 必须设置 `max_fix_rounds`，避免 comment -> fix -> comment 无限循环。
- 新 commit push 后，旧 comment 保留历史，新 comment 重新进入监控。
- Slack thread 要实时显示新增 comment、开始修复、修复完成、等待新 review。

第一优先级是 `site-check` / `pages-site-policy` 和 Review Agent gate 都通过后自动进入 Preview。production 人工 approve + merge 是后续阶段；`trusted-auto` 是更后续能力，开启前不能对 `sites/**` 配 required CODEOWNERS。

## Production Merge 到 Deploy

### 11. GitHub webhook 进入 gateway

production 阶段 PR merge 后，GitHub Enterprise 调用：

```text
POST /integrations/github/webhook
```

gateway 必须：

- 校验 webhook signature。
- 校验 `repository.full_name` allowlist。
- 校验 event allowlist。
- 写入 `GitHubWebhookDelivery`。
- 使用 `(repo_full_name, delivery_id)` 保证幂等。

只信任已记录的 PR merge：

```text
repo_full_name
pr_number
merge_commit_sha
site_project_id
```

### 12. 创建 deploy task

gateway 创建 production deploy stage。第一优先级可以先不实现 production deploy；Preview 闭环跑通后，再触发受控 GitHub Actions production deploy workflow，后续也可以换成 K8s deployer job。

production 构建只能来自：

```text
merge_commit_sha
```

不能从 floating branch 构建。

### 13. Cloudflare 发布

deployer 使用平台统一 Cloudflare 凭据：

```text
build production artifact
upload immutable assets to R2 / assets bucket
write deploy manifest
update platform KV runtime snapshot
write DeployRecord
update SiteProject.current_deploy_id
```

`DeployRecord` 必须记录：

```text
repo_full_name
pr_number
merge_commit_sha
github_delivery_id
site_project_id
environment
deploy_id
resource_pool_id
```

幂等约束：

```text
unique(site_project_id, environment, merge_commit_sha)
```

## 回写和审计

状态变化统一写：

```text
JobEvent / AuditLog
```

通知统一由 `slack-notifier` 和 GitHub issue / PR comment 完成：

```text
PublishingJob 状态变化
  ↓
JobEvent
  ↓
Slack thread update / reply
  ↓
issue / PR comment
```

executor 任务不直接发 Slack 消息。

## Internal API 链路

API 入口：

```text
POST /api/publishing-jobs
```

必须带：

```text
Idempotency-Key
```

或 request body：

```json
{
  "source": "api",
  "idempotencyKey": "ci-build-20260611-001",
  "intent": "update_site",
  "employeeSlug": "zhangsan",
  "siteSlug": "q2-report",
  "brief": "Update Q2 report"
}
```

gateway 使用解析后的 actor 做唯一约束：

```text
unique(source, requested_by_type, requested_by_id, idempotency_key)
```

API 创建出来的 job 从 `PublishingJob` 开始复用同一条链路：

```text
PublishingJob
  ↓
issue
  ↓
patch
  ↓
PR
  ↓
review
  ↓
merge
  ↓
deploy
  ↓
audit / notification
```

API 不能绕过 issue、PR、review、deploy 或审计。

## 失败和重试

任何阶段失败都必须：

- 写 `JobStage.status=failed`。
- 写 `PublishingJob.error_message`。
- 写 `AuditLog / JobEvent`。
- 回写 Slack / issue / PR。

retry 必须新建 `JobStageAttempt`：

```text
attempt_id = new
attempt_no = previous + 1
```

旧 attempt 的迟到 callback 只能写审计，不能覆盖当前状态。
