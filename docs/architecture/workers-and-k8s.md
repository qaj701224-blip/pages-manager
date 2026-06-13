# Workers And Runtime Executors

## Worker 定位

worker 是自动化助手，不是 K8s worker node，也不是最终运行员工网站的容器。

MVP 可以先实现一个 `pages-worker`，后续拆分：

```text
pages-worker
  推进主状态机：issue → project index → coding agent → patch → PR → Review Agent comments → fix → preview deploy

slack-agent
  聚合 Slack thread，加载 session / memory / issue link，生成结构化需求和续接判断

review-monitor-worker
  实时消费 GitHub webhook 中的 Review Agent comment，写入 ReviewAgentComment，并判断是否触发修复或人工处理

project-indexer
  生成 repo / site / template / review 上下文索引，供 coding agent 使用

browser-worker
  执行需要浏览器的任务：截图、视觉检查、需要登录态的网页操作
```

worker 适合执行短调度任务和调用外部 API。耗时、隔离要求高或需要完整 workspace 的任务交给独立 executor。

MVP 运行时采用两层：

```text
pages-system namespace
  跑 gateway / slack-connector / slack-agent / pages-worker 等常驻控制面

GitHub Actions runner
  跑 project-index / pages-agent / site-check / pages-preview 等一次性 executor
```

这个模式见 [local-k8s-control-plane.md](./local-k8s-control-plane.md) 和 [github-actions-first-runtime.md](./github-actions-first-runtime.md)。后续迁移到 K8s Job executor 时，上层状态机保持一致，只是 executor adapter 不同。

## Executor 职责

executor 负责真正运行一次性的发布任务：

- clone 员工网站仓库
- 生成项目索引和 agent context bundle
- 生成候选文件或 patch
- 运行 coding agent，根据结构化需求生成页面代码
- 安装依赖
- lint / test / build
- 生成截图和 preview
- 运行确定性 site-check
- 校验 patch 只修改目标站点目录
- 由受控 committer 提交 commit / push branch
- 创建或更新 PR
- 根据 gateway 下发的 ReviewAgentComment 修复
- Review gate 通过后部署 Preview
- 后续 production 阶段从 merge_commit_sha 部署

MVP 默认常驻控制面跑在本地 K8s，默认 executor 是 GitHub Actions runner。后续需要更强隔离时，executor 可以替换为 K8s Job container。

最终网站不跑在 GitHub Actions 或 K8s，最终网站跑在 Cloudflare Workers / assets。

## Coding Agent 跑在哪

coding agent 不跑在 gateway、worker、Slack bot、GitHub Review Agent 或员工最终网站里。

MVP 前期不使用 K8s Job executor 时，coding agent 跑在 GitHub Actions runner：

```text
pages-gateway
  ↓
workflow_dispatch / repository_dispatch
  ↓
.github/workflows/pages-agent.yml
  ↓
GitHub Actions runner
```

后续使用 K8s executor 时，coding agent 跑在 `pages-manager` 自己创建的 K8s Job container 里。

K8s 共享 namespace 形态：

```text
namespace: pages-jobs
  └─ Job job-<jobId>-coding-agent
       └─ container: coding-agent-runner
```

长期强隔离形态：

```text
namespace: page-job-<jobId>
  ├─ PVC workspace
  ├─ ConfigMap job-context
  ├─ Secret job-callback-nonce
  ├─ Secret git-read-token
  └─ Job coding-agent-runner
```

它不跑在：

- Slack App / Slack bot 里。
- `pages-gateway` 主进程里。
- `pages-worker` 常驻进程里。
- GitHub Review Agent 里。
- Cloudflare Worker 里。
- 员工最终网站运行环境里。

`pages-gateway` 只负责触发 executor、写入 job context、接收 callback 和推进状态机。`pages-worker` 只负责调度。真正消耗时间、clone repo、调用模型、生成代码、写 patch 的动作在 GitHub Actions runner 或 `coding-agent-runner` 容器内完成。

coding agent 的运行时边界：

