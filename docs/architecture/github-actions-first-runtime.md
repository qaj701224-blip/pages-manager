# GitHub Actions First Runtime

## 定位

前期可以不使用 K8s Job container，而是先用 GitHub Actions 作为自动开发、构建、preview 和 PR 门禁的执行环境。常驻控制面仍然按 [local-k8s-control-plane.md](./local-k8s-control-plane.md) 跑在本地 K8s 的 `pages-system` namespace。

这不是推翻原架构，而是把执行层从：

```text
pages-gateway
  ↓
K8s Job container
```

临时替换成：

```text
pages-gateway
  ↓
GitHub Actions workflow_dispatch / repository_dispatch
  ↓
GitHub Actions runner container
```

gateway、Slack、issue、PR、Review Agent comment 监听、权限、审计仍然保留。

## 和截图中方案的对应关系

截图里的建议可以落成下面这个产品决策：

```text
独立平台项目 pages-manager
  对员工站点需求建立 issue / PR 闭环
  ↓
AI 根据 issue 和 Slack 摘要自动开发
  ↓
GitHub Actions 提供云端 runner 环境
  ↓
Greptile / GitHub Review Agent review PR
  ↓
平台读取 review comment 并驱动修复
  ↓
先生成 preview，production 不默认全自动发布
```

也就是说，前期不需要单独连本地 GitLab runner，也不需要一开始准备 `pages-jobs` namespace / PVC / Job 镜像。GitHub Actions runner 本身就是一次性云端执行环境，足够支撑 MVP 的自动开发、构建、PR 和 preview。

但这个方案不能省掉平台控制面：Slack 消息归纳、权限判断、`PublishingJob` 状态机、GitHub webhook、`ReviewAgentComment` 入库、审计和 Slack 回写仍然必须由 `pages-gateway` / worker 层负责。

## 适用场景

Actions-first executor 适合 MVP：

- 常驻控制面已经跑本地 K8s，但不想一开始实现 K8s Job executor。
- 希望快速跑通 Slack 到 issue、agent 编码、PR、review、preview 的闭环。
- 公司 GitHub Enterprise 已经可用 GitHub Actions runner。
- 编码任务主要是站点代码生成、轻量构建和 preview，不需要长时间常驻容器。
- 初期不自动发布 production，只生成 PR 和 preview。

不适合长期直接替代 K8s 的场景：

- 需要强资源隔离、长任务、复杂浏览器池、大量并发。
- 需要精细控制网络、PVC、cache、secret 注入和 runtime image。
- 需要跨多个 Git provider 或非 GitHub Enterprise 环境统一调度。
- 需要平台掌握完整的 job lifecycle、queue、lease、重试和成本控制。

## MVP 主链路

```text
Slack message
  ↓
pages-gateway 校验 Slack signature + actor 权限
  ↓
创建 PublishingJob
  ↓
创建 GitHub Enterprise issue
  ↓
project-index workflow 固定 repo / template / site context
  ↓
触发 GitHub Actions workflow_dispatch
  ↓
coding-agent workflow 在 Actions runner 中生成 patch
  ↓
workflow 校验 path / schema / secret / build
  ↓
创建 branch / PR
  ↓
GitHub Actions site-check required check
  ↓
Greptile / GitHub Review Agent review PR
  ↓
review-monitor-worker 监听 Review Agent comments
  ↓
blocking comment 触发下一轮 workflow_dispatch 修复
用户在 Slack 里继续调整设计时，也通过 active SlackSession / IssueLink 触发同一条 fix 通路
  ↓
site-check / pages-site-policy / Review Agent gate 通过
  ↓
preview deploy workflow
  ↓
Slack / issue / PR 回写
```

## 跑在哪

### 常驻组件

仍然跑在 `pages-manager` 平台侧，MVP 用本地 K8s `pages-system` namespace 承载：

```text
pages-gateway
slack-agent
pages-worker
project-indexer
review-monitor-worker
slack-notifier
database
redis / queue
```

如果前期连平台服务也想轻量化，可以先把 `pages-worker` 合并进 gateway 进程，但 gateway 仍然是控制面，不直接执行编码和构建。

### 执行组件

前期跑在 GitHub Actions runner：

```text
.github/workflows/project-index.yml
  项目索引 / agent context bundle

.github/workflows/pages-agent.yml
  coding agent 编码
  path allowlist
  schema check
  lint / test / build
  branch / PR

.github/workflows/site-check.yml
  PR required check

.github/workflows/pages-preview.yml
  preview deploy

.github/workflows/pages-production-deploy.yml
  后续 production deploy
```

MVP 默认使用 GitHub-hosted runner，也就是 workflow 中的：

```text
runs-on: ubuntu-latest
```

