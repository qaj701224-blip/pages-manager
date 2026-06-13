# MVP Scope

## MVP 原则

MVP 的目标是先跑起来，但不能把未来一定会变成安全事故或数据事故的边界省掉。

可以简化：

- UI 可以先很薄。
- worker 可以先合并成一个 `apps/worker`。
- 常驻控制面先跑本地 K8s 的 `pages-system` namespace；详见 [local-k8s-control-plane.md](./local-k8s-control-plane.md)。
- 一次性执行层可以先用 GitHub Actions runner，不一开始做 K8s Job executor；详见 [github-actions-first-runtime.md](./github-actions-first-runtime.md)。
- `pages-jobs` 和每任务 namespace 后置。
- Review Agent comment 处理可以先做 allowlist、幂等、blocking 分类和一轮修复。
- Cloudflare 可以先兼容现有 `/deploy` 能力。

不能省：

- DB 真相源。
- `PublishingJob` 状态机。
- Slack 作为 MVP 主入口。
- Slack 签名校验和事件幂等。
- Slack actor 到内部用户的绑定。
- coding agent / committer 权限边界。
- path allowlist。
- issue / PR / deploy 审计。
- project index snapshot 绑定到 job，保证 agent 使用的上下文可追溯。
- management 权限和站点访问权限分离。
- preview deploy 必须绑定 PR head SHA；production deploy 后续必须绑定 merge commit。
- 发布结果必须回写 Slack thread。

## MVP 主链路

MVP 必须结合 Slack。同时，内部 API 也是正式入口，面向高级用户、管理员、CI、补偿和批量操作。CLI 暂不考虑。

当前第一优先级是 Slack 到 Preview 自动闭环，详见 [first-priority-preview-loop.md](./first-priority-preview-loop.md)。

两类入口都必须进入 `pages-gateway`，最终都创建 `PublishingJob`，并复用同一套 issue、coding agent、PR、GitHub Review Agent comment 监听、preview deploy、audit 和权限判断。API 不能成为绕过身份、绕过 issue/PR、绕过 review comment 处理或直接部署的后门。

开工前必须以这些合同为准：

- [db-schema-v0.md](./db-schema-v0.md)
- [local-k8s-control-plane.md](./local-k8s-control-plane.md)
- [actions-workflow-contract.md](./actions-workflow-contract.md)
- [github-review-agent-contract.md](./github-review-agent-contract.md)
- [site-check.md](./site-check.md)
- [legacy-deploy-wrapper.md](./legacy-deploy-wrapper.md)
- [site-lifecycle-and-naming.md](./site-lifecycle-and-naming.md)

Slack 到 PR 再到 GitHub Review Agent comment 监听的详细流程见 [slack-to-pr-review-agent-flow.md](./slack-to-pr-review-agent-flow.md)。

目标链路：

```text
Slack message / slash command / app mention
  ↓
pages-gateway 校验 Slack signature + event 幂等
  ↓
写 SlackEvent + SlackMessageBatch
  ↓
apps/slack-agent 加载 session / memory / issue link 并总结 thread
  ↓
服务器常驻 Slack Agent 调用配置的模型供应商进行多轮需求理解
  ↓
gateway 校验 Slack actor 的内部身份和站点管理权限
  ↓
创建 PublishingJob
  ↓
创建 issue
  ↓
固定 ProjectIndexSnapshot / 加载 agent context
  ↓
coding agent 自动编码并生成 site patch
  ↓
GitHub Actions runner 或 builder workflow/job 编译候选 patch
  ↓
controlled-committer 校验并创建 branch / PR
  ↓
监听 GitHub Review Agent comments
  ↓
blocking comment 触发 agent 修复
  ↓
site-check / pages-site-policy / GitHub Review Agent gate
  ↓
自动进入 Preview
  ↓
写 Preview DeployRecord
  ↓
回写 issue / PR / Slack thread
```

## Internal API 的定位

MVP 需要提供 internal API：

- 高级用户创建 `PublishingJob`。
- 查询 job 状态。
- 查询 job 进度和事件。
- 管理员重试失败阶段。
- 回放 SlackEvent。

API 是 `pages-gateway` 的正式入口。详细设计见 [api-entry.md](./api-entry.md)。