| 能做 | 不能做 |
| --- | --- |
| clone 目标 repo 的只读内容 | 直接 push branch |
| 读取 issue、Slack 摘要、site context | 直接创建 PR |
| 读取 open blocking `ReviewAgentComment` | 直接合并 PR |
| 调用受控模型 / coding runtime | 直接发 Slack 消息 |
| 在 workspace 里生成文件和 patch | 读取 Slack bot token |
| callback gateway 报告结果 | 读取 Cloudflare deploy token |

coding agent 只产出：

```text
workspace/generated/
workspace/patches/site.patch
workspace/report.json
```

之后由 `controlled-committer` 校验 patch 并负责 Git 写入。这样即使 coding agent 生成了越界改动，也只能停在 workspace，不能修改平台代码、GitHub Actions、K8s manifest 或部署配置。

## Code 更新和编译跑在哪

代码更新和编译分三段：

Actions-first MVP：

```text
pages-agent workflow
  运行 coding agent，生成 candidate patch
  ↓
pages-agent workflow
  path allowlist / schema / secret scan / lint / test / build
  ↓
pages-agent workflow controlled commit step
  校验 patch 并创建 branch / PR
  ↓
GitHub Actions site-check
  在 PR 上重复跑 required check
  ↓
pages-preview workflow
  Review gate 通过后从 PR head SHA 构建 preview artifact 并部署

pages-production-deploy workflow
  后续从 merge_commit_sha 构建 production artifact 并部署
```

K8s executor 形态：

```text
coding-agent-runner
  生成 candidate patch
  ↓
page-builder / page-site-check
  在 K8s job workspace 里安装依赖、lint、test、build
  ↓
controlled-committer
  校验 patch 并创建 branch / PR
  ↓
GitHub Actions site-check
  在 PR 上重复跑 required check
  ↓
page-deployer
  第一优先级部署 preview；后续 PR merge 后从 merge_commit_sha 构建 production artifact 并部署
```

### 1. 候选 patch 预构建

coding agent 生成 patch 后，先由当前 executor 编译候选代码。

Actions-first MVP 中，这一步在 `pages-agent.yml` workflow 内完成。

K8s executor 中，这一步由 builder / site-check job 在同一个 job workspace 中完成：

```text
namespace: pages-jobs
  ├─ PVC job-<jobId>-workspace
  ├─ Job job-<jobId>-coding-agent
  └─ Job job-<jobId>-builder
```

builder 可以做：

- 安装站点依赖。
- 运行 lint / test / build。
- 校验 `site.json`。
- 生成 preview 所需的临时 artifact。
- 生成 screenshot / link check 输入。
- 输出 `workspace/report.json` 或 build report。

builder 不能做：

- push branch。
- 创建 PR。
- 合并 PR。
- 读取 Slack bot token。
- 读取 Cloudflare production deploy token。

### 2. PR required check

controlled-committer 创建 PR 后，GitHub Actions 仍然必须跑 `site-check`：

```text
GitHub Enterprise PR
  ↓
site-check
pages-site-policy
```

这一步是 GitHub Rulesets 里的 required check。它要重复验证：

- PR 只改目标 `sites/<employee>/<site>/`。
- schema / lint / test / build 通过。
- 没有 secret。
- 没有构建产物入库。
- 没有平台、模板、K8s、Actions 改动。

不能只信任 agent workflow 或 K8s builder 的预构建结果，因为 PR 分支才是 GitHub merge 前的实际审查对象。

### 3. Production 构建

PR merge 后，production 构建可以先跑在受控 GitHub Actions production deploy workflow 中：

```text
pages-production-deploy
  checkout merge_commit_sha
  install deps
  build production artifact
  upload assets / manifest
  update Cloudflare resource pool
```

后续 K8s executor 中，这一步可以切到 deployer K8s Job：

```text
page-deployer
  checkout merge_commit_sha
  install deps
  build production artifact
  upload assets / manifest
  update Cloudflare resource pool
```

production 只能从已记录的 `merge_commit_sha` 构建，不能从 agent workspace、PR floating branch 或用户传入 branch 构建。

## K8s Namespace 拓扑

MVP 先启用系统 namespace 跑常驻控制面。Actions-first executor 不需要 `pages-jobs`，但状态模型和权限边界要按同样方式预留。

系统 namespace：