GitHub Settings 里的 self-hosted runner 不需要先创建。只有在公司禁用 GitHub-hosted runner、需要访问内网资源、需要固定特殊系统依赖，或者需要自管成本和隔离时，才需要创建 self-hosted runner。

平台设计不依赖本地 GitLab runner，也不把 self-hosted runner 作为第一阶段前置条件。

## Workflow 拆分

### 1. `project-index.yml`

由 repo 变更或 gateway 触发：

```text
workflow_dispatch
repository_dispatch
push on main / templates / page-kit
```

职责：

- checkout 精确 base SHA。
- 扫描目标 `sites/<employee>/<site>`、`templates/**`、`packages/page-kit/**`。
- 整理相关 issue、PR、ReviewAgentComment 和构建报告。
- 生成 `ProjectIndexSnapshot` 和 agent context bundle。
- callback gateway，绑定到当前 `PublishingJob`。

不能做：

- 创建 PR。
- push branch。
- 合并 PR。
- 发布 preview 或 production。
- 读取 Slack bot token 或 Cloudflare token。

### 2. `pages-agent.yml`

由 gateway 触发：

```text
workflow_dispatch
repository_dispatch
```

输入：

```json
{
  "publishingJobId": "job_xxx",
  "issueNumber": 123,
  "employeeSlug": "zhangsan",
  "siteSlug": "q2-report",
  "allowedPath": "sites/zhangsan/q2-report",
  "mode": "initial | fix",
  "reviewAgentCommentIds": []
}
```

职责：

- checkout 默认分支。
- 读取 issue 和 gateway job context。
- 如果是 fix，先 checkout 已存在的 PR branch，再读取 open blocking `ReviewAgentComment` 或 Slack follow-up summary。
- 运行 coding agent。
- 生成 patch。
- 校验 patch 只修改目标站点目录。
- 运行 `site.json` schema / secret scan / 文件大小检查。
- 运行 lint / test / build。
- 创建受控 branch。
- 创建或更新 PR。
- callback gateway 写入 workflow run id、branch、PR URL、build result。`initial` 返回 `stageResult=pr_created`，`fix` 返回 `stageResult=reviewing`。

不能做：

- 合并 PR。
- 发布 production。
- 读取 Slack bot token。
- 读取 Cloudflare production token。
- 修改 `.github/**`、`apps/**`、`packages/**`、`templates/**`、`k8s/**`。

### 3. `site-check.yml`

PR required check。

触发：

```text
pull_request
```

职责：

- path allowlist。
- `pages-site-policy`。
- schema / lint / test / build。
- secret scan。
- 文件大小和禁止目录。
- build artifact 不入库检查。

注意：

- `site-check` 不读取 production secret。
- 不使用带 production secret 的 `pull_request_target` 执行 PR 代码。
- 即使 `pages-agent.yml` 已经 build 过，PR 上仍必须重新跑 `site-check`。

### 4. `pages-preview.yml`

`site-check` / `pages-site-policy` 和 Review Agent gate 都通过后生成 preview，不能只因为 PR 已创建就提前发布。

职责：

- 从 PR head SHA 构建 preview artifact。
- 发布到 preview 环境。
- 回写 preview URL 到 PR / issue / Slack。

限制：

- preview token 与 production token 分离。
- preview URL 可设置 TTL。
- preview 失败不应该直接阻塞人工查看 PR，但必须标记 job event。

### 5. `pages-production-deploy.yml`

第一优先级可以先不实现 production deploy。它属于 Preview 闭环跑通后的下一阶段。

PR merge 后触发，或由 gateway/deployer 触发。

职责：

- 只从已记录的 `merge_commit_sha` 构建 production artifact。
- 上传 assets / manifest。
- 更新 Cloudflare resource pool。
- 写 `DeployRecord`。
- 回写 Slack / issue / PR。

限制：

- 不能从 floating branch 构建。
- 不能被普通 PR workflow 直接触发。
- production secret 只进入 production deploy workflow 或后续受控 deployer job。

## Greptile / Review Agent

图里提到的 Greptile 可以作为 GitHub Review Agent 接入。

平台不需要把 Greptile 逻辑写进 coding agent。它应该被当成 PR 外部 reviewer：

```text
PR created / updated
  ↓
Greptile review
  ↓
GitHub PR comments / review comments / check output
  ↓
GitHub webhook
  ↓
pages-gateway
  ↓
review-monitor-worker
  ↓
ReviewAgentComment
```

配置：

```text
GITHUB_REVIEW_AGENT_ALLOWLIST:
  - greptile bot login
  - greptile app slug
  - greptile check run name
  - codex connector login: `chatgpt-codex-connector` / `chatgpt-codex-connector[bot]`
```

只有 allowlist 命中的 Greptile / Review Agent comment 才能触发自动修复。其他评论只能作为人工评论或普通信息。