## MVP 必须有

### 1. Monorepo 边界

必须建立这些目录或等价目录：

```text
apps/gateway
apps/slack-connector
apps/slack-agent
apps/worker
packages/workflow-core
packages/git-client
packages/page-kit
packages/site-check
packages/deploy-core
packages/access-control
sites/<employee-slug>/<site-slug>
templates
.github/workflows
```

MVP 可以不做完整 `apps/frontend`，但至少要有 API 查询 job 状态。`k8s/base/pages-system` 是本地 K8s 常驻控制面必需目录；`apps/job-runner`、`k8s/jobs` 或 `k8s/pages-jobs` 是 K8s Job executor 的后续目录，前期 Actions-first 跑通闭环时可以先不实现。

`k8s/` 对 MVP 分两层理解：

- `k8s/base/pages-system`：MVP 要做，用来跑 gateway、slack-connector、slack-agent、worker、MySQL、Redis 等常驻控制面。
- `k8s/jobs` 或 `pages-jobs`：后续再做，用来跑 coding-agent、builder、site-check、controlled-committer、deployer 这类一次性 K8s Job。

### 2. 最小数据模型

必须先落这些表或等价模型：

| 模型 | MVP 用途 |
| --- | --- |
| `User` | 控制台 / Slack / Git actor 的内部身份 |
| `Employee` | 员工归属主体 |
| `ExternalIdentityBinding` | Slack/GitHub Enterprise user 到内部用户的绑定 |
| `ServiceAccount` | CI / 内部系统 / 平台集成的 API 调用主体 |
| `ApiToken` | Personal token / service token 的 hash、scope 和授权范围 |
| `PolicyVersion` / `PromptVersion` | 公司规则、Agent prompt 的版本和 hash |
| `SiteOwnerScope` | personal/team 归属域 |
| `SiteProject` | 一个具体网站 |
| `SiteAccessPolicy` | 网站内容访问策略 |
| `SiteAdminGrant` | 管理权限 |
| `PublishingJob` | 一次发布请求 |
| `JobStage` | 阶段状态 |
| `JobStageAttempt` | retry、callback、防迟到覆盖 |
| `AgentRun` | Slack Agent 分类/摘要、coding agent 初次编码和按 review comment 修复的执行记录 |
| `ProjectIndexSnapshot` | 本次 job 使用的项目索引快照 |
| `ProjectIndexItem` | 索引快照内的文件、模板、站点和 review 上下文条目 |
| `SlackEvent` | Slack event / command 幂等 |
| `SlackMessageBatch` | Slack 原文、thread、摘要 |
| `SlackSession` | 按 Slack user 隔离的常驻会话状态 |
| `SessionMemory` | Slack 会话摘要、需求和 preview 反馈 |
| `IssueLink` | Slack session、job、issue、PR、preview 的关联 |
| `TrustedSlackBotPolicy` | SlackBot 来源和代发策略 |
| `SiteCheckRun` | PR head SHA 上的 site-check / pages-site-policy 结果 |
| `ReviewRun` | review 结果 |
| `ReviewAgentComment` | GitHub Review Agent comment 归一化记录 |
| `GitHubWebhookDelivery` | GitHub Enterprise webhook 幂等 |
| `DeployRecord` | 部署记录 |
| `CloudflareResourcePool` | 资源池抽象 |
| `AuditLog` / `JobEvent` | 审计和进度事件 |

可以先字段精简，但不能没有这些边界。

### 3. 状态机

