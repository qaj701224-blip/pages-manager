# GitHub Enterprise

## 决策

`pages-manager` 仓库位于公司 GitHub Enterprise 组织 / 团队空间内。

当前 Git 闭环明确使用 GitHub Enterprise，不再把 GitHub / GitLab 做成同等候选项。后续如果要支持 GitLab 或其他 Git provider，可以在 `packages/git-client` 内增加适配层，但当前权限、Webhook、CODEOWNERS、Rulesets 和 Actions Environments 都按 GitHub Enterprise 设计。

## 平台身份

平台自动化使用 GitHub App，不使用个人 PAT。

原因：

- GitHub App installation token 是短期 token，适合 worker / job 使用。
- 权限可以按 repository 和 API 能力拆分。
- 审计能看到自动化来自平台 App，而不是某个员工个人账号。
- 员工离职或权限变化不会影响平台自动化身份。

建议配置：

```text
GITHUB_ENTERPRISE_BASE_URL
GITHUB_ENTERPRISE_API_BASE_URL
GITHUB_APP_ID
GITHUB_APP_INSTALLATION_ID
GITHUB_APP_PRIVATE_KEY_SECRET_REF
GITHUB_WEBHOOK_SECRET_REF
GITHUB_ORG
GITHUB_REPO
GITHUB_REVIEW_AGENT_ALLOWLIST
```

如果公司使用 GitHub Enterprise Cloud，`GITHUB_ENTERPRISE_BASE_URL` 可以是 `https://github.com`；如果使用自建 GitHub Enterprise Server，则配置为公司内部 GitHub 域名。业务代码不要写死 GitHub host。

`GITHUB_REVIEW_AGENT_ALLOWLIST` 用于声明哪些 GitHub App / bot login / check name 可以被当作 Review Agent。未命中 allowlist 的 comment 只能作为普通人工评论或忽略，不能触发自动修复。

## GitHub App 权限

当前建议权限：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Metadata | read | 读取 repo 基础信息 |
| Contents | read/write | controlled-committer 创建受控 branch / commit |
| Issues | read/write | 创建 issue、写入进度评论 |
| Pull requests | read/write | 创建 PR、写 review comment、读取 review 状态 |
| Checks | read | 读取 required checks / CI 状态 |
| Actions | read | 读取 workflow run 和 job 状态 |

权限红线：

- GitHub App 不直接持有 Cloudflare token。
- GitHub App 不直接持有 Slack bot token。
- 普通 coding-agent / builder / site-check job 不拿 Contents write token。
- controlled-committer 只在校验 patch 后拿短期 installation token 写受控 branch。
- auto-merge token 和 branch 写 token 逻辑上分离；当前默认 `manual-required`，不默认启用自动合并。

需要特别注意：GitHub App installation token 的 `Contents: write` 是 repository 级能力，不是 path-scoped token。路径隔离不能依赖 GitHub token 本身，只能依赖平台自己的 diff validator、受控 branch prefix、required checks、Rulesets 和 workflow secret 分层。也就是说，controlled-committer 在拿到 token 前必须已经完成 patch 校验；拿到 token 后也只能执行创建受控 branch / commit / PR 这一段短动作。

## 本地 gh CLI

本地开发可以使用 `gh` CLI 做观察和排障，例如确认 repo 访问、创建一次性测试 issue、手动触发 workflow、查看 PR 和 workflow run。

但 `gh` CLI 只属于开发者本地调试工具，不是平台生产身份，也不是本地完整链路的状态来源。正式链路仍然必须使用 GitHub App installation token、K8s gateway / worker dispatch、workflow callback 和 GitHub webhook；Review Agent comment 和 check 状态不能靠本机 `gh` 轮询推进。

本地验证细节见 [github-cli-local-dev.md](./github-cli-local-dev.md)。

## GitHub Team

建议至少建立这些 GitHub team：

```text
@pages-platform-admins
@pages-site-reviewers
@pages-template-reviewers
@pages-infra-admins
```

职责：

| Team | 职责 |
| --- | --- |
| `@pages-platform-admins` | `apps/**`、`packages/**`、平台状态机、gateway、worker |
| `@pages-site-reviewers` | `sites/**` 的人工兜底 review |
| `@pages-template-reviewers` | `templates/**` 模板和视觉规范 |
| `@pages-infra-admins` | `.github/**`、`k8s/**`、Actions、Rulesets、secret 配置 |