## 并发模型

GitHub Actions 可以同时处理多个需求，但必须加平台级并发控制。

建议：

```text
一个 PublishingJob = 一个 issue = 一个 PR branch
```

branch：

```text
sites/job-<jobId>-<employeeSlug>-<siteSlug>
```

本地 / staging smoke 可以临时使用固定 PR branch，避免重复 Slack 测试不断创建 PR：

```text
PAGES_PR_MODE=smoke_single
PAGES_SMOKE_PR_BRANCH=sites/smoke-local-slack-smoke-profile
```

这个模式只影响 worker 传给 `pages-agent.yml` 的 branch override。正式需求仍然使用 job-scoped branch；Review Agent comment、preview gate 和 Slack 回通仍然通过 gateway webhook 状态机推进。

concurrency group：

```text
pages-site-${employeeSlug}-${siteSlug}
```

规则：

- 不同员工 / 不同站点可以并发。
- 同一个 `SiteProject` 默认串行，避免两个 agent 同时改同一目录。
- 同一个 job 的 fix round 复用同一个 PR branch。
- 如果多个 Slack 需求指向同一个站点，gateway 要么排队，要么要求用户确认合并需求。
- workflow run 超时后由 gateway 标记 stage failed，并允许 retry。

## 权限和 Secret

Actions-first 更要注意 secret 分层，因为 runner 运行在 GitHub Actions 环境里。

| Workflow | 可用 secret | 禁止 secret |
| --- | --- | --- |
| `project-index.yml` | job callback token、只读 repo token 或默认 checkout 权限 | Slack bot token、Cloudflare token、auto-merge token |
| `pages-agent.yml` | `PAGES_GITHUB_APP_TOKEN`、`AGENT_CODE_API_KEY`、`PAGES_CALLBACK_TOKEN` | Slack bot token、Cloudflare production token、auto-merge token |
| `site-check.yml` | 无敏感 secret | Slack bot token、Cloudflare token、GitHub App private key、auto-merge token |
| `pages-preview.yml` | preview deploy token | production deploy token、auto-merge token |
| `pages-production-deploy.yml` | production deploy token、deploy callback token | Slack bot token、agent model token |

`pages-agent.yml` 里即使持有 GitHub App token，也必须先做 diff validator：

```text
patch
  ↓
path allowlist
  ↓
schema / secret / size check
  ↓
才允许 commit / push / PR
```

GitHub App `Contents: write` 是 repo 级能力，不是 path-scoped token。路径隔离不能依赖 token 本身。

## Preview 优先，不自动上线

前期建议：

```text
approvalMode = manual-required
```

也就是：

- agent 可以自动编码。
- Greptile / Review Agent 可以自动 review。
- blocking comment 可以自动触发修复。
- 可以自动生成 preview。
- 不自动发布 production。
- production merge / deploy 需要人工确认，或者至少由受控 deploy workflow 从 `merge_commit_sha` 触发。

同事提到“全自动有风险，最好不要自动发布到线上”是对的。MVP 应该先把 preview 做好，再逐步开放 `trusted-auto`。

## 与 K8s 方案的关系

Actions-first 是 MVP 执行层简化：

| 能力 | Actions-first MVP | K8s 长期形态 |
| --- | --- | --- |
| coding agent | GitHub Actions runner | K8s `coding-agent-runner` Job |
| builder | GitHub Actions / workflow job | K8s `page-builder` Job |
| site-check | GitHub required check | GitHub required check + K8s precheck |
| preview | GitHub Actions workflow | K8s deployer job 或 Actions |
| production deploy | 受控 GitHub Actions workflow | K8s deployer job |
| job isolation | GitHub runner isolation | namespace / RBAC / Secret / PVC |
| queue / lease | gateway + GitHub workflow run status | gateway + Redis/BullMQ + K8s Job |
| scaling | GitHub Actions concurrency quota | K8s cluster resources |

未来迁移到 K8s 时，保持上层状态机不变：

```text
PublishingJob
JobStage
JobStageAttempt
AgentRun
ReviewAgentComment
DeployRecord
```

只把 stage executor 从 GitHub Actions adapter 换成 K8s Job adapter。

## 推荐结论

前期可以采用 Actions-first：

```text
Slack + gateway + GitHub issue/PR + GitHub Actions coding workflow + Greptile review + preview
```

但是必须保留这些边界：

- issue / PR 仍在 `pages-manager` repo。
- gateway 仍是权限和状态真相源。
- coding workflow 只允许改目标 `sites/<employee>/<site>/`。
- `site-check` 是 required check。
- Greptile comments 进入 `ReviewAgentComment`。
- preview 优先，production 不默认自动发布。
- 后续能无痛替换为 K8s Job executor。