MVP 使用和完整设计一致的状态枚举。实现时可以先不启用所有自动化能力，但不要另起一套缩减状态机。

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
previewing
preview_deployed
approved
merging
merged
deploying
deployed
failed
cancelled
```

规则：

- 只有 gateway 能最终写 `PublishingJob.status`。
- worker / executor 只能 callback gateway。
- retry 必须新建 `JobStageAttempt`。
- 旧 attempt 的迟到 callback 不能覆盖当前状态。
- `summarizing`、`indexing`、`branch_committed`、`merging` 等阶段即使 MVP 里实现较轻，也必须可观测、可失败、可重试。

### 4. Slack 入口

Slack App 权限可以先拉满，MVP 不被 scope 申请卡住。
Actions-first MVP 可以先由 `pages-gateway` 内置 Slack 通知 adapter 回写进度；长期仍要拆成独立 `slack-notifier`。

但必须保留这些安全边界：

- 只维护一个平台 Slack bot。
- Socket Mode MVP 使用仓库内长期组件 `apps/slack-connector`，不使用临时本地监听脚本。
- HTTP Events 模式下 `pages-gateway` 校验 Slack signature；Socket Mode 模式下 `apps/slack-connector` 消费 Slack envelope，gateway 校验 connector shared secret。
- `pages-gateway` 用非空 `dedupe_key` 做幂等，避免 Slack 重投重复创建任务。
- Slack user 必须通过 `ExternalIdentityBinding` 解析成内部 `User` / `Employee`。
- Slack Agent 按 `(team_id, slack_user_id)` 做用户隔离；同一个用户可以有多个 `SlackSession`，同一个 thread 里多个人同时对话时，每个人只进入自己名下的 session。
- Thread / channel 只作为消息 surface、上下文来源和回写位置，不能作为共享 session 主体。
- Slack 回复和进度回写必须 @ 对应 Slack user，不能让多人 thread 中的状态消息没有明确归属。
- SlackBot 消息只能作为需求来源；不能自动成为 `requested_by`。
- SlackBot 没有 `TrustedSlackBotPolicy` 或真人确认时，不能创建 `PublishingJob`。
- Slack token 只进入 `pages-gateway`、`apps/slack-connector`、`apps/slack-agent`、`slack-notifier`，不进入 coding-agent/builder/site-check/deployer workflow/job。
- Slack Agent 模型 API key 只进入 `apps/slack-agent` 常驻服务，不进入 GitHub Actions executor、coding-agent、site-check、deployer 或员工页面。

MVP 可以用管理员预配置绑定：

```text
slack_user_id -> employee_id
```

后续再做自助绑定、OAuth install 或 SSO 自动绑定。

### 5. Git Issue / PR

MVP 明确使用 GitHub Enterprise，不再在 GitHub / GitLab 之间二选一。

MVP 必须做到：

- 创建 issue。
- 创建 branch。
- 创建 PR。
- PR 关联 `PublishingJob`。
- PR 默认只修改一个 `sites/<employee>/<site>/`。
- path allowlist 检查失败时不创建 PR。
- 平台目录变更不能自动合并。
- 使用 GitHub App installation token 创建受控 branch / PR。
- 配置 GitHub Enterprise webhook：signature、delivery id 幂等、repo allowlist、event allowlist。
- 配置 GitHub Enterprise Rulesets、required checks、CODEOWNERS 和 Actions environments。
- `sites/**` 的自动化门禁使用 `pages-site-policy` required check，不依赖 required CODEOWNERS。

### 6. Coding Agent / Committer 分离

必须是：

```text
coding agent
  生成 workspace patch

builder / site-check workflow/job
  编译候选 patch

controlled-committer
  校验 patch
  创建 commit / branch / PR
```

coding agent 不能持有 repo push token。

builder / site-check 也不能持有 Slack bot token、Cloudflare production token 或 auto-merge token。是否持有受控 GitHub App token取决于它是否包含 controlled-committer step；如果包含，必须先完成 diff validator，且 token 只用于受控 branch / PR。

### 7. GitHub Review Agent comment 监听

MVP 必须监听 GitHub PR 中 Review Agent 提交的 comments：

- `pull_request_review`。
- `pull_request_review_comment`。
- `issue_comment`。
- `check_run` / `check_suite`。

规则：

- 只处理 allowlist 中的 GitHub Review Agent。
- comment 入库为 `ReviewAgentComment`，用 comment id / node id 幂等。
- comment 分类为 `blocking`、`suggestion`、`note`、`unknown`。
- blocking comment 进入 `changes_requested` / `fixing`，并可触发 `AgentRun(type=fix)`。
- suggestion / note 默认回写 Slack 和 issue，不阻塞 Preview gate。
- unknown 默认回写 Slack 并等待人工确认，不自动触发修复，也不得进入 `trusted-auto`。

确定性检查仍然要做：

- path allowlist。
- secret 扫描。
- `site.json` schema。
- 文件大小。
- 禁止提交构建产物。
- 构建通过。
- 站点名合法。

### 8. Deploy

MVP 可以先复用现有 Cloudflare deploy 能力，但必须包装成平台任务：

- deploy task 绑定 `site_project_id`。
- preview deploy task 绑定 `head_sha`。
- production deploy task 绑定 `merge_commit_sha`，但 production 不作为第一优先级。
- deploy task 绑定 `repo_full_name + pr_number + head_sha/merge_commit_sha + site_project_id`。
- 写 `DeployRecord`。
- preview deploy 成功后回写 issue / PR / Slack。
- production deploy 不从 floating branch 构建。

`CloudflareResourcePool` 必须先作为数据抽象存在，即使底层暂时还是兼容旧部署方式。

### 9. 权限

MVP 至少要有：

```text
owner
admin
maintainer
viewer
```

规则：

- owner/admin/maintainer 可以创建或更新站点。
- viewer 只能看状态。
- 网站内容访问走 `SiteAccessPolicy`。
- 管理界面访问走 `SiteAdminGrant` / owner scope / admin。

MVP 站点内容访问策略建议默认：

```text
company
```

也就是公司内可访问，管理界面仍然受限。

## MVP 可以简化

| 主题 | MVP 简化 |
| --- | --- |
| Frontend | 可以先用 API + 简单状态页 |
| Worker 拆分 | 先一个 `apps/worker`，内部按 task type 分发 |
| Control plane runtime | 本地 K8s `pages-system`，后续服务器沿用同一套 manifests |
| Runtime executor | 前期可以用 GitHub Actions runner；后续再换 K8s Job |
| Coding agent | 第一轮可先用 placeholder page generator，先跑通真实 Preview URL；真实 Agent 后续替换生成 patch 的执行段 |
| Project index | MVP 放在 `pages-manager` 内做独立组件 / workflow，不先拆独立 repo |
| Namespace | MVP 先做 `pages-system`；`pages-jobs` / 每 job namespace 后置 |
| Slack scope | App 权限先拉满，不在 MVP 内做最小 scope 收敛 |
| Review Agent comment 处理 | MVP 先做 allowlist、幂等、分类和一轮修复，多轮策略后续增强 |
| Production merge | 第一优先级不做 production merge，只做 Preview 自动闭环 |
| Cloudflare resource pool | 先抽象数据模型，底层兼容旧 `/deploy` |
| Team scope | 先 personal，schema 保留 team 扩展 |
| 回滚 | 先记录 DeployRecord，手动回滚，后续自动化 |

## MVP 不做

- 每个 job 独立 namespace。
- K8s Job executor。
- 完整控制台。
- 多轮 Review Agent comment 自动修复。
- 默认 production PR 自动合并。
- 把 production deploy 放进第一阶段验收。
- 每站点独立 KV namespace。
- 每员工 / 每站点 Slack bot。
- 员工自助 Cloudflare 账号/token。
- 完整大文件资产管理。
- 完整灾备自动化。

## 第一优先级成功标准

- Slack 消息能创建 `PublishingJob`。
- 高级用户能通过 API 创建 `PublishingJob`。
- service token 只能在已授权 owner scope / site project 内创建 `PublishingJob`。
- Slack thread 摘要能进入 issue。
- 系统能为 Slack actor 对应员工新建或更新一个站点目录。
- 第一轮页面内容可以是 placeholder，但必须通过同一套 issue、PR、Review Agent、preview deploy 和 Slack 回通链路。
- 系统能创建 issue 和 PR。
- 系统能实时监听 GitHub Review Agent 在 PR 中提交的 comments。
- blocking Review Agent comment 能进入 `ReviewAgentComment` 并触发 agent 修复或人工处理。
- `site-check` / `pages-site-policy` 和 Review Agent gate 都通过后能自动部署 Preview 到 Cloudflare。
- DB 能查到 job、stage、review、deploy、audit。
- 失败能定位到具体 stage，并可重试。
- 状态变化能回写 Slack thread。
- Slack 重投事件不会重复创建 issue / PR。
- SlackBot 来源消息可追溯，但不会绕过身份校验。

## 接下来要细化的清单

### P0: 开工前必须写清

这些不清楚就容易写错骨架：

| 主题 | 要产出的内容 |
| --- | --- |
| Repo 结构 | `apps/`、`packages/`、`sites/`、`templates/`、`.github/workflows/`，以及后续 `k8s/` 目录树 |
| DB schema v0 | [db-schema-v0.md](./db-schema-v0.md) 中的字段、索引、唯一约束和迁移顺序 |
| Project index | [project-indexing.md](./project-indexing.md) 中的索引范围、触发、快照绑定和 agent context bundle |
| 状态机 | `PublishingJob.status` 转移表、失败状态、retry 规则 |
| Executor callback | [actions-workflow-contract.md](./actions-workflow-contract.md) 中的 callback URL、签名、`attempt_id`、迟到 callback 行为 |
| GitHub Enterprise | GitHub App 权限、installation id、enterprise/api base URL、webhook secret、org/repo allowlist、Rulesets、Actions environments |
| API idempotency | `Idempotency-Key`、唯一约束、重复请求返回已有 job |
| Path allowlist | 哪些路径允许自动 PR 修改，哪些必须人工 review |
| Secret 分层 | gateway、worker、committer、deployer、slack-notifier 各拿什么 secret |
| Dependency baseline | Node、pnpm、MySQL、Redis、Docker base image 等版本锁定；K8s client 仅后续 executor 需要，参考 [dependency-version-baseline.md](./dependency-version-baseline.md) |

### P1: 发布闭环前必须写清

这些决定 issue / PR / deploy 闭环能不能跑：

| 主题 | 要产出的内容 |
| --- | --- |
| `site.json` schema | 必填字段、模板字段、链接、资源引用、访问策略 |
| 站点命名 | [site-lifecycle-and-naming.md](./site-lifecycle-and-naming.md) 中的 `employee_slug`、`site_slug`、`site_name`、hostname 生成和冲突处理 |
| Coding agent output | `workspace/generated/`、`workspace/patches/site.patch`、`report.json` 格式，以及 Actions artifact 名称 |
| Controlled committer | patch 校验步骤、commit message、branch 命名、PR body 模板 |
| Deterministic review | secret 扫描、文件大小、schema、构建、链接检查的失败码 |
| DeployRecord | preview/production 字段、`repo_full_name`、`pr_number`、`merge_commit_sha`、`github_delivery_id`、幂等约束 |
| Legacy deploy wrapper | [legacy-deploy-wrapper.md](./legacy-deploy-wrapper.md) 中现有 `/deploy` 如何被 gateway/deployer 调用，如何写审计 |

### P2: Slack 主入口前必须写清

这些决定 Slack 主入口能不能稳定接入。P2 仍然属于 MVP，不是 MVP 之后：

| 主题 | 要产出的内容 |
| --- | --- |
| Slack event routes | `/integrations/slack/events`、`commands`、`interactions` 请求/响应 |
| SlackEvent | 非空 `dedupe_key`、`event_id`、`trigger_id`、状态、唯一约束、重投处理 |
| Identity binding | `slack_user_id -> employee_id` 的管理员预配置流程 |
| Slack summary prompt | 如何把 thread 转成结构化 intent、站点、变更摘要 |
| SlackBot 来源 | `TrustedSlackBotPolicy`、另一个 bot 发来的消息如何记录，如何避免冒充用户 |
| Slack notifier | thread update / reply 策略、失败重试、重复消息防护 |

### P3: MVP 后增强

这些重要，但不应该卡 MVP 跑起来：

| 主题 | 要产出的内容 |
| --- | --- |
| Review Agent 高级策略 | 多轮修复、comment 聚合、置信度、人工 override 和 trusted-auto 放行规则 |
| trusted-auto | 自动合并条件、人工打断、回滚策略 |
| Cloudflare Edge resource pool | 完整 Edge Worker + KV snapshot + R2 immutable deploy |
| Preview 生命周期 | preview 域名、TTL、清理、权限 |
| 完整控制台 | 列表、状态、审批、回滚、权限管理 |
| 配额和告警 | 每员工站点数、job 并发、Slack/GitHub Enterprise/Cloudflare 失败告警 |
| 灾备 | DB 备份、KV 重建、R2 manifest 重建、repo 恢复 |