员工或站点自定义管理权限不要只依赖 CODEOWNERS。GitHub CODEOWNERS 不能动态展开每个员工的授权关系，平台仍然必须从 DB 的 `SiteAdminGrant` / owner scope 校验 site owner、maintainer、reviewer。

## Branch Protection / Rulesets

必须保护默认分支和发布分支：

```text
main / master
staging
production
```

建议规则：

- 禁止直接 push 到受保护分支。
- 合并必须通过 PR。
- 必须通过 required checks。
- `.github/**`、`k8s/**`、`apps/**`、`packages/**`、`templates/**` 需要 CODEOWNERS review。
- `sites/**` 的 PR 即使是自动生成，也必须通过 path allowlist、权限校验、CI 和 review。
- `sites/**` 不建议配置 required CODEOWNERS；否则未来 `trusted-auto` 会被 GitHub 人工 review 要求卡住。
- `site-only` PR 可以进入 `trusted-auto` 候选，但必须通过 `pages-site-policy` required check，并由 gateway 再做 DB 权限判断。
- 任何触碰平台、模板、K8s、Actions 的 PR 都不能自动合并。

建议把 Rulesets 和 CODEOWNERS 一起使用：

```text
GitHub Rulesets
  负责分支、required checks、禁止绕过。
  对平台 / 模板 / 基础设施目录要求 CODEOWNERS。
  对 sites/** 要求 pages-site-policy check。

CODEOWNERS
  负责平台目录、模板目录、基础设施目录的人工 review 要求

pages-gateway
  负责员工 / 站点动态权限、site-only 判断和 PublishingJob 绑定
```

## GitHub Actions / Environments

大仓里最需要避免的是站点内容 PR 触发高权限 workflow。

建议拆分：

| Workflow / Environment | Secret | 说明 |
| --- | --- | --- |
| `site-check` | 无敏感 secret | 只跑 `sites/**` schema、build、link、screenshot、content safety |
| `template-check` | 无生产 secret | 测模板和示例站点 |
| `platform-check` | mock / test secret | 跑 gateway、worker、packages 测试 |
| `infra-check` | 无生产 secret | lint `.github/**`、`k8s/**`，dry-run only |
| `staging` environment | staging secret，人工或平台受控触发 | 预发验证 |
| `production` environment | Cloudflare deploy secret，gateway/deployer 或人工审批 | 生产发布 |

规则：

- `site-check` 不能读取 Slack bot token、Cloudflare token、GitHub App private key、auto-merge token。
- production deploy 不能由普通 push / PR 自动触发。
- 生产 secret 只进入受控 deployer workflow/job 或需要人工审批的 GitHub Environment。
- `.github/**` 的任何变更必须由 `@pages-infra-admins` review。
- site PR workflow 禁止使用带生产 secret 的 `pull_request_target` 模式；如果必须使用 `pull_request_target` 做标签或评论，也只能运行只读逻辑，不能 checkout 或执行 PR 里的代码。

## Webhook

GitHub Enterprise webhook 统一打到：

```text
POST /integrations/github/webhook
```

gateway 必须做：

- 校验 webhook signature。
- 校验 delivery id 幂等，重复投递不重复创建 deploy / review / job。
- 校验 `repository.full_name` 在允许列表内。
- 校验 event type 在允许列表内。
- 只接受来自配置中 `GITHUB_ORG` / `GITHUB_REPO` 的事件。

建议落库：

```text
GitHubWebhookDelivery
  delivery_id
  event_type
  action
  repo_full_name
  payload_sha256
  status
  publishing_job_id
  created_at
  processed_at

unique(repo_full_name, delivery_id)
```

当前需要处理：

| Event | 用途 |
| --- | --- |
| `issues` | 同步 issue 状态和评论 |
| `pull_request` | 识别 PR 创建、更新、merge |
| `pull_request_review` | 读取人工 approve / changes requested |
| `pull_request_review_comment` | 实时读取 GitHub Review Agent inline comments |
| `check_suite` / `check_run` | 读取 CI 结果 |
| `issue_comment` | 读取人工指令、状态询问或 Review Agent summary comment |

Review Agent comment 监听规则：