```text
namespace: pages-system
  ├─ pages-frontend
  ├─ pages-gateway
  ├─ slack-connector
  ├─ pages-worker
  ├─ project-indexer
  ├─ slack-agent
  ├─ review-monitor-worker
  ├─ browser-worker
  ├─ mysql
  ├─ redis
  └─ shared platform secrets
```

强隔离目标形态后续再启用：

```text
namespace: page-job-<jobId>
  ├─ Job coding-agent-runner
  ├─ Job page-builder
  ├─ Job page-site-check
  ├─ Job controlled-committer
  ├─ Job page-deployer
  ├─ PVC workspace
  ├─ Secret job-callback-nonce
  ├─ Secret git-read-token
  ├─ Secret github-app-installation-token # only for controlled-committer
  ├─ Secret deploy-token                # only for deployer
  └─ ConfigMap job-context
```

K8s executor 初期可先使用共享 namespace：

```text
namespace: pages-jobs
  ├─ Job job-<jobId>-coding-agent
  ├─ Job job-<jobId>-builder
  ├─ Job job-<jobId>-site-check
  ├─ Job job-<jobId>-controlled-committer
  ├─ Job job-<jobId>-deployer
  ├─ PVC job-<jobId>-workspace
  └─ ConfigMap job-<jobId>-context
```

## K8s Labels

K8s label 只关联业务 ID，不表达业务规则：

```text
pages.xd.com/job-id=<jobId>
pages.xd.com/owner-scope-id=<scopeId>
pages.xd.com/employee-id=<employeeId>
pages.xd.com/site-project-id=<siteProjectId>
pages.xd.com/site-slug=<siteSlug>
pages.xd.com/task-type=coding-agent|builder|site-check|controlled-committer|deployer
pages.xd.com/managed-by=pages-gateway
```

## Callback 和 Retry

retry 必须生成新的 `JobStageAttempt`。

规则：

- gateway 创建任务时生成当前 `attempt_id` 和一次性 callback nonce。
- worker / executor callback 必须携带 `attempt_id`。
- gateway 只接受当前有效 attempt 的 callback。
- 旧 attempt 的迟到 callback 只能写审计日志，不能覆盖当前状态。

## 任务凭据拆分

| 任务类型 | 允许的凭据 | 禁止的凭据 |
| --- | --- | --- |
| coding-agent | repo read、workspace write、ReviewAgentComment read、job callback nonce | repo push token、Slack bot token、Cloudflare token、auto-merge token |
| builder | repo read、job callback nonce | repo write、Slack bot token、Cloudflare token、auto-merge token |
| site-check | repo read、workspace read、job callback nonce | repo write、Slack bot token、Cloudflare token、auto-merge token |
| controlled-committer | GitHub App installation token、repo write 到受控分支、job callback nonce | Slack bot token、Cloudflare token、auto-merge token、production deploy secret |
| review-monitor | GitHub webhook payload、repo/PR read、review comment read、internal worker auth | repo write、Cloudflare token、auto-merge token、Slack bot token |
| merger | PR merge token、job callback nonce | Cloudflare token、Slack bot token |
| deployer | Cloudflare deploy token、repo read 当前 merge SHA、job callback nonce | repo write、auto-merge token、Slack bot token |
| slack-notifier | Slack bot token、job status read | repo write、Cloudflare token、auto-merge token |

## 站点内容提交边界

coding agent 不直接 push 到远端分支。它只在 job workspace 中生成候选文件或 patch：

```text
workspace/generated/
workspace/patches/site.patch
workspace/report.json
```

之后由 gateway 或受控 committer 任务执行：

```text
校验 patch 只修改 sites/<employee-slug>/<site-slug>/
  ↓
校验 site.json schema / 文件大小 / 禁止路径
  ↓
创建或更新分支
  ↓
提交 commit
  ↓
创建或更新 PR
```

规则：

- coding agent 不能直接写 `.github/`、`apps/`、`packages/`、`templates/`、`k8s/`。
- coding agent 不能持有可 push 任意路径的 token。
- 只有通过 path allowlist 校验的 patch 才能进入 PR。
- 任何越界 patch 必须标记 job failed，并写入审计。