- 配置允许的 Review Agent 身份：GitHub App id / slug、bot login、check run name。
- 只处理 `pages-manager` repo 中目标 PR 的 comment。
- 使用 `repo_full_name + comment_node_id` 或 `repo_full_name + comment_id` 做唯一约束。
- edited / deleted / dismissed 事件必须更新已有记录。
- comment 先入库为 `ReviewAgentComment`，再由 `review-monitor-worker` 分类为 `blocking | suggestion | note | unknown`。
- blocking comment 才能推动 `PublishingJob.status=changes_requested` 或 `fixing`。
- unknown comment 不自动触发修复；如果后续开启 `trusted-auto`，必须先人工确认或重新分类后才能放行。

部署触发只信任已记录的 PR merge 事件：

```text
repo_full_name + pr_number + merge_commit_sha + site_project_id
```

production deploy 不能从 floating branch 构建，必须从已记录的 `merge_commit_sha` 构建。

`DeployRecord` 也必须保存 `repo_full_name`、`pr_number`、`merge_commit_sha` 和触发部署的 `github_delivery_id`。production 幂等建议使用：

```text
unique(site_project_id, environment, merge_commit_sha)
```

## Controlled Committer

controlled-committer 是唯一允许为站点生成内容写 Git branch 的任务角色。

它的流程：

```text
coding agent 输出 site.patch
  ↓
controlled-committer 校验 patch
  ↓
确认只修改 sites/<employee-slug>/<site-slug>/
  ↓
用 GitHub App installation token 创建 branch / commit
  ↓
创建 PR
```

controlled-committer 禁止持有：

- Slack bot token
- Cloudflare token
- production deploy secret
- auto-merge token

它可以持有：

- GitHub App installation token
- job callback nonce
- 目标 repo read/write 到受控 branch 的权限

如果 patch 触碰 `.github/**`、`apps/**`、`packages/**`、`templates/**`、`k8s/**` 或其他非目标路径，controlled-committer 必须直接失败，不创建 PR。

## Worker Dispatch

GitHub issue 和 workflow dispatch 不跑在 Slack connector，也不跑在 gateway 主流程里，而是由 K8s 中的 `apps/worker` 执行：

```text
K8s apps/gateway
  创建 PublishingJob
  ↓
K8s apps/worker
  ensure GitHub issue
  dispatch project-index.yml
  等 index_ready callback 后 dispatch pages-agent.yml
```

`packages/git-client` 封装 GitHub Enterprise API：

- 查找包含 `PublishingJob: <jobId>` marker 的 issue，保证幂等。
- 创建 issue。
- dispatch `project-index.yml`。
- dispatch `pages-agent.yml`。

worker 使用平台 GitHub App installation token。Slack 用户不需要拥有 `pages-manager` repo 权限；权限判断由 gateway 的内部身份、站点管理授权和审计完成。

本地先跑通 Slack 到 issue 时，可以把 worker 配成：

```text
PAGES_EXECUTOR_MODE=issue_only
PAGES_ISSUE_MODE=smoke_single
PAGES_SMOKE_ISSUE_SCOPE=local-slack-smoke
```

`PAGES_EXECUTOR_MODE=issue_only` 只创建 / 复用 GitHub issue 并 callback gateway 到 `issue_created`，不 dispatch `project-index.yml`。这是因为 GitHub workflow dispatch 对 workflow 所在分支有要求；在 workflow 尚未合入可调度分支前，`issue_only` 可以先验证 Slack 到 GitHub issue 的真实链路。

自动生成站点 PR 时，`workflowRef` 和 `baseRef` 要分开理解：

- `PAGES_WORKFLOW_REF`：从哪个分支运行 workflow，当前本地 smoke 使用已合入新版 workflow 合同的 `staging`。
- `PAGES_BASE_REF` / `PAGES_PR_BASE_REF`：Project Index checkout、Pages Agent checkout 和自动 PR 的 base，当前默认 `staging`。
- `PAGES_PREVIEW_HOSTNAME_PATTERN`：可选的 Preview hostname 模板，例如 `pr-{prNumber}-{employeeSlug}-{siteSlug}-staging.workers.xd.team`；不配置时 `pages-preview.yml` 会生成 placeholder preview URL。

也就是说，当前第一优先级是让 Slack 自动化先合入 / 部署到 `staging` 预发链路，而不是直接进入 `master` / production。

`PAGES_ISSUE_MODE=smoke_single` 用于本地测试防止 issue 污染。worker 会创建或复用一个带有 `PagesSmokeIssue: <scope>` marker 的 smoke issue，后续 Slack 测试消息只追加 issue comment。正式流程使用默认 `per_job`，每个发布需求创建独立 issue。
